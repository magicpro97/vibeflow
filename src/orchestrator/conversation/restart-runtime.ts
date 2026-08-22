import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { TraceStore } from "../trace/store.js";
import type { InternalTraceStoreRecord } from "../trace/types.js";
import type { ConversationArtifactStore, PersistedResumeBinding } from "./artifact-store.js";
import { snapshotMaterializedBindings } from "./emission-authority.js";
import { foldConversation } from "./fold.js";
import { ConversationAuthorityClosedError, type LiveConversation } from "./lifecycle-gate.js";
import {
  conversationTransitionEpoch,
  projectConversationEvents,
  rehydrateConversation,
} from "./policy-registry.js";
import { operationOwnsDurableLifecycle, unresolvedApprovalOperation } from "./restart-authority.js";
import type {
  ConversationBinding,
  ConversationHealth,
  ConversationLifecycle,
  ConversationManifest,
  OperationCancelCommand,
  OperationCancelResult,
} from "./types.js";

export class ConversationRestoreOperationMismatchError extends Error {}
class ConversationRestoreTerminalError extends Error {}

interface RestartRuntimeOptions {
  traceStore: TraceStore;
  artifactRegistry: ArtifactRegistry;
  artifactStore: ConversationArtifactStore;
  id(kind: string): string;
  current(id: string): LiveConversation | undefined;
  reconcileActive(live: LiveConversation): Promise<void>;
  begin(
    manifest: ConversationManifest,
    bindings: MaterializedAgentBinding[],
    resumes: readonly PersistedResumeBinding[],
    paused: boolean,
    transitionEpoch: number,
    operationId: string,
    allowCancelReservation?: boolean,
  ): string;
  rehydrateBinding(
    binding: ConversationBinding,
    manifest: ConversationManifest,
  ): Promise<MaterializedAgentBinding>;
}

type ControlState = {
  lifecycle: ConversationLifecycle;
  health: ConversationHealth;
  transitionEpoch: number;
};
export type DurableOperationMembership = "current" | "historical" | "unknown";

const durableLifecycleOperation = (records: readonly InternalTraceStoreRecord[]): string | null => {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const stored = records[index]?.stored_event;
    if (stored?.event.type === "state_change" && !stored.event.payload.terminal) {
      return stored.operation_id;
    }
  }
  return null;
};

export class ConversationRestartRuntime {
  constructor(private readonly options: RestartRuntimeOptions) {}

  private records(id: string) {
    return (
      this.options.traceStore.recoverConversation?.(id) ??
      this.options.traceStore.readConversation(id)
    );
  }

  private stateFromRecords(id: string, records: readonly InternalTraceStoreRecord[]): ControlState {
    const projected = projectConversationEvents(records, id, this.options.artifactRegistry, 0);
    if (!projected.length) return { lifecycle: "INIT", health: "healthy", transitionEpoch: 0 };
    const { lifecycle, health } = foldConversation(projected);
    return { lifecycle, health, transitionEpoch: conversationTransitionEpoch(records) };
  }

  async controlState(id: string): Promise<ControlState | null> {
    if (!this.options.artifactStore.has(id)) return null;
    return this.stateFromRecords(id, await this.records(id));
  }

  async operationMembership(id: string, operationId: string): Promise<DurableOperationMembership> {
    if (!this.options.artifactStore.has(id)) return "unknown";
    const records = await this.records(id);
    if (!records.some(({ stored_event: stored }) => stored.operation_id === operationId)) {
      return "unknown";
    }
    this.options.artifactStore.recordOperation(id, operationId);
    const state = this.stateFromRecords(id, records);
    return state &&
      ["INIT", "ACTIVE", "PAUSED"].includes(state.lifecycle) &&
      operationOwnsDurableLifecycle(records, operationId)
      ? "current"
      : "historical";
  }

