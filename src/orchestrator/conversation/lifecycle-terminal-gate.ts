import {
  CONVERSATION_TERMINAL_LIFECYCLE,
  isConversationGracefulTerminalLifecycle,
} from "./conversation-public-wire-contract.js";
import {
  ConversationAuthorityClosedError,
  type EmissionGateEntry,
} from "./lifecycle-gate-state.js";
import type { TerminalLifecycle } from "./types.js";

/** Shared terminal half of the emission gate; nonterminal lanes extend this authority. */
export class ConversationTerminalEmissionGate {
  protected readonly entries = new Map<string, EmissionGateEntry>();

  constructor(
    protected readonly cancellationClaimed: (
      conversationId: string,
      operationId: string,
    ) => boolean = () => false,
  ) {}

  protected resolveWaiters(entry: EmissionGateEntry): void {
    for (const waiter of entry.waiters) waiter.resolve();
    entry.waiters.clear();
  }

  protected rejectWaiters(entry: EmissionGateEntry): void {
    const error = new ConversationAuthorityClosedError("conversation emission authority is closed");
    for (const waiter of entry.waiters) waiter.reject(error);
    entry.waiters.clear();
  }

  protected track(entry: EmissionGateEntry, pending: Promise<void>): Promise<void> {
    entry.pending = pending;
    void pending.then(
      () => {
        if (entry.pending === pending) entry.pending = undefined;
      },
      () => {
        if (entry.pending === pending) entry.pending = undefined;
      },
    );
    return pending;
  }

  adoptClosure(conversationId: string, operationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.operationId !== operationId || entry.state === "closed") return;
    this.rejectWaiters(entry);
    if (entry.state === "closing") return;
    entry.terminalPrevious =
      entry.state === "cancelled"
        ? "cancelled"
        : entry.state === "paused" || entry.state === "resuming"
          ? "paused"
          : "open";
    entry.state = "closing";
  }

  terminal(
    conversationId: string,
    operationId: string,
    lifecycle: TerminalLifecycle,
    append: (effective: TerminalLifecycle) => Promise<void>,
  ): Promise<TerminalLifecycle> {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.operationId !== operationId) {
      return Promise.reject(
        new ConversationAuthorityClosedError("terminal emission authority missing"),
      );
    }
    let effective =
      entry.terminal === CONVERSATION_TERMINAL_LIFECYCLE.ABORTED &&
      isConversationGracefulTerminalLifecycle(lifecycle)
        ? CONVERSATION_TERMINAL_LIFECYCLE.ABORTED
        : (entry.state === "cancelled" || this.cancellationClaimed(conversationId, operationId)) &&
            lifecycle !== CONVERSATION_TERMINAL_LIFECYCLE.ABORTED
          ? CONVERSATION_TERMINAL_LIFECYCLE.ABORTED
          : isConversationGracefulTerminalLifecycle(lifecycle) &&
              (entry.state === "paused" || entry.state === "pausing" || entry.state === "resuming")
            ? CONVERSATION_TERMINAL_LIFECYCLE.ABORTED
            : lifecycle;
    if (entry.terminal) {
      if (entry.terminalPending)
        return entry.terminalPending.then(() => entry.terminal as TerminalLifecycle);
      if (entry.state === "closed") return Promise.resolve(entry.terminal);
      return Promise.reject(new Error("terminal lifecycle reservation incomplete"));
    }
    const prior = entry.pending;
    entry.terminalPrevious =
      entry.state === "cancelled"
        ? "cancelled"
        : entry.state === "paused" || entry.state === "resuming"
          ? "paused"
          : "open";
    entry.state = "closing";
    entry.terminal = effective;
    this.rejectWaiters(entry);
    const pending = (prior ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        if (
          lifecycle !== CONVERSATION_TERMINAL_LIFECYCLE.ABORTED &&
          (entry.terminalPrevious === "cancelled" ||
            this.cancellationClaimed(conversationId, operationId))
        ) {
          effective = CONVERSATION_TERMINAL_LIFECYCLE.ABORTED;
          entry.terminal = effective;
        }
        return append(effective);
      })
      .then(() => {
        entry.state = "closed";
      });
    entry.terminalPending = pending;
    return this.track(entry, pending).then(() => effective);
  }

  releaseFailedTerminal(
    conversationId: string,
    operationId: string,
    lifecycle: TerminalLifecycle,
  ): void {
    const entry = this.entries.get(conversationId);
    if (
      !entry ||
      entry.operationId !== operationId ||
      entry.state !== "closing" ||
      entry.terminal !== lifecycle
    ) {
      return;
    }
    entry.state = entry.terminalPrevious ?? "open";
    entry.terminal = null;
    entry.terminalPrevious = undefined;
    entry.terminalPending = undefined;
    entry.pending = undefined;
  }

  adoptTerminal(
    conversationId: string,
    operationId: string,
    lifecycle: TerminalLifecycle,
  ): TerminalLifecycle {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.operationId !== operationId) {
      throw new ConversationAuthorityClosedError("terminal adoption authority missing");
    }
    if (entry.terminal) {
      if (entry.terminal === lifecycle) return lifecycle;
      throw new ConversationAuthorityClosedError("terminal adoption authority missing");
    }
    entry.state = "closed";
    entry.terminal = lifecycle;
    entry.terminalPrevious = undefined;
    entry.terminalPending = undefined;
    entry.pending = undefined;
    this.rejectWaiters(entry);
    return lifecycle;
  }

  finish(conversationId: string, operationId: string): boolean {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.operationId !== operationId || entry.state !== "closed") return false;
    this.rejectWaiters(entry);
    this.entries.delete(conversationId);
    return true;
  }

  abandon(conversationId: string, operationId: string): boolean {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.operationId !== operationId || entry.terminal) return false;
    this.rejectWaiters(entry);
    this.entries.delete(conversationId);
    return true;
  }
}
