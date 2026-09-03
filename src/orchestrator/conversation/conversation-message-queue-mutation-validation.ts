import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueTargetParticipantsV1,
} from "./conversation-message-queue-contract.js";
import { assertQueueContextBindingV1 } from "./conversation-message-queue-private-validation.js";
import type { PrivateConversationMessageQueueContextBindingV1 } from "./conversation-message-queue-records.js";
import { isQueueDigest, isQueueReference } from "./conversation-message-queue-validation.js";

export function assertQueueMutationPrincipal(value: string): void {
  if (!isQueueDigest(value)) throw new Error("invalid queue authenticated principal digest");
}

export function assertQueueMutationPrivateBinding(
  requestPresent: boolean,
  binding: PrivateConversationMessageQueueContextBindingV1 | null,
): void {
  if (requestPresent !== (binding !== null))
    throw new Error("queue private context binding authority does not match request");
  if (binding) assertQueueContextBindingV1(binding);
}

export function assertQueueMutationResolvedTargets(
  requestTargets: ConversationMessageQueueTargetParticipantsV1,
  resolvedTargets: string[],
  binding: PrivateConversationMessageQueueContextBindingV1 | null,
): void {
  if (
    resolvedTargets.length < 1 ||
    resolvedTargets.length > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxTargets ||
    resolvedTargets.some((target) => !isQueueReference(target)) ||
    new Set(resolvedTargets).size !== resolvedTargets.length ||
    (requestTargets !== CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL &&
      JSON.stringify(requestTargets) !== JSON.stringify(resolvedTargets)) ||
    (binding && JSON.stringify(binding.target_participant_ids) !== JSON.stringify(resolvedTargets))
  )
    throw new Error("queue private context resolved target authority changed");
}