  async prepareCancellation(
    command: OperationCancelCommand,
  ): Promise<OperationCancelResult | null> {
    const owner = this.options.artifactStore.operationOwner(command.operation_id);
    if (owner && owner !== command.conversation_id) {
      return { status: 409, body: { code: "operation_conversation_mismatch" } };
    }
    if (
      owner === command.conversation_id &&
      this.options.artifactStore
        .operationAuthority()
        .isCancellationClaimed(command.conversation_id, command.operation_id)
    ) {
      return { status: 409, body: { code: "operation_not_cancellable" } };
    }
    const live = this.options.current(command.conversation_id);
    if (live?.operationId === command.operation_id) return null;
    if (this.options.artifactStore.has(command.conversation_id)) {
      const membership = await this.operationMembership(
        command.conversation_id,
        command.operation_id,
      );
      if (membership === "historical") {
        return { status: 409, body: { code: "operation_not_cancellable" } };
      }
      if (membership === "current") {
        if (live) return { status: 409, body: { code: "operation_not_cancellable" } };
        try {
          await this.restore(command.conversation_id, command.operation_id, true);
        } catch (error) {
          if (
            error instanceof ConversationRestoreOperationMismatchError ||
            error instanceof ConversationRestoreTerminalError ||
            error instanceof ConversationAuthorityClosedError
          ) {
            return { status: 409, body: { code: "operation_not_cancellable" } };
          }
          throw error;
        }
        return null;
      }
    }
    return owner ? { status: 409, body: { code: "operation_not_cancellable" } } : null;
  }

  private async upgrade(id: string, live: LiveConversation): Promise<string> {
    const { record, bindings } = await rehydrateConversation(
      id,
      this.options.artifactStore,
      this.options.rehydrateBinding,
    );
    live.bindings = snapshotMaterializedBindings(bindings);
    live.resumeBindings = new Map(
      record.resume_bindings.map((resume) => [resume.participant_id, resume]),
    );
    live.needsReconcile = true;
    return live.operationId;
  }

  async restore(id: string, requestedOperationId?: string, controlOnly = false): Promise<string> {
    let live = this.options.current(id);
    if (live) {
      if (requestedOperationId && requestedOperationId !== live.operationId) {
        throw new ConversationRestoreOperationMismatchError("durable operation does not match");
      }
      if (!controlOnly && !live.bindings.length) await this.upgrade(id, live);
      if (
        !controlOnly &&
        live.needsReconcile &&
        (await this.controlState(id))?.lifecycle === "ACTIVE"
      ) {
        await this.options.reconcileActive(live);
      }
      return live.operationId;
    }
    const prior = await this.records(id);
    const state = this.stateFromRecords(id, prior);
    if (!["INIT", "ACTIVE", "PAUSED"].includes(state.lifecycle)) {
      throw new ConversationRestoreTerminalError(
        "conversation cannot be restored from terminal state",
      );
    }
    if (requestedOperationId && !operationOwnsDurableLifecycle(prior, requestedOperationId)) {
      throw new ConversationRestoreOperationMismatchError("durable operation does not match");
    }
    const record = this.options.artifactStore.readRecord(id);
    if (!record) throw new Error("conversation not found");
    const bindings = controlOnly
      ? []
      : (await rehydrateConversation(id, this.options.artifactStore, this.options.rehydrateBinding))
          .bindings;
    const operationId =
      requestedOperationId ??
      durableLifecycleOperation(prior) ??
      unresolvedApprovalOperation(prior) ??
      this.options.id("operation");
    this.options.begin(
      record.manifest,
      bindings,
      record.resume_bindings,
      state.lifecycle === "PAUSED",
      conversationTransitionEpoch(prior),
      operationId,
      controlOnly,
    );
    live = this.options.current(id);
    if (!live) throw new Error("conversation resume authority missing");
    live.needsReconcile = !controlOnly;
    if (!controlOnly && state.lifecycle === "ACTIVE") await this.options.reconcileActive(live);
    return live.operationId;
  }
}
