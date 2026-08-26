import { validateIdempotencyKey } from "../../actions/idempotency.js";
import { canonicalJsonBytes, digestHex } from "../../durability/index.js";
import { assertPublicQuoteReferenceV1 } from "./conversation-interaction-validation.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  type ConversationMessageQueueConflictCodeV1,
  isConversationMessageQueueStaleReason,
  isConversationMessageQueueState,
} from "./conversation-message-queue-contract.js";
import type {
  ConversationMessageQueueAuthorityV1,
  EditQueuedUserMessageRequestV1,
  EnqueueConversationUserMessageRequestV1,
  PrivateConversationMessageQueueCurrentV1,
  PrivateConversationMessageQueueIdempotencyBindingV1,
  PublicQueuedUserMessageV1,
} from "./conversation-message-queue-records.js";
import {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  queueAuthorityDigest,
  queueIdempotencyBindingDigest,
  queueIdempotencyFileKey,
  queuedMessageContentDigest,
  queuedMessageItemDigest,
} from "./conversation-message-queue-records.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const QUEUE_ID = /^vf-queued-message-[0-9a-f]{64}$/;

export class ConversationMessageQueueCorruptError extends Error {
  readonly code = CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT;
}

export class ConversationMessageQueueConflictError extends Error {
  constructor(
    readonly code: ConversationMessageQueueConflictCodeV1,
    message: string,
  ) {
    super(message);
  }
}

export const queueRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function queueExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export const isQueueDigest = (value: unknown): value is string =>
  typeof value === "string" && DIGEST.test(value);

export const isQueueReference = (value: unknown, maxBytes = 512): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= maxBytes &&
  !/\p{Cc}/u.test(value);

export const isQueueTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function assertTargets(value: unknown): asserts value is "all" | string[] {
  if (value === "all") return;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxTargets ||
    value.some((item) => !isQueueReference(item)) ||
    new Set(value).size !== value.length
  )
    throw new Error("invalid queued-message target participants");
}

function assertContent(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.normalize("NFC") !== value ||
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxContentBytes
  )
    throw new Error("invalid queued-message content");
}

export function assertConversationMessageQueueAuthorityV1(
  value: unknown,
): asserts value is ConversationMessageQueueAuthorityV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "root_session_id",
      "conversation_id",
      "revision_id",
      "lineage_head_digest",
      "lineage_head_epoch",
      "participant_set_digest",
      "active_operation_digest",
      "authority_digest",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isQueueReference(value.root_session_id) ||
    !isQueueReference(value.conversation_id) ||
    !isQueueReference(value.revision_id) ||
    !isQueueDigest(value.lineage_head_digest) ||
    !Number.isSafeInteger(value.lineage_head_epoch) ||
    (value.lineage_head_epoch as number) < 0 ||
    !isQueueDigest(value.participant_set_digest) ||
    (value.active_operation_digest !== null && !isQueueDigest(value.active_operation_digest)) ||
    !isQueueDigest(value.authority_digest)
  )
    throw new Error("invalid conversation message queue authority");
  const typed = value as unknown as ConversationMessageQueueAuthorityV1;
  const { authority_digest: _digest, ...preimage } = typed;
  if (queueAuthorityDigest(preimage) !== typed.authority_digest)
    throw new Error("conversation message queue authority digest changed");
}

export function assertEnqueueConversationUserMessageRequestV1(
  value: unknown,
): asserts value is EnqueueConversationUserMessageRequestV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "idempotency_key",
      "expected_authority_digest",
      "content",
      "target_participants",
      "quote_refs",
      "private_context_present",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isQueueDigest(value.expected_authority_digest) ||
    !Array.isArray(value.quote_refs) ||
    value.quote_refs.length > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxQuotes ||
    typeof value.private_context_present !== "boolean"
  )
    throw new Error("invalid enqueue message request");
  validateIdempotencyKey(value.idempotency_key);
  assertContent(value.content);
  assertTargets(value.target_participants);
  value.quote_refs.forEach(assertPublicQuoteReferenceV1);
}

export function assertEditQueuedUserMessageRequestV1(
  value: unknown,
): asserts value is EditQueuedUserMessageRequestV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "idempotency_key",
      "expected_item_digest",
      "content",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isQueueDigest(value.expected_item_digest)
  )
    throw new Error("invalid queued-message edit request");
  validateIdempotencyKey(value.idempotency_key);
  assertContent(value.content);
}

