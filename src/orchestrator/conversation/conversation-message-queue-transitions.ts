import type { CONVERSATION_MESSAGE_QUEUE_STATE } from "./conversation-message-queue-contract.js";
import type { FoldedConversationMessageQueueItemV1 } from "./conversation-message-queue-fold.js";
import { assertQueueContextDispositionV1 } from "./conversation-message-queue-private-validation.js";
import type {
  ConversationMessageQueueStaleReasonV1,
  PrivateConversationMessageQueueContextDispositionV1,
  PublicQueuedUserMessageV1,
} from "./conversation-message-queue-records.js";
import { queuedMessageItemDigest } from "./conversation-message-queue-records.js";
import { assertPublicQueuedUserMessageV1 } from "./conversation-message-queue-validation.js";

export function transitionQueuedMessageItemV1(
  prior: PublicQueuedUserMessageV1,
  input: {
    state:
      | typeof CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED
      | typeof CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED
      | typeof CONVERSATION_MESSAGE_QUEUE_STATE.STALE;
    stale_reason: ConversationMessageQueueStaleReasonV1 | null;
    updated_at: string;
    effective_authority_digest?: string;
  },
): PublicQueuedUserMessageV1 {
  const { item_digest: _digest, ...preimage } = prior;
  const next = {
    ...preimage,
    ...input,
    effective_authority_digest:
      input.effective_authority_digest ?? prior.effective_authority_digest,
  };
  const item = { ...next, item_digest: queuedMessageItemDigest(next) };
  assertPublicQueuedUserMessageV1(item);
  return item;
}

export function assertQueuePrivateDispositionV1(
  row: FoldedConversationMessageQueueItemV1,
  outcome:
    | typeof CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED
    | typeof CONVERSATION_MESSAGE_QUEUE_STATE.STALE,
  disposition: PrivateConversationMessageQueueContextDispositionV1 | null,
  publicEventId: string | null,
): void {
  if (row.item.private_context_present !== (disposition !== null))
    throw new Error("queue terminal private-context disposition is missing or unexpected");
  if (!disposition) return;
  assertQueueContextDispositionV1(disposition);
  if (
    disposition.root_session_id !== row.item.root_session_id ||
    disposition.queue_item_id !== row.item.queue_item_id ||
    disposition.private_context_binding_digest !== row.private_context_binding_digest ||
    disposition.queue_outcome !== outcome ||
    disposition.public_event_id !== publicEventId
  )
    throw new Error("queue terminal private-context disposition authority changed");
}
