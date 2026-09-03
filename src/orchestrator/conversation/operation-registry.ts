import { ConversationAuthorityClosedError } from "./lifecycle-gate.js";
import { reserveOperationCancellation } from "./operation-cancellation-reservation.js";
import {
  type OperationOwnerState,
  brokeredOperation,
  operationBrokerKey,
  readOperationOwnerState,
  registerBrokeredOperation,
  releaseBrokeredOperation,
} from "./operation-owner-broker.js";
import type {
  CancelReservation,
  OperationEntry,
  OperationRegistryOptions,
  OperationTombstone,
  RegisteredOperation,
  SettledLifecycle,
  TransitionLifecycle,
} from "./operation-registry-types.js";
import { archiveLocalOperation } from "./operation-tombstone-state.js";
import { registeredOperation } from "./registered-operation.js";
export type {
  CancelReservation,
  OperationRegistryOptions,
  RegisteredOperation,
} from "./operation-registry-types.js";
export class OperationTransitionReservedError extends ConversationAuthorityClosedError {}
export type { OperationOwnerState } from "./operation-owner-broker.js";

/** Runtime-owned controller/attempt registry. Cancellation is two-phase so journaling wins. */
export const OperationRegistry = class OperationRegistry {
  private readonly operations = new Map<string, OperationEntry>();
  private readonly tombstones = new Map<string, OperationTombstone>();
  private readonly tombstoneLimit: number;
  private readonly authority?: OperationRegistryOptions["authority"];
  private readonly onCancelled?: (conversationId: string, operationId: string) => void;
  private readonly onSettled?: OperationRegistryOptions["onSettled"];
  private readonly onTransitionPrepare?: OperationRegistryOptions["onTransitionPrepare"];
  private readonly onTransitionAdopt?: OperationRegistryOptions["onTransitionAdopt"];
  private readonly onEpochAdopt?: OperationRegistryOptions["onEpochAdopt"];
  private readonly onTransitionReject?: OperationRegistryOptions["onTransitionReject"];
  private readonly onCancelPrepare?: OperationRegistryOptions["onCancelPrepare"];
  private readonly onCancelRollback?: OperationRegistryOptions["onCancelRollback"];

  constructor(options: OperationRegistryOptions = {}) {
    const limit = options.tombstoneLimit ?? 1024;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("tombstoneLimit must be a positive safe integer");
    }
    this.tombstoneLimit = limit;
    this.authority = options.authority;
    this.onCancelled = options.onCancelled;
    this.onSettled = options.onSettled;
    this.onTransitionPrepare = options.onTransitionPrepare;
    this.onTransitionAdopt = options.onTransitionAdopt;
    this.onEpochAdopt = options.onEpochAdopt;
    this.onTransitionReject = options.onTransitionReject;
    this.onCancelPrepare = options.onCancelPrepare;
    this.onCancelRollback = options.onCancelRollback;
  }

  private archive(entry: OperationEntry, state: OperationTombstone["state"]): void {
    releaseBrokeredOperation(entry);
    for (const member of entry.members) member.archiveLocal(entry, state);
    entry.members.clear();
  }

  private archiveLocal(entry: OperationEntry, state: OperationTombstone["state"]): void {
    archiveLocalOperation(this.operations, this.tombstones, this.tombstoneLimit, entry, state);
  }

  private terminateEntry(
    entry: OperationEntry,
    state: OperationTombstone["state"],
    reason?: string,
    lifecycle?: SettledLifecycle,
  ): Promise<void> {
    if (entry.termination) return entry.termination;
    const attempts = [...entry.attempts];
    entry.attempts.clear();
    let resolve!: () => void;
    entry.termination = new Promise<void>((done) => {
      resolve = done;
    });
    if (entry.cancelReserved) {
      entry.cancelReserved = false;
      for (const member of entry.members) {
        member.onCancelRollback?.(entry.conversationId, entry.operationId);
      }
    }
    entry.state = state === "cancelled" ? "cancelled" : "settling";
    if (state === "cancelled") {
      for (const member of entry.members) {
        try {
          member.onCancelled?.(entry.conversationId, entry.operationId);
        } catch (error) {
          void error;
        }
      }
    } else {
      for (const member of entry.members) {
        try {
          member.onSettled?.(entry.conversationId, entry.operationId, lifecycle);
        } catch (error) {
          void error;
        }
      }
    }
    entry.controller.abort(reason);
    void (async () => {
      await Promise.allSettled(attempts.map((attempt) => attempt.terminate(reason)));
      await Promise.allSettled(attempts.map((attempt) => attempt.completion));
      await this.drain(entry);
      entry.state = state;
      this.archive(entry, state);
      resolve();
    })();
    return entry.termination;
  }

  private abortEntry(entry: OperationEntry, reason?: string): Promise<void> {
    if (entry.termination) return entry.termination;
    if (entry.state !== "live") return Promise.resolve();
    return this.terminateEntry(entry, "cancelled", reason);
  }

  private releaseEntry(entry: OperationEntry, reason?: string): Promise<void> {
    if (entry.termination) return entry.termination;
    const attempts = [...entry.attempts];
    entry.attempts.clear();
    entry.state = "settling";
    entry.controller.abort(reason);
    entry.termination = (async () => {
      await Promise.allSettled(attempts.map((attempt) => attempt.terminate(reason)));
      await Promise.allSettled(attempts.map((attempt) => attempt.completion));
      await this.drain(entry);
      entry.state = "settled";
      releaseBrokeredOperation(entry);
      for (const member of entry.members) {
        if (member.operations.get(entry.operationId) === entry) {
          member.operations.delete(entry.operationId);
        }
      }
      entry.members.clear();
    })();
    return entry.termination;
  }

  private async drain(entry: OperationEntry): Promise<void> {
    while (entry.effects.size) await Promise.allSettled([...entry.effects]);
  }

  private registered(entry: OperationEntry): RegisteredOperation {
    return registeredOperation(entry, () => this.drain(entry));
  }

  create(
    conversationId: string,
    operationId: string,
    allowCancelReservation = false,
  ): RegisteredOperation {
    if (!conversationId || !operationId) throw new Error("operation identity is required");
    if (this.operations.has(operationId) || this.tombstones.has(operationId)) {
      throw new Error("operation already exists");
    }
    const brokerKey = operationBrokerKey(this.authority, operationId);
    const shared = brokeredOperation(brokerKey);
    if (shared) {
      if (shared.conversationId !== conversationId) throw new Error("operation already exists");
      if (shared.transitionReservation || (shared.cancelReserved && !allowCancelReservation)) {
        throw new OperationTransitionReservedError("operation authority is changing");
      }
      shared.members.add(this);
      this.operations.set(operationId, shared);
      return this.registered(shared);
    }
    const cancelled = this.authority?.isCancellationClaimed(conversationId, operationId) ?? false;
    const controller = new AbortController();
    if (cancelled) controller.abort("operation already cancelled");
    const entry: OperationEntry = {
      conversationId,
      operationId,
      controller,
      attempts: new Set(),
      effects: new Set(),
      brokerKey,
      members: new Set([this]),
      state: cancelled ? "cancelled" : "live",
      cancelReserved: false,
      transitionReservation: null,
    };
    this.operations.set(operationId, entry);
    registerBrokeredOperation(brokerKey, entry);
    return this.registered(entry);
  }

  get(conversationId: string, operationId: string): RegisteredOperation | null {
    const entry = this.operations.get(operationId);
    if (!entry || entry.conversationId !== conversationId) return null;
    return this.registered(entry);
  }

  ownerState(conversationId: string, operationId: string): OperationOwnerState {
    return readOperationOwnerState({
      local: this.operations.get(operationId),
      authority: this.authority,
      conversationId,
      operationId,
    });
  }

  private transitionMembers(entry: OperationEntry): OperationRegistry[] {
    return [this, ...[...entry.members].filter((member) => member !== this)];
  }

  private rejectTransition(
    members: readonly OperationRegistry[],
    entry: OperationEntry,
    lifecycle: TransitionLifecycle,
    error: unknown,
  ): void {
    for (const member of members) {
      member.onTransitionReject?.(entry.conversationId, entry.operationId, lifecycle, error);
    }
  }

  adoptTransition(
    conversationId: string,
    operationId: string,
    lifecycle: TransitionLifecycle,
    epoch: number,
  ): void {
    const entry = this.operations.get(operationId);
    if (!entry || entry.conversationId !== conversationId) return;
    for (const member of entry.members) {
      member.onTransitionAdopt?.(conversationId, operationId, lifecycle, epoch);
    }
  }

  adoptEpoch(conversationId: string, operationId: string, epoch: number): void {
    const entry = this.operations.get(operationId);
    if (!entry || entry.conversationId !== conversationId) return;
    for (const member of entry.members) member.onEpochAdopt?.(conversationId, operationId, epoch);
  }

  prepareJoinedCancellation(conversationId: string, operationId: string): void {
    const entry = this.operations.get(operationId);
    if (!entry || entry.conversationId !== conversationId || !entry.cancelReserved) return;
    void this.onCancelPrepare?.(conversationId, operationId).catch(() => undefined);
  }

  async mutateState(
    conversationId: string,
    operationId: string,
    epoch: number,
    append: () => Promise<void>,
  ): Promise<void> {
    const entry = this.operations.get(operationId);
    if (!entry || entry.conversationId !== conversationId) {
      throw new Error("operation authority missing");
    }
    if (entry.transitionReservation || entry.cancelReserved) {
      throw new OperationTransitionReservedError("conversation state authority is changing");
    }
    const reservation = Symbol("operation state mutation");
    entry.transitionReservation = reservation;
    try {
      await append();
    } finally {
      if (entry.transitionReservation === reservation) entry.transitionReservation = null;
    }
    this.adoptEpoch(conversationId, operationId, epoch);
  }

  async transition(
    conversationId: string,
    operationId: string,
    lifecycle: TransitionLifecycle,
    epoch: number,
    append: () => Promise<void>,
  ): Promise<void> {
    const entry = this.operations.get(operationId);
    if (!entry || entry.conversationId !== conversationId) {
      throw new Error("operation authority missing");
    }
    if (entry.transitionReservation || entry.cancelReserved) {
      throw new OperationTransitionReservedError("conversation transition authority missing");
    }
    const reservation = Symbol("operation transition");
    entry.transitionReservation = reservation;
    const members = this.transitionMembers(entry);
    const prepared: OperationRegistry[] = [];
    const drains: Promise<void>[] = [];
    try {
      for (const member of members) {
        drains.push(
          member.onTransitionPrepare?.(conversationId, operationId, lifecycle) ?? Promise.resolve(),
        );
        prepared.push(member);
      }
    } catch (error) {
      if (entry.transitionReservation === reservation) entry.transitionReservation = null;
      this.rejectTransition(prepared, entry, lifecycle, error);
      throw error;
    }
    try {
      await Promise.all([...drains, this.drain(entry)]);
      await append();
    } catch (error) {
      if (entry.transitionReservation === reservation) entry.transitionReservation = null;
      this.rejectTransition(prepared, entry, lifecycle, error);
      throw error;
    }
    if (entry.transitionReservation === reservation) entry.transitionReservation = null;
    for (const member of entry.members) {
      member.onTransitionAdopt?.(conversationId, operationId, lifecycle, epoch);
    }
  }

  async settleAndTerminate(
    conversationId: string,
    operationId: string,
    reason?: string,
    lifecycle?: SettledLifecycle,
  ): Promise<void> {
    const entry = this.operations.get(operationId);
    if (!entry || entry.conversationId !== conversationId) return;
    if (entry.termination) return entry.termination;
    if (entry.state === "cancelled") {
      this.archive(entry, "cancelled");
      return;
    }
    if (entry.state !== "live") return;
    return this.terminateEntry(entry, "settled", reason, lifecycle);
  }

  async release(conversationId: string, operationId: string, reason?: string): Promise<void> {
    const entry = this.operations.get(operationId);
    if (!entry || entry.conversationId !== conversationId) return;
    if (entry.members.size <= 1) return this.releaseEntry(entry, reason);
    entry.members.delete(this);
    if (this.operations.get(operationId) === entry) this.operations.delete(operationId);
  }

  reserveCancel(conversationId: string, operationId: string): CancelReservation {
    const entry = this.operations.get(operationId);
    if (!entry) {
      const tombstone = this.tombstones.get(operationId);
      if (!tombstone) return { status: "not_found" };
      if (tombstone.conversationId !== conversationId) {
        return { status: "conversation_mismatch" };
      }
      return { status: "not_cancellable" };
    }
    if (entry.conversationId !== conversationId) return { status: "conversation_mismatch" };
    if (entry.state !== "live" || entry.cancelReserved || entry.transitionReservation) {
      return { status: "not_cancellable" };
    }
    if (this.authority?.isCancellationClaimed(conversationId, operationId)) {
      return { status: "not_cancellable" };
    }
    return reserveOperationCancellation({
      entry,
      authority: this.authority,
      prepare: (member) =>
        member.onCancelPrepare?.(conversationId, operationId) ?? Promise.resolve(),
      rollback: (member) => member.onCancelRollback?.(conversationId, operationId),
      drain: () => this.drain(entry),
      abort: (reason) => this.abortEntry(entry, reason),
    });
  }

  async stopConversation(conversationId: string, reason?: string): Promise<void> {
    const entries = [...this.operations.values()].filter(
      (entry) => entry.conversationId === conversationId && entry.state === "live",
    );
    await Promise.all(entries.map((entry) => this.abortEntry(entry, reason)));
  }

  hasAmbiguous(conversationId: string): boolean {
    return [...this.operations.values()].some(
      (entry) => entry.conversationId === conversationId && entry.cancelReserved,
    );
  }

  isCancelled(conversationId: string, operationId: string): boolean {
    const active = this.operations.get(operationId);
    if (active && active.conversationId !== conversationId) return false;
    if (active?.state === "cancelled") return true;
    const settled = this.tombstones.get(operationId);
    if (settled?.conversationId === conversationId && settled.state === "cancelled") return true;
    return this.authority?.isCancellationClaimed(conversationId, operationId) ?? false;
  }
};

export type OperationRegistry = InstanceType<typeof OperationRegistry>;