export function assertPublicQueuedUserMessageV1(
  value: unknown,
): asserts value is PublicQueuedUserMessageV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "queue_item_id",
      "queue_sequence",
      "root_session_id",
      "author_public_id",
      "content",
      "content_digest",
      "target_participants",
      "quote_refs",
      "private_context_present",
      "predecessor_queue_item_id",
      "admitted_authority_digest",
      "effective_authority_digest",
      "state",
      "stale_reason",
      "admitted_at",
      "updated_at",
      "item_digest",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    typeof value.queue_item_id !== "string" ||
    !QUEUE_ID.test(value.queue_item_id) ||
    !Number.isSafeInteger(value.queue_sequence) ||
    (value.queue_sequence as number) < 1 ||
    !isQueueReference(value.root_session_id) ||
    value.author_public_id !== "human" ||
    !isQueueDigest(value.content_digest) ||
    !Array.isArray(value.quote_refs) ||
    value.quote_refs.length > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxQuotes ||
    typeof value.private_context_present !== "boolean" ||
    (value.predecessor_queue_item_id !== null &&
      (typeof value.predecessor_queue_item_id !== "string" ||
        !QUEUE_ID.test(value.predecessor_queue_item_id))) ||
    !isQueueDigest(value.admitted_authority_digest) ||
    !isQueueDigest(value.effective_authority_digest) ||
    !isConversationMessageQueueState(value.state) ||
    (value.state === CONVERSATION_MESSAGE_QUEUE_STATE.STALE) !== (value.stale_reason !== null) ||
    (value.stale_reason !== null && !isConversationMessageQueueStaleReason(value.stale_reason)) ||
    !isQueueTimestamp(value.admitted_at) ||
    !isQueueTimestamp(value.updated_at) ||
    Date.parse(value.updated_at as string) < Date.parse(value.admitted_at as string) ||
    !isQueueDigest(value.item_digest)
  )
    throw new Error("invalid public queued message");
  assertContent(value.content);
  assertTargets(value.target_participants);
  for (const quote of value.quote_refs) {
    assertPublicQuoteReferenceV1(quote);
    if (quote.root_session_id !== value.root_session_id)
      throw new Error("queued-message quote crosses root authority");
  }
  const typed = value as unknown as PublicQueuedUserMessageV1;
  if (
    queuedMessageContentDigest({
      content: typed.content,
      target_participants: typed.target_participants,
      quote_refs: typed.quote_refs,
      private_context_present: typed.private_context_present,
    }) !== typed.content_digest ||
    queuedMessageItemDigest((({ item_digest: _, ...item }) => item)(typed)) !== typed.item_digest
  )
    throw new Error("queued-message digest changed");
}

export function decodeCanonicalQueueRecord<T>(
  bytes: Buffer,
  validate: (value: unknown) => void,
): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validate(value);
  } catch (error) {
    throw new ConversationMessageQueueCorruptError(
      `invalid queue authority object: ${String(error)}`,
    );
  }
  if (!canonicalJsonBytes(value).equals(bytes))
    throw new ConversationMessageQueueCorruptError("queue authority object is not canonical");
  return structuredClone(value as T);
}

export function assertQueueCurrentV1(
  value: unknown,
): asserts value is PrivateConversationMessageQueueCurrentV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "root_session_id",
      "last_journal_sequence",
      "head_event_digest",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isQueueReference(value.root_session_id) ||
    !Number.isSafeInteger(value.last_journal_sequence) ||
    (value.last_journal_sequence as number) < 0 ||
    !isQueueDigest(value.head_event_digest)
  )
    throw new Error("invalid queue current pointer");
}

export function assertQueueIdempotencyBindingV1(
  value: unknown,
): asserts value is PrivateConversationMessageQueueIdempotencyBindingV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, [
      "schema_version",
      "mutation_kind",
      "principal_digest",
      "root_session_id",
      "idempotency_key_digest",
      "canonical_request_digest",
      "queue_item_id",
      "winning_event_digest",
      "binding_digest",
    ]) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    (value.mutation_kind !== CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.ENQUEUE &&
      value.mutation_kind !== CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.EDIT) ||
    !isQueueDigest(value.principal_digest) ||
    !isQueueReference(value.root_session_id) ||
    !isQueueDigest(value.idempotency_key_digest) ||
    !isQueueDigest(value.canonical_request_digest) ||
    typeof value.queue_item_id !== "string" ||
    !QUEUE_ID.test(value.queue_item_id) ||
    !isQueueDigest(value.winning_event_digest) ||
    !isQueueDigest(value.binding_digest)
  )
    throw new Error("invalid queue idempotency binding");
  const typed = value as unknown as PrivateConversationMessageQueueIdempotencyBindingV1;
  const { binding_digest: _digest, ...preimage } = typed;
  if (
    queueIdempotencyBindingDigest(preimage) !== typed.binding_digest ||
    !/^[0-9a-f]{64}$/.test(digestHex(queueIdempotencyFileKey(typed)))
  )
    throw new Error("queue idempotency binding digest changed");
}
