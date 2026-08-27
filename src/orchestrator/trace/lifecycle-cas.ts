import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_HEALTH,
  CONVERSATION_LIFECYCLE,
  CONVERSATION_TERMINAL_LIFECYCLE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "../conversation/conversation-public-wire-contract.js";
import type {
  ConversationHealth,
  ConversationLifecycle,
  InternalTraceStoreRecord,
  StoredTraceEvent,
} from "./types.js";

const LEGAL: Readonly<Record<ConversationLifecycle, readonly ConversationLifecycle[]>> =
  Object.freeze({
    [CONVERSATION_LIFECYCLE.INIT]: Object.freeze([
      CONVERSATION_LIFECYCLE.ACTIVE,
      CONVERSATION_LIFECYCLE.STOPPED,
    ]),
    [CONVERSATION_LIFECYCLE.ACTIVE]: Object.freeze([
      CONVERSATION_LIFECYCLE.PAUSED,
      CONVERSATION_LIFECYCLE.COMPLETED,
      CONVERSATION_LIFECYCLE.STOPPED,
      CONVERSATION_LIFECYCLE.FAILED,
      CONVERSATION_LIFECYCLE.ABORTED,
    ]),
    [CONVERSATION_LIFECYCLE.PAUSED]: Object.freeze([
      CONVERSATION_LIFECYCLE.ACTIVE,
      CONVERSATION_LIFECYCLE.STOPPED,
      CONVERSATION_LIFECYCLE.FAILED,
      CONVERSATION_LIFECYCLE.ABORTED,
    ]),
    [CONVERSATION_LIFECYCLE.COMPLETED]: Object.freeze([]),
    [CONVERSATION_LIFECYCLE.STOPPED]: Object.freeze([]),
    [CONVERSATION_LIFECYCLE.FAILED]: Object.freeze([]),
    [CONVERSATION_LIFECYCLE.ABORTED]: Object.freeze([]),
  });
const canonicalLifecycleKey = (key: string): boolean =>
  key === "conversation:active" ||
  key.startsWith("conversation:transition:") ||
  key.startsWith("conversation:health:") ||
  key === "conversation:terminal-state" ||
  key === "conversation:terminal";

const reviewedPostTerminalAction = (stored: StoredTraceEvent): boolean =>
  (stored.event.type === CONVERSATION_TRACE_EVENT_KIND.ARTIFACT_CREATED &&
    stored.event.payload.artifact_type === CONVERSATION_ARTIFACT_TYPE.COMPACTION &&
    stored.idempotency_key.startsWith("action-context-compaction:vf-proposal-")) ||
  (stored.event.type === CONVERSATION_TRACE_EVENT_KIND.USER_MESSAGE &&
    stored.idempotency_key.startsWith("action-public-literal:vf-proposal-"));

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
  health: ConversationHealth;
  awaitingTerminal: ConversationLifecycle | null;
  terminal: boolean;
  cancelledOperations: Set<string>;
}

function apply(cursor: LifecycleCursor, stored: StoredTraceEvent, enforce: boolean): void {
  const { event } = stored;
  if (event.type === CONVERSATION_TRACE_EVENT_KIND.CALLER_CANCELLED) {
    cursor.cancelledOperations.add(event.payload.operation_id);
    return;
  }
  if (enforce && cursor.cancelledOperations.has(stored.operation_id)) {
    const allowed =
      (event.type === CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE &&
        event.payload.terminal &&
        event.payload.lifecycle === CONVERSATION_LIFECYCLE.ABORTED) ||
      (event.type === CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL &&
        event.payload.lifecycle === CONVERSATION_LIFECYCLE.ABORTED);
    if (!allowed)
      throw new TraceLifecycleConflictError(CONVERSATION_LIFECYCLE.ABORTED, cursor.lifecycle);
  }
  if (
    enforce &&
    cursor.lifecycle === CONVERSATION_LIFECYCLE.PAUSED &&
    event.type !== CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE &&
    event.type !== CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL &&
    !(
      event.type === CONVERSATION_TRACE_EVENT_KIND.NATIVE_HISTORY_RECONCILED &&
      stored.idempotency_key.startsWith("native-history:")
    )
  ) {
    throw new TraceLifecycleConflictError(
      CONVERSATION_LIFECYCLE.PAUSED,
      CONVERSATION_LIFECYCLE.PAUSED,
    );
  }
  if (event.type === CONVERSATION_TRACE_EVENT_KIND.STATE_CHANGE) {
    const next = event.payload.lifecycle;
    const nextHealth = event.payload.health;
    const terminal =
      next === CONVERSATION_TERMINAL_LIFECYCLE.COMPLETED ||
      next === CONVERSATION_TERMINAL_LIFECYCLE.STOPPED ||
      next === CONVERSATION_TERMINAL_LIFECYCLE.FAILED ||
      next === CONVERSATION_TERMINAL_LIFECYCLE.ABORTED;
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
      ((next !== CONVERSATION_LIFECYCLE.ACTIVE && next !== CONVERSATION_LIFECYCLE.PAUSED) ||
        nextHealth === cursor.health)
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
  if (event.type !== CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL) return;
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
    lifecycle: CONVERSATION_LIFECYCLE.INIT,
    health: CONVERSATION_HEALTH.HEALTHY,
    awaitingTerminal: null,
    terminal: false,
    cancelledOperations: new Set(),
  };
  for (const { stored_event } of existing) {
    apply(cursor, stored_event, false);
  }
  for (const { stored_event } of pending) {
    const canonical = canonicalLifecycleKey(stored_event.idempotency_key);
    if (
      !canonical &&
      (cursor.terminal || cursor.awaitingTerminal) &&
      !reviewedPostTerminalAction(stored_event)
    ) {
      throw new TraceLifecycleConflictError(cursor.lifecycle, cursor.lifecycle);
    }
    apply(cursor, stored_event, true);
  }
}
