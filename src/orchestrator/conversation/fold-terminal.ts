import type { ConversationLifecycle, PublicStoredTraceEvent } from "../trace/types.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import {
  ConversationFoldError,
  exact,
  object,
  terminal,
  validateTerminalScore,
} from "./fold-validation.js";

export function validateConversationTerminalEvent(
  record: PublicStoredTraceEvent,
  lifecycle: ConversationLifecycle,
  policy: string,
  consensusScore: number | null,
  decision: Parameters<typeof validateTerminalScore>[4],
): void {
  if (record.event.type !== CONVERSATION_TRACE_EVENT_KIND.CONVERSATION_TERMINAL)
    throw new ConversationFoldError("terminal record has an invalid event kind");
  const payload = record.event.payload as unknown;
  if (!object(payload))
    throw new ConversationFoldError("terminal record must match terminal lifecycle");
  if (
    !exact(payload, ["lifecycle", "terminal", "final_score"]) ||
    !terminal(lifecycle) ||
    payload.lifecycle !== lifecycle ||
    payload.terminal !== true
  ) {
    throw new ConversationFoldError("terminal record must match terminal lifecycle");
  }
  validateTerminalScore(lifecycle, policy, payload.final_score, consensusScore, decision);
}
