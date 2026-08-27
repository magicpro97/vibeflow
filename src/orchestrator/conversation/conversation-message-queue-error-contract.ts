import {
  hasExactWireFields,
  isNonnegativeSafeWireInteger,
  isPlainWireRecord,
} from "../../actions/public-wire-primitives.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  type ConversationMessageQueueErrorCodeV1,
  type ConversationMessageQueueRecoveryActionV1,
  isConversationMessageQueueErrorCode,
  isConversationMessageQueueStaleReason,
  isConversationMessageQueueState,
} from "./conversation-message-queue-contract.js";
import {
  isConversationMessageQueueDigest,
  isConversationMessageQueueItemId,
  isConversationMessageQueueReference,
} from "./conversation-message-queue-wire.js";

type QueueErrorSemanticsV1 = Readonly<{
  retryable: boolean;
  recovery_actions: readonly (ConversationMessageQueueRecoveryActionV1 | null)[];
}>;

const semantics = (
  retryable: boolean,
  ...recoveryActions: readonly (ConversationMessageQueueRecoveryActionV1 | null)[]
): QueueErrorSemanticsV1 =>
  Object.freeze({ retryable, recovery_actions: Object.freeze(recoveryActions) });

const noRecovery = semantics(false, null);
const edit = semantics(false, CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.EDIT);
const retry = semantics(true, CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY);
const repairAuthority = semantics(
  false,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.REPAIR_AUTHORITY,
);
const sendAsNew = semantics(false, CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SEND_AS_NEW);

export const CONVERSATION_MESSAGE_QUEUE_ERROR_SEMANTICS = Object.freeze({
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.UNAUTHENTICATED]: noRecovery,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.FORBIDDEN]: noRecovery,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_FOUND]: noRecovery,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE]: noRecovery,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.AUTHORITY_CORRUPT]: repairAuthority,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL]: retry,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED]: edit,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST]: edit,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.SERVICE_UNAVAILABLE]: retry,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT]: edit,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT]: edit,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE]: sendAsNew,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE]: sendAsNew,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY]: retry,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_LINEAGE_HEAD]: semantics(
    false,
    CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.SELECT_ACTIVE_CONVERSATION,
  ),
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT]: repairAuthority,
} satisfies Readonly<Record<ConversationMessageQueueErrorCodeV1, QueueErrorSemanticsV1>>);

export const CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE = Object.freeze({
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL]: `This conversation already has ${CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems} messages waiting.`,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE]:
    "That queued message changed before the edit could commit.",
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE]:
    "That queued message no longer matches the conversation authority it followed.",
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT]:
    "Private context changed before this request could commit.",
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE]: `The request body exceeds the ${CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes}-byte limit.`,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED]:
    "Too many private context selections are waiting.",
} as const);

export function isConversationMessageQueueErrorMessage(code: unknown, message: unknown): boolean {
  if (!isConversationMessageQueueErrorCode(code) || typeof message !== "string") return false;
  if (!Object.hasOwn(CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE, code)) return true;
  return (
    message ===
    CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE[
      code as keyof typeof CONVERSATION_MESSAGE_QUEUE_CANONICAL_ERROR_MESSAGE
    ]
  );
}

export const CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD = Object.freeze({
  MAX_BODY_BYTES: "max_body_bytes",
  ROOT_SESSION_ID: "root_session_id",
  MAX_NONTERMINAL_ITEMS: "max_nonterminal_items",
  MAX_PENDING_PRIVATE_CONTEXTS: "max_pending_private_contexts",
  PRIVATE_CONTEXT_PRESENT: "private_context_present",
  QUEUE_OWNED: "queue_owned",
  QUEUE_ITEM_ID: "queue_item_id",
  STATE: "state",
  ITEM_DIGEST: "item_digest",
  STALE_REASON: "stale_reason",
} as const);

const fields = <const Fields extends readonly string[]>(...values: Fields): Readonly<Fields> =>
  Object.freeze(values);

const noDetails = null;
const bodyLimitDetails = fields(CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.MAX_BODY_BYTES);
const queueLimitDetails = fields(
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.ROOT_SESSION_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.MAX_NONTERMINAL_ITEMS,
);
const privateLimitDetails = fields(
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.MAX_PENDING_PRIVATE_CONTEXTS,
);
const privateConflictDetails = fields(
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.PRIVATE_CONTEXT_PRESENT,
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.QUEUE_OWNED,
);
const notEditableDetails = fields(
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.ROOT_SESSION_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.QUEUE_ITEM_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.STATE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.ITEM_DIGEST,
);
const staleDetails = fields(
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.ROOT_SESSION_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.QUEUE_ITEM_ID,
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.STALE_REASON,
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELD.ITEM_DIGEST,
);

type QueueErrorDetailFieldsV1 = readonly string[] | null;

export const CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELDS = Object.freeze({
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.UNAUTHENTICATED]: noDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.FORBIDDEN]: noDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_FOUND]: noDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE]: bodyLimitDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.AUTHORITY_CORRUPT]: noDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL]: queueLimitDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED]: privateLimitDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST]: noDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.SERVICE_UNAVAILABLE]: noDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT]: noDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT]: privateConflictDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE]: notEditableDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE]: staleDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY]: noDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_LINEAGE_HEAD]: noDetails,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT]: noDetails,
} satisfies Readonly<Record<ConversationMessageQueueErrorCodeV1, QueueErrorDetailFieldsV1>>);

export function isConversationMessageQueueErrorSemantic(
  code: unknown,
  retryable: unknown,
  recoveryAction: unknown,
): recoveryAction is ConversationMessageQueueRecoveryActionV1 | null {
  if (!isConversationMessageQueueErrorCode(code)) return false;
  const expected = CONVERSATION_MESSAGE_QUEUE_ERROR_SEMANTICS[code];
  return (
    retryable === expected.retryable &&
    expected.recovery_actions.some((candidate) => candidate === recoveryAction)
  );
}

export function isConversationMessageQueueErrorDetails(code: unknown, value: unknown): boolean {
  if (!isConversationMessageQueueErrorCode(code)) return false;
  const expectedFields = CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELDS[code];
  if (expectedFields === null) return value === null;
  if (!isPlainWireRecord(value) || !hasExactWireFields(value, expectedFields)) return false;
  if (code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE)
    return value.max_body_bytes === CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes;
  if (code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL)
    return (
      isConversationMessageQueueReference(value.root_session_id) &&
      value.max_nonterminal_items === CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems
    );
  if (code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED)
    return (
      isNonnegativeSafeWireInteger(value.max_pending_private_contexts) &&
      value.max_pending_private_contexts === CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems
    );
  if (code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT)
    return (
      typeof value.private_context_present === "boolean" && typeof value.queue_owned === "boolean"
    );
  if (code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE)
    return (
      isConversationMessageQueueReference(value.root_session_id) &&
      isConversationMessageQueueItemId(value.queue_item_id) &&
      isConversationMessageQueueState(value.state) &&
      isConversationMessageQueueDigest(value.item_digest)
    );
  return (
    code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE &&
    isConversationMessageQueueReference(value.root_session_id) &&
    isConversationMessageQueueItemId(value.queue_item_id) &&
    isConversationMessageQueueStaleReason(value.stale_reason) &&
    isConversationMessageQueueDigest(value.item_digest)
  );
}
