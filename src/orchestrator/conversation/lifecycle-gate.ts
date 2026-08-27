import { TraceLifecycleConflictError } from "../trace/lifecycle-cas.js";
import {
  CONVERSATION_TRANSITION_LIFECYCLE,
  type ConversationTransitionLifecycleV1,
} from "./conversation-public-wire-contract.js";
import { ConversationAuthorityClosedError } from "./lifecycle-gate-state.js";
import { ConversationTerminalEmissionGate } from "./lifecycle-terminal-gate.js";
export { ConversationAuthorityClosedError } from "./lifecycle-gate-state.js";
export type { LiveConversation } from "./lifecycle-gate-state.js";

/** Serializes lifecycle ownership and rejects every policy effect after close begins. */
export class ConversationEmissionGate extends ConversationTerminalEmissionGate {
  open(conversationId: string, operationId: string, paused = false): void {
    if (this.entries.has(conversationId)) throw new Error("conversation emission gate exists");
    this.entries.set(conversationId, {
      operationId,
      state: paused ? "paused" : "open",
      terminal: null,
      waiters: new Set(),
    });
  }

  isOpen(conversationId: string, operationId: string): boolean {
    const entry = this.entries.get(conversationId);
    return (
      entry?.operationId === operationId &&
      entry.state === "open" &&
      !this.cancellationClaimed(conversationId, operationId)
    );
  }

  isRetained(conversationId: string, operationId: string): boolean {
    const entry = this.entries.get(conversationId);
    return (
      entry?.operationId === operationId &&
      (entry.state === "open" ||
        entry.state === "pausing" ||
        entry.state === "paused" ||
        entry.state === "resuming" ||
        entry.state === "cancelling") &&
      entry.terminal === null &&
      !this.cancellationClaimed(conversationId, operationId)
    );
  }

  awaitOpen(conversationId: string, operationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (
      !entry ||
      entry.operationId !== operationId ||
      entry.terminal ||
      this.cancellationClaimed(conversationId, operationId)
    ) {
      return Promise.reject(
        new ConversationAuthorityClosedError("conversation emission authority is closed"),
      );
    }
    if (entry.state === "open") return Promise.resolve();
    if (
      entry.state !== "pausing" &&
      entry.state !== "paused" &&
      entry.state !== "resuming" &&
      entry.state !== "cancelling"
    ) {
      return Promise.reject(
        new ConversationAuthorityClosedError("conversation emission authority is closed"),
      );
    }
    return new Promise<void>((resolve, reject) => entry.waiters.add({ resolve, reject }));
  }

  control<T>(
    conversationId: string,
    operationId: string,
    allowPaused: boolean,
    append: () => Promise<T>,
  ): Promise<T> {
    const entry = this.entries.get(conversationId);
    const allowed = entry?.state === "open" || (allowPaused && entry?.state === "paused");
    if (
      !entry ||
      entry.operationId !== operationId ||
      !allowed ||
      entry.terminal ||
      this.cancellationClaimed(conversationId, operationId)
    ) {
      return Promise.reject(
        new ConversationAuthorityClosedError("conversation control authority is closed"),
      );
    }
    const result = (entry.pending ?? Promise.resolve()).then(append);
    this.track(
      entry,
      result.then(() => undefined),
    );
    return result;
  }

  async retain(
    conversationId: string,
    operationId: string,
    cancelled: () => boolean,
  ): Promise<boolean> {
    if (cancelled()) return false;
    try {
      await this.control(conversationId, operationId, true, () => Promise.resolve());
      return !cancelled();
    } catch {
      return false;
    }
  }

