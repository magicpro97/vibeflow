import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import {
  isConversationMessageQueueSnapshotWireV1,
  isPublicConversationMessageQueueInvalidationWireV1,
  isPublicQueuedUserMessageWireV1,
} from "../../orchestrator/conversation/conversation-message-queue-wire.js";
import type {
  HomeMessageQueueInvalidation,
  HomeMessageQueueSnapshot,
  HomeQueuedMessage,
} from "./conversation-home-message-queue-types.js";

export function isHomeQueuedMessage(value: unknown): value is HomeQueuedMessage {
  return isPublicQueuedUserMessageWireV1(value);
}

export function assertHomeMessageQueueSnapshot(
  value: unknown,
  rootSessionId: string,
): asserts value is HomeMessageQueueSnapshot {
  if (!isConversationMessageQueueSnapshotWireV1(value, rootSessionId))
    throw new Error("The message queue projection did not match this session.");
  let priorSequence = 0;
  const ids = new Set<string>();
  for (const item of value.items as HomeQueuedMessage[]) {
    if (item.queue_sequence <= priorSequence || ids.has(item.queue_item_id))
      throw new Error("The message queue projection was not canonical.");
    priorSequence = item.queue_sequence;
    ids.add(item.queue_item_id);
  }
}

export function assertHomeQueueInvalidation(
  value: unknown,
  rootSessionId: string,
): asserts value is HomeMessageQueueInvalidation {
  if (!isPublicConversationMessageQueueInvalidationWireV1(value, rootSessionId))
    throw new Error("The message queue update did not match this session.");
}

export function mergeHomeQueuedMessage(
  snapshot: HomeMessageQueueSnapshot,
  item: unknown,
): HomeMessageQueueSnapshot {
  if (!isHomeQueuedMessage(item) || item.root_session_id !== snapshot.root_session_id)
    throw new Error("The queued message response did not match this session.");
  const byId = new Map(snapshot.items.map((entry) => [entry.queue_item_id, entry]));
  byId.set(item.queue_item_id, structuredClone(item));
  return {
    ...snapshot,
    items: [...byId.values()].sort((left, right) => left.queue_sequence - right.queue_sequence),
  };
}

export function latestHomeEditableQueueItem(
  snapshot: HomeMessageQueueSnapshot | null,
): HomeQueuedMessage | null {
  if (!snapshot) return null;
  for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
    const item = snapshot.items[index];
    if (
      item?.author_public_id === CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN &&
      item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED
    )
      return item;
  }
  return null;
}
