import { validateIdempotencyKey } from "../../actions/idempotency.js";
import { canonicalJsonBytes, digestHex } from "../../durability/index.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_FIELD,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND,
  CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueConflictCodeV1,
  type ConversationMessageQueueTargetParticipantsV1,
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
import {
  isConversationMessageQueueDigest,
  isConversationMessageQueueItemId,
  isConversationMessageQueueReference,
  isPublicConversationMessageQueueQuoteReferenceWireV1,
} from "./conversation-message-queue-wire.js";

export class ConversationMessageQueueCorruptError extends Error {
  readonly code = CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT;
}

export interface ConversationMessageQueueConflictContextV1 {
  readonly root_session_id: string;
}

export class ConversationMessageQueueConflictError extends Error {
  readonly code: ConversationMessageQueueConflictCodeV1;
  readonly context: Readonly<ConversationMessageQueueConflictContextV1> | null;

  constructor(
    code: typeof CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
    message: string,
    context: Readonly<ConversationMessageQueueConflictContextV1>,
  );
  constructor(
    code: Exclude<
      ConversationMessageQueueConflictCodeV1,
      typeof CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL
    >,
    message: string,
    context?: Readonly<ConversationMessageQueueConflictContextV1>,
  );
  constructor(
    code: ConversationMessageQueueConflictCodeV1,
    message: string,
    context?: Readonly<ConversationMessageQueueConflictContextV1>,
  ) {
    super(message);
    this.code = code;
    if (
      (code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL && context === undefined) ||
      (context !== undefined &&
        (!queueRecord(context) ||
          !queueExactKeys(context, [CONVERSATION_MESSAGE_QUEUE_FIELD.ROOT_SESSION_ID]) ||
          !isConversationMessageQueueReference(context.root_session_id)))
    )
      throw new Error("invalid conversation message queue conflict context");
    this.context = context ? Object.freeze({ root_session_id: context.root_session_id }) : null;
  }
}

export const queueRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function queueExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export const isQueueDigest = isConversationMessageQueueDigest;

export const isQueueReference = isConversationMessageQueueReference;

export const isQueueTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function assertTargets(
  value: unknown,
): asserts value is ConversationMessageQueueTargetParticipantsV1 {
  if (value === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL) return;
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
    !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.AUTHORITY) ||
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
    !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.ENQUEUE_REQUEST) ||
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
  if (!value.quote_refs.every(isPublicConversationMessageQueueQuoteReferenceWireV1))
    throw new Error("invalid enqueue message request");
}

export function assertEditQueuedUserMessageRequestV1(
  value: unknown,
): asserts value is EditQueuedUserMessageRequestV1 {
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EDIT_REQUEST) ||
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
    !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.PUBLIC_ITEM) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    typeof value.queue_item_id !== "string" ||
    !isConversationMessageQueueItemId(value.queue_item_id) ||
    !Number.isSafeInteger(value.queue_sequence) ||
    (value.queue_sequence as number) < 1 ||
    !isQueueReference(value.root_session_id) ||
    value.author_public_id !== CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN ||
    !isQueueDigest(value.content_digest) ||
    !Array.isArray(value.quote_refs) ||
    value.quote_refs.length > CONVERSATION_MESSAGE_QUEUE_LIMITS.maxQuotes ||
    typeof value.private_context_present !== "boolean" ||
    (value.predecessor_queue_item_id !== null &&
      (typeof value.predecessor_queue_item_id !== "string" ||
        !isConversationMessageQueueItemId(value.predecessor_queue_item_id))) ||
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
    if (!isPublicConversationMessageQueueQuoteReferenceWireV1(quote))
      throw new Error("invalid public queued message");
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
    !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.CURRENT) ||
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
    !queueExactKeys(value, CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.IDEMPOTENCY_BINDING) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    (value.mutation_kind !== CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.ENQUEUE &&
      value.mutation_kind !== CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND.EDIT) ||
    !isQueueDigest(value.principal_digest) ||
    !isQueueReference(value.root_session_id) ||
    !isQueueDigest(value.idempotency_key_digest) ||
    !isQueueDigest(value.canonical_request_digest) ||
    typeof value.queue_item_id !== "string" ||
    !isConversationMessageQueueItemId(value.queue_item_id) ||
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
