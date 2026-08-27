import type {
  CONVERSATION_MESSAGE_QUEUE_FIELD,
  ConversationMessageQueueStaleReasonV1,
  ConversationMessageQueueStateV1,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import type {
  ConversationMessageQueueSnapshotV1,
  EditQueuedUserMessageRequestV1,
  EnqueueConversationUserMessageRequestV1,
  PublicConversationMessageQueueInvalidationV1,
  PublicQueuedUserMessageV1,
} from "../../orchestrator/conversation/conversation-message-queue-wire.js";

export type HomeMessageQueueState = ConversationMessageQueueStateV1;
export type HomeMessageQueueStaleReason = ConversationMessageQueueStaleReasonV1;
export type HomeEnqueueMessageRequest = EnqueueConversationUserMessageRequestV1;
export type HomeEditQueuedMessageRequest = EditQueuedUserMessageRequestV1;
export type HomeQueuedMessage = PublicQueuedUserMessageV1;
export type HomeMessageQueueSnapshot = ConversationMessageQueueSnapshotV1;
export type HomeMessageQueueInvalidation = PublicConversationMessageQueueInvalidationV1;

export const HOME_QUEUED_MESSAGE_PROJECTION_KIND = Object.freeze({
  AUTHORITATIVE: "authoritative",
  OPTIMISTIC: "optimistic",
  RETRYABLE: "retryable",
} as const);

export type HomeQueuedMessageProjectionKind =
  (typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND)[keyof typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND];

type OptimisticQueueRequestFields =
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.CONTENT
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.TARGET_PARTICIPANTS
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.QUOTE_REFS
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.PRIVATE_CONTEXT_PRESENT;

export type HomeOptimisticQueuedMessage = {
  kind: typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.OPTIMISTIC;
  projection_key: string;
  root_session_id: string;
  client_order: number;
} & Pick<EnqueueConversationUserMessageRequestV1, OptimisticQueueRequestFields>;

export type HomeRetryableQueuedMessage = Omit<HomeOptimisticQueuedMessage, "kind"> & {
  kind: typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.RETRYABLE;
  failure_message: string;
  retrying: boolean;
};

export type HomeQueuedMessageProjection =
  | {
      kind: typeof HOME_QUEUED_MESSAGE_PROJECTION_KIND.AUTHORITATIVE;
      item: HomeQueuedMessage;
    }
  | HomeOptimisticQueuedMessage
  | HomeRetryableQueuedMessage;

type QueueEditBindingFields =
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.ROOT_SESSION_ID
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.QUEUE_ITEM_ID
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.ITEM_DIGEST
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.QUEUE_SEQUENCE
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.TARGET_PARTICIPANTS
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.QUOTE_REFS
  | typeof CONVERSATION_MESSAGE_QUEUE_FIELD.PRIVATE_CONTEXT_PRESENT;

export type HomeQueuedMessageEditBinding = Pick<PublicQueuedUserMessageV1, QueueEditBindingFields>;
