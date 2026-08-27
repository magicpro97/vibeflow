/**
 * Browser-safe public wire contract for the conversation message queue.
 *
 * Keep this module dependency-free: server and UI boundaries import the same DTOs and structural
 * guards without pulling in durability, filesystem, or process authority.
 */
import type { PublicQuoteReferenceV1 } from "./conversation-interaction-types.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  type ConversationMessageQueueAuthorPublicIdV1,
  type ConversationMessageQueueSchemaVersionV1,
  type ConversationMessageQueueStaleReasonV1,
  type ConversationMessageQueueStateV1,
  type ConversationMessageQueueTargetParticipantsV1,
  isConversationMessageQueueNonterminalState,
  isConversationMessageQueueQuoteTargetKind,
  isConversationMessageQueueStaleReason,
  isConversationMessageQueueState,
} from "./conversation-message-queue-contract.js";

export interface EnqueueConversationUserMessageRequestV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  idempotency_key: string;
  expected_authority_digest: string;
  client_instance_id: string;
  client_order: number;
  content: string;
  target_participants: ConversationMessageQueueTargetParticipantsV1;
  quote_refs: PublicQuoteReferenceV1[];
  private_context_present: boolean;
}

export interface EditQueuedUserMessageRequestV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  idempotency_key: string;
  expected_item_digest: string;
  content: string;
}

export interface PublicQueuedUserMessageV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  queue_item_id: string;
  queue_sequence: number;
  root_session_id: string;
  author_public_id: ConversationMessageQueueAuthorPublicIdV1;
  content: string;
  content_digest: string;
  target_participants: ConversationMessageQueueTargetParticipantsV1;
  quote_refs: PublicQuoteReferenceV1[];
  private_context_present: boolean;
  predecessor_queue_item_id: string | null;
  admitted_authority_digest: string;
  effective_authority_digest: string;
  state: ConversationMessageQueueStateV1;
  stale_reason: ConversationMessageQueueStaleReasonV1 | null;
  admitted_at: string;
  updated_at: string;
  item_digest: string;
}

export interface ConversationMessageQueueSnapshotV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  current_authority_digest: string;
  max_nonterminal_items: typeof CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems;
  items: PublicQueuedUserMessageV1[];
}

export interface PublicConversationMessageQueueInvalidationV1 {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  queue_item_id: string;
  state: ConversationMessageQueueStateV1;
  item_digest: string;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const QUEUE_ITEM_ID_PATTERN = /^vf-queued-message-[0-9a-f]{64}$/;

const wireRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function hasConversationMessageQueueExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export const isConversationMessageQueueDigest = (value: unknown): value is string =>
  typeof value === "string" && DIGEST_PATTERN.test(value);

export const isConversationMessageQueueItemId = (value: unknown): value is string =>
  typeof value === "string" && QUEUE_ITEM_ID_PATTERN.test(value);

export const isConversationMessageQueueReference = (
  value: unknown,
  maxBytes: number = CONVERSATION_MESSAGE_QUEUE_LIMITS.maxReferenceBytes,
): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  new TextEncoder().encode(value).byteLength <= maxBytes &&
  !/\p{Cc}/u.test(value);

const isCanonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const isQueueContent = (value: unknown): value is string =>
  typeof value === "string" &&
  value.normalize("NFC") === value &&
  new TextEncoder().encode(value).byteLength >= 1 &&
  new TextEncoder().encode(value).byteLength <= CONVERSATION_MESSAGE_QUEUE_LIMITS.maxContentBytes;

const isQueueTargets = (value: unknown): value is ConversationMessageQueueTargetParticipantsV1 => {
  if (value === CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL) return true;
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= CONVERSATION_MESSAGE_QUEUE_LIMITS.maxTargets &&
    value.every((entry) => isConversationMessageQueueReference(entry)) &&
    new Set(value).size === value.length
  );
};

