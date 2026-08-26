import type { ProcessLockStatus } from "../../durability/index.js";
import { processLockOwnerIsAlive } from "../../durability/lock-owner.js";
import { queueClaimOwnerMatchesProcessLock } from "./conversation-message-queue-authority.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import type { FoldedConversationMessageQueueItemV1 } from "./conversation-message-queue-fold.js";
import {
  ConversationMessageQueueConflictError,
  ConversationMessageQueueCorruptError,
} from "./conversation-message-queue-validation.js";

export function assertQueueClaimLockMayAdvanceV1(
  row: FoldedConversationMessageQueueItemV1,
  status: ProcessLockStatus,
  durableOperationId: string,
): void {
  const operation = `message-queue-claim:${durableOperationId}`;
  if (row.item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED && status.status !== "absent") {
    if (status.status === "dead" && status.owner.operation === operation) return;
    if (status.status === "live" || status.status === "unprovable")
      throw new ConversationMessageQueueConflictError(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY,
        "unpublished queue claim owner death is unprovable",
      );
    throw new ConversationMessageQueueCorruptError(
      "unclaimed queue item has an unrelated claim owner",
    );
  }
  if (row.item.state !== CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED) return;
  if (!row.claim_owner)
    throw new ConversationMessageQueueCorruptError("claimed queue item lacks owner authority");
  if (status.status === "absent" || !status.owner)
    throw new ConversationMessageQueueConflictError(
      CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY,
      "claimed queue owner death is unprovable",
    );
  const exactOwner = queueClaimOwnerMatchesProcessLock(row.claim_owner, status.owner);
  const {
    durable_operation_id: _operation,
    owner_digest: _digest,
    ...foldedProcessOwner
  } = row.claim_owner;
  const replacedUnpublishedOwner =
    !exactOwner &&
    status.status === "dead" &&
    status.owner.operation === operation &&
    processLockOwnerIsAlive(foldedProcessOwner) === false;
  if (!exactOwner && !replacedUnpublishedOwner)
    throw new ConversationMessageQueueConflictError(
      CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY,
      "claimed queue lock does not prove the folded owner transition",
    );
  if (status.status !== "dead")
    throw new ConversationMessageQueueConflictError(
      CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY,
      "oldest queued message has a live or unprovable owner",
    );
}