  prepareCancellation(conversationId: string, operationId: string): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (
      !entry ||
      entry.operationId !== operationId ||
      (entry.state !== "open" && entry.state !== "paused") ||
      entry.terminal
    ) {
      return Promise.reject(
        new ConversationAuthorityClosedError("conversation cancellation authority is closed"),
      );
    }
    const previous = entry.state;
    entry.state = "cancelling";
    entry.cancellationPrevious = previous;
    return entry.pending ?? Promise.resolve();
  }

  rollbackCancellation(conversationId: string, operationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.operationId !== operationId || !entry.cancellationPrevious) return;
    const previous = entry.cancellationPrevious;
    entry.cancellationPrevious = undefined;
    if (entry.state === "cancelling") entry.state = previous;
    else if (entry.state === "closing") entry.terminalPrevious = previous;
    if (previous === "open") this.resolveWaiters(entry);
  }

  cancel<T>(conversationId: string, operationId: string, append: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.operationId !== operationId) {
      return Promise.reject(
        new ConversationAuthorityClosedError("conversation cancellation authority is closed"),
      );
    }
    let prior: Promise<void>;
    try {
      prior = this.prepareCancellation(conversationId, operationId);
    } catch (error) {
      return Promise.reject(error);
    }
    const result = prior.then(append);
    const pending = result.then(
      () => this.adoptCancellation(conversationId, operationId),
      (error) => {
        this.rollbackCancellation(conversationId, operationId);
        throw error;
      },
    );
    this.track(entry, pending);
    return result;
  }

  adoptCancellation(conversationId: string, operationId: string): void {
    const entry = this.entries.get(conversationId);
    if (
      !entry ||
      entry.operationId !== operationId ||
      entry.state === "closed" ||
      entry.state === "cancelled"
    )
      return;
    this.rejectWaiters(entry);
    if (entry.state === "closing") {
      entry.terminalPrevious = "cancelled";
      entry.cancellationPrevious = undefined;
      return;
    }
    entry.cancellationPrevious = undefined;
    entry.state = "cancelled";
  }

  prepareTransition(
    conversationId: string,
    operationId: string,
    lifecycle: ConversationTransitionLifecycleV1,
  ): Promise<void> {
    const entry = this.entries.get(conversationId);
    const required = lifecycle === CONVERSATION_TRANSITION_LIFECYCLE.PAUSED ? "open" : "paused";
    if (
      !entry ||
      entry.operationId !== operationId ||
      entry.state !== required ||
      entry.terminal ||
      this.cancellationClaimed(conversationId, operationId)
    ) {
      return Promise.reject(
        new ConversationAuthorityClosedError("conversation transition authority missing"),
      );
    }
    const transitional =
      lifecycle === CONVERSATION_TRANSITION_LIFECYCLE.PAUSED ? "pausing" : "resuming";
    entry.state = transitional;
    return entry.pending ?? Promise.resolve();
  }

  adoptTransition(
    conversationId: string,
    operationId: string,
    lifecycle: ConversationTransitionLifecycleV1,
  ): void {
    const entry = this.entries.get(conversationId);
    if (
      !entry ||
      entry.operationId !== operationId ||
      entry.state === "closed" ||
      entry.state === "cancelling" ||
      entry.state === "cancelled"
    )
      return;
    const settled = lifecycle === CONVERSATION_TRANSITION_LIFECYCLE.PAUSED ? "paused" : "open";
    if (entry.state === "closing") entry.terminalPrevious = settled;
    else entry.state = settled;
    if (settled === "open") this.resolveWaiters(entry);
  }

  rejectTransition(
    conversationId: string,
    operationId: string,
    lifecycle: ConversationTransitionLifecycleV1,
    error: unknown,
  ): void {
    const durable = error instanceof TraceLifecycleConflictError ? error.durableLifecycle : null;
    const fallback =
      lifecycle === CONVERSATION_TRANSITION_LIFECYCLE.PAUSED
        ? CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE
        : CONVERSATION_TRANSITION_LIFECYCLE.PAUSED;
    this.adoptTransition(
      conversationId,
      operationId,
      durable === CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE ||
        durable === CONVERSATION_TRANSITION_LIFECYCLE.PAUSED
        ? durable
        : fallback,
    );
  }

  transition(
    conversationId: string,
    operationId: string,
    lifecycle: ConversationTransitionLifecycleV1,
    append: () => Promise<void>,
  ): Promise<void> {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.operationId !== operationId) {
      return Promise.reject(
        new ConversationAuthorityClosedError("conversation transition authority missing"),
      );
    }
    let prior: Promise<void>;
    try {
      prior = this.prepareTransition(conversationId, operationId, lifecycle);
    } catch (error) {
      return Promise.reject(error);
    }
    const pending = prior.then(append).then(
      () => this.adoptTransition(conversationId, operationId, lifecycle),
      (error) => {
        this.rejectTransition(conversationId, operationId, lifecycle, error);
        throw error;
      },
    );
    return this.track(entry, pending);
  }
}
