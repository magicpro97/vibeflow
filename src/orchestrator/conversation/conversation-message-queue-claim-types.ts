import type {
  CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import type {
  PrivateConversationMessageQueueClaimOwnerV1,
  PublicQueuedUserMessageV1,
} from "./conversation-message-queue-records.js";

export interface PrivateConversationMessageQueueClaimV1 {
  item: PublicQueuedUserMessageV1 & {
    state: typeof CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED;
    stale_reason: null;
  };
  claim_epoch: number;
  claim_owner: PrivateConversationMessageQueueClaimOwnerV1;
  durable_operation_id: string;
  public_event_id: string;
  private_context_binding_digest: string | null;
}

export type ConversationMessageQueueClaimResultV1 =
  | { status: typeof CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.EMPTY }
  | {
      status: typeof CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.STALE;
      item: PublicQueuedUserMessageV1 & {
        state: typeof CONVERSATION_MESSAGE_QUEUE_STATE.STALE;
      };
    }
  | {
      status: typeof CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS.CLAIMED;
      claim: PrivateConversationMessageQueueClaimV1;
      replayed: boolean;
    };
