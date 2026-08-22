import type { ConversationLifecycle, InternalTraceStoreRecord, StoredTraceEvent } from "./types.js";

const LEGAL: Readonly<Record<ConversationLifecycle, readonly ConversationLifecycle[]>> = {
  INIT: ["ACTIVE", "STOPPED"],
  ACTIVE: ["PAUSED", "COMPLETED", "STOPPED", "FAILED", "ABORTED"],
  PAUSED: ["ACTIVE", "STOPPED", "FAILED", "ABORTED"],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  ABORTED: [],
};
const canonicalLifecycleKey = (key: string): boolean =>
  key === "conversation:active" ||
  key.startsWith("conversation:transition:") ||
  key.startsWith("conversation:health:") ||
  key === "conversation:terminal-state" ||
  key === "conversation:terminal";

export class TraceLifecycleConflictError extends Error {
  override readonly name = "TraceLifecycleConflictError";
  constructor(
    readonly durableLifecycle: ConversationLifecycle,
    readonly requestedLifecycle: ConversationLifecycle,
  ) {
    super(`trace lifecycle conflict: ${durableLifecycle} -> ${requestedLifecycle}`);
  }
}

interface LifecycleCursor {
  lifecycle: ConversationLifecycle;
  health: "healthy" | "degraded";
  awaitingTerminal: ConversationLifecycle | null;
  terminal: boolean;
  cancelledOperations: Set<string>;
}

function apply(cursor: LifecycleCursor, stored: StoredTraceEvent, enforce: boolean): void {
  const { event } = stored;
  if (event.type === "caller_cancelled") {
    cursor.cancelledOperations.add(event.payload.operation_id);
    return;
  }
  if (enforce && cursor.cancelledOperations.has(stored.operation_id)) {
    const allowed =
      (event.type === "state_change" &&
        event.payload.terminal &&
        event.payload.lifecycle === "ABORTED") ||
      (event.type === "conversation_terminal" && event.payload.lifecycle === "ABORTED");
    if (!allowed) throw new TraceLifecycleConflictError("ABORTED", cursor.lifecycle);
  }
  if (
    enforce &&
    cursor.lifecycle === "PAUSED" &&
    event.type !== "state_change" &&
    event.type !== "conversation_terminal" &&
    !(
      event.type === "native_history_reconciled" &&
      stored.idempotency_key.startsWith("native-history:")
    )
  ) {
    throw new TraceLifecycleConflictError("PAUSED", "PAUSED");
  }
  if (event.type === "state_change") {
    const next = event.payload.lifecycle;
    const nextHealth = event.payload.health;
    const terminal =
      next === "COMPLETED" || next === "STOPPED" || next === "FAILED" || next === "ABORTED";
    if (enforce && event.payload.terminal !== terminal) {
      throw new TraceLifecycleConflictError(cursor.lifecycle, next);
    }
    if (enforce && cursor.terminal) {
      throw new TraceLifecycleConflictError(cursor.lifecycle, next);
    }
    if (enforce && cursor.awaitingTerminal) {
      throw new TraceLifecycleConflictError(cursor.lifecycle, next);
    }
    if (enforce && next !== cursor.lifecycle && !LEGAL[cursor.lifecycle].includes(next)) {
      throw new TraceLifecycleConflictError(cursor.lifecycle, next);
    }
    if (
      enforce &&
      next === cursor.lifecycle &&
      ((next !== "ACTIVE" && next !== "PAUSED") || nextHealth === cursor.health)
    ) {
      throw new TraceLifecycleConflictError(cursor.lifecycle, next);
    }
    if (enforce && next !== cursor.lifecycle && nextHealth !== cursor.health) {
      throw new TraceLifecycleConflictError(cursor.lifecycle, next);
    }
    cursor.lifecycle = next;
    cursor.health = nextHealth;
    cursor.awaitingTerminal = event.payload.terminal ? next : null;
    return;
  }
  if (event.type !== "conversation_terminal") return;
  const next = event.payload.lifecycle;
  if (enforce && (cursor.terminal || cursor.awaitingTerminal !== next)) {
    throw new TraceLifecycleConflictError(cursor.lifecycle, next);
  }
  cursor.lifecycle = next;
  cursor.awaitingTerminal = null;
  cursor.terminal = true;
}

/** Compare canonical lifecycle effects with the durable journal while its lock is held. */
export function assertCanonicalLifecycleAppend(
  existing: readonly InternalTraceStoreRecord[],
  pending: readonly InternalTraceStoreRecord[],
): void {
  const cursor: LifecycleCursor = {
    lifecycle: "INIT",
    health: "healthy",
    awaitingTerminal: null,
    terminal: false,
    cancelledOperations: new Set(),
  };
  for (const { stored_event } of existing) {
    apply(cursor, stored_event, false);
  }
  for (const { stored_event } of pending) {
    const canonical = canonicalLifecycleKey(stored_event.idempotency_key);
    if (!canonical && (cursor.terminal || cursor.awaitingTerminal)) {
      throw new TraceLifecycleConflictError(cursor.lifecycle, cursor.lifecycle);
    }
    apply(cursor, stored_event, true);
  }
}
