import { parseConversationSseRecord, parseConversationSseSnapshot } from "./conversation-api.js";
import type { ConversationSnapshot, ConversationTraceRecord } from "./conversation-types.js";

export function acceptConversationSnapshotFrame(
  raw: string,
  conversationId: string,
  apply: (snapshot: ConversationSnapshot) => boolean,
): boolean {
  try {
    return apply(parseConversationSseSnapshot(raw, conversationId));
  } catch {
    return false;
  }
}

export function acceptConversationTraceFrame(
  raw: string,
  conversationId: string,
  apply: (record: ConversationTraceRecord) => boolean,
): boolean {
  try {
    const record = parseConversationSseRecord(raw);
    if (record.conversation_id !== conversationId) return false;
    return apply(record);
  } catch {
    return false;
  }
}
