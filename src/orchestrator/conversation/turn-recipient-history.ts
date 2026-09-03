import {
  CONVERSATION_TURN_HISTORY_SUMMARY_KIND,
  CONVERSATION_TURN_RECIPIENT_HISTORY_LIMIT,
  CONVERSATION_TURN_RECIPIENT_HISTORY_SOURCE,
} from "./turn-delivery-contract.js";
import type {
  ConversationTurnRecipientHistoryEntryV1,
  ConversationTurnRecipientHistoryV1,
  ConversationTurnResponseV1,
} from "./turn-delivery-types.js";

const ELLIPSIS = "…";

function boundedUtf8(value: string): { text: string; truncated: boolean } {
  const maxBytes = CONVERSATION_TURN_RECIPIENT_HISTORY_LIMIT.MAX_SUMMARY_BYTES;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  const contentBudget = maxBytes - Buffer.byteLength(ELLIPSIS, "utf8");
  let text = "";
  let bytes = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + nextBytes > contentBudget) break;
    text += codePoint;
    bytes += nextBytes;
  }
  return { text: `${text}${ELLIPSIS}`, truncated: true };
}

function historyEntry(
  response: ConversationTurnResponseV1,
): ConversationTurnRecipientHistoryEntryV1 {
  const summaryKind = response.claim
    ? CONVERSATION_TURN_HISTORY_SUMMARY_KIND.CLAIM
    : response.answer
      ? CONVERSATION_TURN_HISTORY_SUMMARY_KIND.ANSWER
      : CONVERSATION_TURN_HISTORY_SUMMARY_KIND.EMPTY;
  const source = response.claim ?? response.answer;
  const bounded = source === null ? null : boundedUtf8(source);
  return Object.freeze({
    message_id: response.message_id,
    public_seq: response.public_seq,
    role_ref: response.role_ref,
    round_id: response.round_id,
    summary_kind: summaryKind,
    summary: bounded?.text ?? null,
    summary_truncated: bounded?.truncated ?? false,
    source_content_digest: response.content_digest,
  });
}

export function recipientTurnHistory(
  responses: readonly ConversationTurnResponseV1[],
  nativeSessionRequired: boolean,
): ConversationTurnRecipientHistoryV1 {
  if (nativeSessionRequired) {
    return Object.freeze({
      source: CONVERSATION_TURN_RECIPIENT_HISTORY_SOURCE.NATIVE_SESSION,
      source_response_count: responses.length,
      replayed_response_count: 0,
      truncated_response_count: 0,
      entries: Object.freeze([]),
    });
  }
  const retained = responses.slice(-CONVERSATION_TURN_RECIPIENT_HISTORY_LIMIT.MAX_ENTRIES);
  const entries = Object.freeze(retained.map(historyEntry));
  return Object.freeze({
    source: CONVERSATION_TURN_RECIPIENT_HISTORY_SOURCE.BOUNDED_PUBLIC_REPLAY,
    source_response_count: responses.length,
    replayed_response_count: entries.length,
    truncated_response_count: responses.length - entries.length,
    entries,
  });
}
