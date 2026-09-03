import type { Ref } from "vue";
import type { ConversationMessageQueueRecoveryActionV1 } from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import type { HomeQueueAdmissionEntry } from "./conversation-home-message-queue-authority.js";
import type {
  HomeNeedsActionQueuedMessage,
  HomeRetryableQueuedMessage,
} from "./conversation-home-message-queue-types.js";
import { HOME_QUEUED_MESSAGE_PROJECTION_KIND } from "./conversation-home-message-queue-types.js";

export function createHomeQueueFailureProjections(
  retryable: Ref<HomeRetryableQueuedMessage[]>,
  needsAction: Ref<HomeNeedsActionQueuedMessage[]>,
) {
  const retryableEntries = new Map<string, HomeQueueAdmissionEntry>();
  const needsActionEntries = new Map<string, HomeQueueAdmissionEntry>();
  const without = <T extends { projection_key: string }>(rows: T[], key: string): T[] =>
    rows.filter((item) => item.projection_key !== key);

  function removeRetryable(key: string): void {
    retryableEntries.delete(key);
    retryable.value = without(retryable.value, key);
  }
  function removeNeedsAction(key: string): void {
    needsActionEntries.delete(key);
    needsAction.value = without(needsAction.value, key);
  }
  function retainRetryable(
    entry: HomeQueueAdmissionEntry,
    failureMessage: string,
    retrying = false,
  ): void {
    const key = entry.projection.projection_key;
    removeNeedsAction(key);
    retryableEntries.set(key, entry);
    retryable.value = [
      ...without(retryable.value, key),
      {
        ...entry.projection,
        kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.RETRYABLE,
        failure_message: failureMessage,
        retrying,
      },
    ];
  }
  function retainNeedsAction(
    entry: HomeQueueAdmissionEntry,
    failureMessage: string,
    recoveryAction: ConversationMessageQueueRecoveryActionV1 | null,
  ): void {
    const key = entry.projection.projection_key;
    removeRetryable(key);
    needsActionEntries.set(key, entry);
    needsAction.value = [
      ...without(needsAction.value, key),
      {
        ...entry.projection,
        kind: HOME_QUEUED_MESSAGE_PROJECTION_KIND.NEEDS_ACTION,
        failure_message: failureMessage,
        recovery_action: recoveryAction,
      },
    ];
  }

  return {
    retryableEntry: (key: string) => retryableEntries.get(key),
    needsActionEntry: (key: string) => needsActionEntries.get(key),
    hasRetryable: (key: string) => retryableEntries.has(key),
    hasNeedsAction: (key: string) => needsActionEntries.has(key),
    removeRetryable,
    removeNeedsAction,
    retainRetryable,
    retainNeedsAction,
    clear() {
      retryableEntries.clear();
      needsActionEntries.clear();
    },
  };
}
