import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  isConversationMessageQueueStaleReason,
  isConversationMessageQueueState,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import type {
  HomeMessageQueueInvalidation,
  HomeMessageQueueSnapshot,
  HomeMessageQueueState,
  HomeQueuedMessage,
} from "./conversation-home-message-queue-types.js";
import type { HomeCanonicalQuoteReference } from "./conversation-home-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const QUEUE_ITEM_ID = /^vf-queued-message-[0-9a-f]{64}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const digest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);
const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};
const queueState = (value: unknown): value is HomeMessageQueueState =>
  isConversationMessageQueueState(value);

function content(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFC") === value &&
    new TextEncoder().encode(value).byteLength >= 1 &&
    new TextEncoder().encode(value).byteLength <= CONVERSATION_MESSAGE_QUEUE_LIMITS.maxContentBytes
  );
}

function targets(value: unknown): value is "all" | string[] {
  if (value === "all") return true;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxTargets
  )
    return false;
  if (!value.every((entry) => text(entry))) return false;
  return new Set(value).size === value.length;
}

function quote(value: unknown): value is HomeCanonicalQuoteReference {
  if (!record(value)) return false;
  if (
    !exactKeys(value, [
      "author_public_id",
      "content_digest",
      "conversation_id",
      "revision_id",
      "root_session_id",
      "target_event_id",
      "target_kind",
    ])
  )
    return false;
  return (
    text(value.root_session_id) &&
    text(value.conversation_id) &&
    text(value.revision_id) &&
    text(value.target_event_id) &&
    (value.target_kind === "user-message" || value.target_kind === "completed-agent-response") &&
    digest(value.content_digest) &&
    text(value.author_public_id)
  );
}

function quotes(value: unknown): value is HomeCanonicalQuoteReference[] {
  return (
    Array.isArray(value) &&
    value.length <= CONVERSATION_MESSAGE_QUEUE_LIMITS.maxQuotes &&
    value.every(quote)
  );
}

export function isHomeQueuedMessage(value: unknown): value is HomeQueuedMessage {
  if (!record(value)) return false;
  if (
    !exactKeys(value, [
      "admitted_at",
      "admitted_authority_digest",
      "author_public_id",
      "content",
      "content_digest",
      "effective_authority_digest",
      "item_digest",
      "predecessor_queue_item_id",
      "private_context_present",
      "queue_item_id",
      "queue_sequence",
      "quote_refs",
      "root_session_id",
      "schema_version",
      "stale_reason",
      "state",
      "target_participants",
      "updated_at",
    ])
  )
    return false;
  if (
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    typeof value.queue_item_id !== "string" ||
    !QUEUE_ITEM_ID.test(value.queue_item_id) ||
    !Number.isSafeInteger(value.queue_sequence) ||
    (value.queue_sequence as number) < 1 ||
    !text(value.root_session_id) ||
    value.author_public_id !== "human" ||
    !content(value.content) ||
    !digest(value.content_digest) ||
    !targets(value.target_participants) ||
    !quotes(value.quote_refs) ||
    typeof value.private_context_present !== "boolean" ||
    (value.predecessor_queue_item_id !== null &&
      (typeof value.predecessor_queue_item_id !== "string" ||
        !QUEUE_ITEM_ID.test(value.predecessor_queue_item_id))) ||
    !digest(value.admitted_authority_digest) ||
    !digest(value.effective_authority_digest) ||
    !queueState(value.state) ||
    !timestamp(value.admitted_at) ||
    !timestamp(value.updated_at) ||
    !digest(value.item_digest)
  )
    return false;
  return value.state === CONVERSATION_MESSAGE_QUEUE_STATE.STALE
    ? isConversationMessageQueueStaleReason(value.stale_reason)
    : value.stale_reason === null;
}

export function assertHomeMessageQueueSnapshot(
  value: unknown,
  rootSessionId: string,
): asserts value is HomeMessageQueueSnapshot {
  if (
    !record(value) ||
    !exactKeys(value, [
      "current_authority_digest",
      "items",
      "max_nonterminal_items",
      "root_session_id",
      "schema_version",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    value.root_session_id !== rootSessionId ||
    !digest(value.current_authority_digest) ||
    value.max_nonterminal_items !== CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems ||
    !Array.isArray(value.items) ||
    value.items.length >
      CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems +
        CONVERSATION_MESSAGE_QUEUE_LIMITS.maxTerminalSnapshotItems ||
    !value.items.every(
      (item) => isHomeQueuedMessage(item) && item.root_session_id === rootSessionId,
    )
  )
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
  if (
    !record(value) ||
    !exactKeys(value, [
      "item_digest",
      "queue_item_id",
      "root_session_id",
      "schema_version",
      "state",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    value.root_session_id !== rootSessionId ||
    typeof value.queue_item_id !== "string" ||
    !QUEUE_ITEM_ID.test(value.queue_item_id) ||
    !queueState(value.state) ||
    !digest(value.item_digest)
  )
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
      item?.author_public_id === "human" &&
      item.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED
    )
      return item;
  }
  return null;
}