export const isPublicConversationMessageQueueQuoteReferenceWireV1 = (
  value: unknown,
): value is PublicQuoteReferenceV1 =>
  wireRecord(value) &&
  hasConversationMessageQueueExactFields(
    value,
    CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.QUOTE_REFERENCE,
  ) &&
  isConversationMessageQueueReference(value.root_session_id) &&
  isConversationMessageQueueReference(value.conversation_id) &&
  isConversationMessageQueueReference(value.revision_id) &&
  isConversationMessageQueueReference(value.target_event_id) &&
  isConversationMessageQueueQuoteTargetKind(value.target_kind) &&
  isConversationMessageQueueDigest(value.content_digest) &&
  isConversationMessageQueueReference(value.author_public_id);

const isPublicQuoteReferenceList = (value: unknown): value is PublicQuoteReferenceV1[] =>
  Array.isArray(value) &&
  value.length <= CONVERSATION_MESSAGE_QUEUE_LIMITS.maxQuotes &&
  value.every(isPublicConversationMessageQueueQuoteReferenceWireV1);

export function isPublicQueuedUserMessageWireV1(
  value: unknown,
): value is PublicQueuedUserMessageV1 {
  if (
    !wireRecord(value) ||
    !hasConversationMessageQueueExactFields(
      value,
      CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.PUBLIC_ITEM,
    ) ||
    value.schema_version !== CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION ||
    !isConversationMessageQueueItemId(value.queue_item_id) ||
    !Number.isSafeInteger(value.queue_sequence) ||
    (value.queue_sequence as number) < 1 ||
    !isConversationMessageQueueReference(value.root_session_id) ||
    value.author_public_id !== CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN ||
    !isQueueContent(value.content) ||
    !isConversationMessageQueueDigest(value.content_digest) ||
    !isQueueTargets(value.target_participants) ||
    !isPublicQuoteReferenceList(value.quote_refs) ||
    typeof value.private_context_present !== "boolean" ||
    (value.predecessor_queue_item_id !== null &&
      !isConversationMessageQueueItemId(value.predecessor_queue_item_id)) ||
    !isConversationMessageQueueDigest(value.admitted_authority_digest) ||
    !isConversationMessageQueueDigest(value.effective_authority_digest) ||
    !isConversationMessageQueueState(value.state) ||
    !isCanonicalTimestamp(value.admitted_at) ||
    !isCanonicalTimestamp(value.updated_at) ||
    !isConversationMessageQueueDigest(value.item_digest)
  )
    return false;
  if (
    Date.parse(value.updated_at) < Date.parse(value.admitted_at) ||
    value.quote_refs.some((quote) => quote.root_session_id !== value.root_session_id)
  )
    return false;
  return value.state === CONVERSATION_MESSAGE_QUEUE_STATE.STALE
    ? isConversationMessageQueueStaleReason(value.stale_reason)
    : value.stale_reason === null;
}

export function isConversationMessageQueueSnapshotWireV1(
  value: unknown,
  rootSessionId: string,
): value is ConversationMessageQueueSnapshotV1 {
  if (
    wireRecord(value) &&
    hasConversationMessageQueueExactFields(
      value,
      CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.SNAPSHOT,
    ) &&
    value.schema_version === CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION &&
    value.root_session_id === rootSessionId &&
    isConversationMessageQueueDigest(value.current_authority_digest) &&
    value.max_nonterminal_items === CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems &&
    Array.isArray(value.items) &&
    value.items.length <=
      CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems +
        CONVERSATION_MESSAGE_QUEUE_LIMITS.maxTerminalSnapshotItems &&
    value.items.every(
      (item) => isPublicQueuedUserMessageWireV1(item) && item.root_session_id === rootSessionId,
    )
  ) {
    return (
      value.items.filter((item) => isConversationMessageQueueNonterminalState(item.state)).length <=
      CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems
    );
  }
  return false;
}

export function isPublicConversationMessageQueueInvalidationWireV1(
  value: unknown,
  rootSessionId: string,
): value is PublicConversationMessageQueueInvalidationV1 {
  return (
    wireRecord(value) &&
    hasConversationMessageQueueExactFields(
      value,
      CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.INVALIDATION,
    ) &&
    value.schema_version === CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION &&
    value.root_session_id === rootSessionId &&
    isConversationMessageQueueItemId(value.queue_item_id) &&
    isConversationMessageQueueState(value.state) &&
    isConversationMessageQueueDigest(value.item_digest)
  );
}
