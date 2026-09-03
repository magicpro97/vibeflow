import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import type {
  ConversationMessageQueueAuthorityV1,
  ConversationMessageQueueSnapshotV1,
  PublicQueuedUserMessageV1,
} from "./conversation-message-queue-records.js";

export function materializeConversationMessageQueueSnapshotV1(
  rootSessionId: string,
  currentAuthority: ConversationMessageQueueAuthorityV1,
  all: readonly PublicQueuedUserMessageV1[],
): ConversationMessageQueueSnapshotV1 {
  const nonterminal = all.filter(
    (item) =>
      item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED ||
      item.state === CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
  );
  const terminal = all
    .filter(
      (item) =>
        item.state === CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED ||
        item.state === CONVERSATION_MESSAGE_QUEUE_STATE.STALE,
    )
    .slice(-CONVERSATION_MESSAGE_QUEUE_LIMITS.maxTerminalSnapshotItems);
  return {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    root_session_id: rootSessionId,
    current_authority_digest: currentAuthority.authority_digest,
    max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
    items: [...nonterminal, ...terminal]
      .sort((left, right) => left.queue_sequence - right.queue_sequence)
      .map((item) => structuredClone(item)),
  };
}
