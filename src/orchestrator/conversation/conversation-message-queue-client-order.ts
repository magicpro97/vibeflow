import { CONVERSATION_MESSAGE_QUEUE_ERROR_CODE } from "./conversation-message-queue-contract.js";
import type { FoldedConversationMessageQueueV1 } from "./conversation-message-queue-fold.js";
import type { EnqueueConversationUserMessageRequestV1 } from "./conversation-message-queue-records.js";
import { ConversationMessageQueueConflictError } from "./conversation-message-queue-validation.js";

export function assertNextConversationMessageClientOrder(input: {
  fold: FoldedConversationMessageQueueV1;
  principalDigest: string;
  request: EnqueueConversationUserMessageRequestV1;
}): void {
  const priorClientOrder = input.fold.items
    .filter(
      (row) =>
        row.owner_principal_digest === input.principalDigest &&
        row.client_instance_id === input.request.client_instance_id,
    )
    .at(-1)?.client_order;
  if (input.request.client_order !== (priorClientOrder ?? 0) + 1)
    throw new ConversationMessageQueueConflictError(
      CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT,
      "client admission order is not the next durable request",
    );
}
