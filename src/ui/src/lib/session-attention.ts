// Session attention marks for the Home rail (Orca 1.4.210 "unread indicators" port).
// NOTE import depth: this file lives in src/ui/src/lib/, so orchestrator contracts are
// THREE levels up ("../../../orchestrator/…"). Existing importers live in src/ui/src/
// and use "../../orchestrator/…" — that depth is wrong here and will fail typecheck.
import { isConversationTerminalLifecycle } from "../../../orchestrator/conversation/conversation-lifecycle-contract.js";

export const SESSION_ATTENTION_STORAGE_KEY = "vf-attention";

export interface AttentionFacts {
  root_session_id: string;
  lifecycle: string | null;
}

/** Attention policy: any TERMINAL lifecycle marks a finished background conversation. */
export function isAttentionLifecycle(lifecycle: string | null): boolean {
  return lifecycle !== null && isConversationTerminalLifecycle(lifecycle);
}

export function mergeAttention(
  attention: Readonly<Record<string, true>>,
  previous: readonly AttentionFacts[],
  sessions: readonly AttentionFacts[],
  activeRootId: string | null,
): Record<string, true> {
  const before = new Map(previous.map((session) => [session.root_session_id, session.lifecycle]));
  const next: Record<string, true> = {};
  for (const session of sessions) {
    if (session.root_session_id === activeRootId) continue;
    const held = attention[session.root_session_id] === true;
    const seen = before.get(session.root_session_id);
    const freshlyFinished =
      seen !== undefined && seen !== session.lifecycle && isAttentionLifecycle(session.lifecycle);
    if (held || freshlyFinished) next[session.root_session_id] = true;
  }
  return next;
}

export function clearAttention(
  attention: Readonly<Record<string, true>>,
  rootSessionId: string | null,
): Record<string, true> {
  if (!rootSessionId || attention[rootSessionId] !== true) return { ...attention };
  const next = { ...attention };
  delete next[rootSessionId];
  return next;
}

export function readAttention(storage: Pick<Storage, "getItem">): Record<string, true> {
  try {
    const raw = storage.getItem(SESSION_ATTENTION_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next: Record<string, true> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true && key.length > 0 && key.length <= 256) next[key] = true;
    }
    return next;
  } catch {
    return {};
  }
}

export function writeAttention(
  storage: Pick<Storage, "setItem">,
  attention: Readonly<Record<string, true>>,
): void {
  try {
    storage.setItem(SESSION_ATTENTION_STORAGE_KEY, JSON.stringify(attention));
  } catch {
    // Storage blocked or full — attention is a nicety; degrade to session-only.
  }
}
