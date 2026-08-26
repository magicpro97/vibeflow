export const CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION = "1.0" as const;

export type ConversationMessageQueueSchemaVersionV1 =
  typeof CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION;

export const CONVERSATION_MESSAGE_QUEUE_STATE = Object.freeze({
  QUEUED: "queued",
  CLAIMED: "claimed",
  DELIVERED: "delivered",
  STALE: "stale",
} as const);

export type ConversationMessageQueueStateV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_STATE)[keyof typeof CONVERSATION_MESSAGE_QUEUE_STATE];

export const CONVERSATION_MESSAGE_QUEUE_STATES = Object.freeze(
  Object.values(CONVERSATION_MESSAGE_QUEUE_STATE),
) as readonly ConversationMessageQueueStateV1[];

export const CONVERSATION_MESSAGE_QUEUE_STALE_REASON = Object.freeze({
  PREDECESSOR_NOT_DELIVERED: "predecessor_not_delivered",
  LINEAGE_HEAD_CHANGED: "lineage_head_changed",
  PARTICIPANT_SET_CHANGED: "participant_set_changed",
  OPERATION_CHANGED: "operation_changed",
  CAUSAL_SUCCESSOR_MISMATCH: "causal_successor_mismatch",
} as const);

export type ConversationMessageQueueStaleReasonV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_STALE_REASON)[keyof typeof CONVERSATION_MESSAGE_QUEUE_STALE_REASON];

export const CONVERSATION_MESSAGE_QUEUE_STALE_REASONS = Object.freeze(
  Object.values(CONVERSATION_MESSAGE_QUEUE_STALE_REASON),
) as readonly ConversationMessageQueueStaleReasonV1[];

export const CONVERSATION_MESSAGE_QUEUE_EVENT_KIND = Object.freeze({
  ADMITTED: "admitted",
  EDITED: "edited",
  CLAIMED: "claimed",
  DELIVERED: "delivered",
  STALE: "stale",
} as const);

export type ConversationMessageQueueEventKindV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND)[keyof typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND];

export const CONVERSATION_MESSAGE_QUEUE_EVENT_KINDS = Object.freeze(
  Object.values(CONVERSATION_MESSAGE_QUEUE_EVENT_KIND),
) as readonly ConversationMessageQueueEventKindV1[];

export const CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND = Object.freeze({
  ENQUEUE: "enqueue",
  EDIT: "edit",
} as const);

export type ConversationMessageQueueMutationKindV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND)[keyof typeof CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND];

export const CONVERSATION_MESSAGE_QUEUE_MUTATION_KINDS = Object.freeze(
  Object.values(CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND),
) as readonly ConversationMessageQueueMutationKindV1[];

export const CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS = Object.freeze({
  CURRENT: "current",
  STALE: CONVERSATION_MESSAGE_QUEUE_STATE.STALE,
} as const);

export type ConversationMessageQueueAuthorityStatusV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS)[keyof typeof CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS];

export const CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS = Object.freeze({
  EMPTY: "empty",
  STALE: CONVERSATION_MESSAGE_QUEUE_STATE.STALE,
  CLAIMED: CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
} as const);

export type ConversationMessageQueueClaimResultStatusV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS)[keyof typeof CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS];

export const CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE = Object.freeze({
  PENDING: "pending",
  SETTLED: "settled",
} as const);

export type ConversationMessageQueuePendingMutationStateV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE)[keyof typeof CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE];

export const CONVERSATION_MESSAGE_QUEUE_ERROR_CODE = Object.freeze({
  UNAUTHENTICATED: "unauthenticated",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  REQUEST_TOO_LARGE: "request_too_large",
  AUTHORITY_CORRUPT: "authority_corrupt",
  QUEUE_FULL: "queue_full",
  RATE_LIMITED: "rate_limited",
  INVALID_REQUEST: "invalid_request",
  SERVICE_UNAVAILABLE: "service_unavailable",
  IDEMPOTENCY_CONFLICT: "idempotency_conflict",
  PRIVATE_CONTEXT_CONFLICT: "private_context_conflict",
  QUEUED_MESSAGE_NOT_EDITABLE: "queued_message_not_editable",
  STALE_QUEUED_MESSAGE: "stale_queued_message",
  QUEUE_CLAIM_BUSY: "queue_claim_busy",
  NOT_LINEAGE_HEAD: "not_lineage_head",
  QUEUE_AUTHORITY_CORRUPT: "conversation_message_queue_corrupt",
} as const);

export type ConversationMessageQueueErrorCodeV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_ERROR_CODE)[keyof typeof CONVERSATION_MESSAGE_QUEUE_ERROR_CODE];

export const CONVERSATION_MESSAGE_QUEUE_ERROR_CODES = Object.freeze(
  Object.values(CONVERSATION_MESSAGE_QUEUE_ERROR_CODE),
) as readonly ConversationMessageQueueErrorCodeV1[];

export const CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION = Object.freeze({
  EDIT: "edit",
  RETRY: "retry",
  SEND_AS_NEW: "send-as-new",
  REPAIR_AUTHORITY: "repair-authority",
  SELECT_ACTIVE_CONVERSATION: "select-active-conversation",
} as const);

export type ConversationMessageQueueRecoveryActionV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION)[keyof typeof CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION];

export const CONVERSATION_MESSAGE_QUEUE_CONFLICT_CODES = Object.freeze([
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY,
] as const);

export type ConversationMessageQueueConflictCodeV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_CONFLICT_CODES)[number];

export const CONVERSATION_MESSAGE_QUEUE_LIMITS = Object.freeze({
  maxNonterminalItems: 32,
  maxTerminalSnapshotItems: 32,
  maxObjectBytes: 512 * 1024,
  maxContentBytes: 65_536,
  maxTargets: 32,
  maxQuotes: 8,
  maxJournalEvents: 1_000_000,
  maxRootMarkerBytes: 16 * 1024,
} as const);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isConversationMessageQueueState = (
  value: unknown,
): value is ConversationMessageQueueStateV1 => memberOf(CONVERSATION_MESSAGE_QUEUE_STATES, value);

export const isConversationMessageQueueStaleReason = (
  value: unknown,
): value is ConversationMessageQueueStaleReasonV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_STALE_REASONS, value);

export const isConversationMessageQueueEventKind = (
  value: unknown,
): value is ConversationMessageQueueEventKindV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_EVENT_KINDS, value);

export const isConversationMessageQueueMutationKind = (
  value: unknown,
): value is ConversationMessageQueueMutationKindV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_MUTATION_KINDS, value);

export const isConversationMessageQueueErrorCode = (
  value: unknown,
): value is ConversationMessageQueueErrorCodeV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_ERROR_CODES, value);
