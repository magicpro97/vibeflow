import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../../actions/public-error-contract.js";

export {
  CONVERSATION_MESSAGE_QUEUE_FIELD,
  CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS,
  type ConversationMessageQueueFieldV1,
} from "./conversation-message-queue-fields.js";

export const CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION = "1.0" as const;

export type ConversationMessageQueueSchemaVersionV1 =
  typeof CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION;

export const CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE = Object.freeze({
  ALL: "all",
} as const);

export type ConversationMessageQueueTargetParticipantModeV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE)[keyof typeof CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE];

export type ConversationMessageQueueTargetParticipantsV1 =
  | ConversationMessageQueueTargetParticipantModeV1
  | string[];

export const CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODES = Object.freeze(
  Object.values(CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE),
) as readonly ConversationMessageQueueTargetParticipantModeV1[];

export const CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID = Object.freeze({
  HUMAN: "human",
} as const);

export type ConversationMessageQueueAuthorPublicIdV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID)[keyof typeof CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID];

export const CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_IDS = Object.freeze(
  Object.values(CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID),
) as readonly ConversationMessageQueueAuthorPublicIdV1[];

export const CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND = Object.freeze({
  USER_MESSAGE: "user-message",
  COMPLETED_AGENT_RESPONSE: "completed-agent-response",
} as const);

export type ConversationMessageQueueQuoteTargetKindV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND)[keyof typeof CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND];

export const CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KINDS = Object.freeze(
  Object.values(CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND),
) as readonly ConversationMessageQueueQuoteTargetKindV1[];

export const CONVERSATION_MESSAGE_QUEUE_DIGEST_DOMAIN = Object.freeze({
  ROOT_MARKER: "VF-CONVERSATION-MESSAGE-QUEUE-ROOT\0v1\0",
  PENDING_MUTATION: "VF-CONVERSATION-MESSAGE-QUEUE-PENDING-MUTATION\0v1\0",
} as const);

export const CONVERSATION_MESSAGE_QUEUE_ROOT_MARKER_FILE = Object.freeze({
  SUFFIX: ".json",
  NAME_PATTERN: /^[0-9a-f]{64}\.json$/,
} as const);

export const conversationMessageQueueRootMarkerFileName = (storageDigest: string): string =>
  `${storageDigest}${CONVERSATION_MESSAGE_QUEUE_ROOT_MARKER_FILE.SUFFIX}`;

export const isConversationMessageQueueRootMarkerFileName = (value: string): boolean =>
  CONVERSATION_MESSAGE_QUEUE_ROOT_MARKER_FILE.NAME_PATTERN.test(value);

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

export const CONVERSATION_MESSAGE_QUEUE_NONTERMINAL_STATES = Object.freeze([
  CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED,
  CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
] as const);

export type ConversationMessageQueueNonterminalStateV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_NONTERMINAL_STATES)[number];

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
  UNAUTHENTICATED: PUBLIC_ERROR_CODE.UNAUTHENTICATED,
  FORBIDDEN: PUBLIC_ERROR_CODE.FORBIDDEN,
  NOT_FOUND: PUBLIC_ERROR_CODE.NOT_FOUND,
  REQUEST_TOO_LARGE: "request_too_large",
  AUTHORITY_CORRUPT: PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT,
  QUEUE_FULL: "queue_full",
  RATE_LIMITED: PUBLIC_ERROR_CODE.RATE_LIMITED,
  INVALID_REQUEST: PUBLIC_ERROR_CODE.INVALID_REQUEST,
  SERVICE_UNAVAILABLE: PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
  IDEMPOTENCY_CONFLICT: PUBLIC_ERROR_CODE.IDEMPOTENCY_CONFLICT,
  PRIVATE_CONTEXT_CONFLICT: "private_context_conflict",
  QUEUED_MESSAGE_NOT_EDITABLE: "queued_message_not_editable",
  STALE_QUEUED_MESSAGE: "stale_queued_message",
  QUEUE_CLAIM_BUSY: "queue_claim_busy",
  NOT_LINEAGE_HEAD: PUBLIC_ERROR_CODE.NOT_LINEAGE_HEAD,
  QUEUE_AUTHORITY_CORRUPT: "conversation_message_queue_corrupt",
} as const);

export type ConversationMessageQueueErrorCodeV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_ERROR_CODE)[keyof typeof CONVERSATION_MESSAGE_QUEUE_ERROR_CODE];

export const CONVERSATION_MESSAGE_QUEUE_ERROR_CODES = Object.freeze(
  Object.values(CONVERSATION_MESSAGE_QUEUE_ERROR_CODE),
) as readonly ConversationMessageQueueErrorCodeV1[];

export const CONVERSATION_MESSAGE_QUEUE_INTERNAL_ERROR_CODES = Object.freeze([
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT,
] as const);

export type ConversationMessageQueueInternalErrorCodeV1 =
  (typeof CONVERSATION_MESSAGE_QUEUE_INTERNAL_ERROR_CODES)[number];

export type ConversationMessageQueuePublicErrorCodeV1 = Exclude<
  ConversationMessageQueueErrorCodeV1,
  ConversationMessageQueueInternalErrorCodeV1
>;

export const CONVERSATION_MESSAGE_QUEUE_PUBLIC_ERROR_CODES = Object.freeze([
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.UNAUTHENTICATED,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.FORBIDDEN,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_FOUND,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.AUTHORITY_CORRUPT,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.SERVICE_UNAVAILABLE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_LINEAGE_HEAD,
] as const satisfies readonly ConversationMessageQueuePublicErrorCodeV1[]);

export const CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION = Object.freeze({
  EDIT: PUBLIC_RECOVERY_ACTION.EDIT,
  RETRY: PUBLIC_RECOVERY_ACTION.RETRY,
  SEND_AS_NEW: "send-as-new",
  REPAIR_AUTHORITY: PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
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
  maxRecoveryFaults: 32,
  maxReferenceBytes: 512,
} as const);

export interface ConversationMessageQueueRecoveryFaultV1 {
  readonly marker_name: string;
  readonly error_code: typeof CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT;
}

export interface ConversationMessageQueueRecoveryReportV1 {
  readonly schema_version: ConversationMessageQueueSchemaVersionV1;
  readonly recovered_root_count: number;
  readonly observed_fault_count: number;
  readonly faults_truncated: boolean;
  readonly faults: readonly ConversationMessageQueueRecoveryFaultV1[];
}

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isConversationMessageQueueTargetParticipantMode = (
  value: unknown,
): value is ConversationMessageQueueTargetParticipantModeV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODES, value);

export const isConversationMessageQueueAuthorPublicId = (
  value: unknown,
): value is ConversationMessageQueueAuthorPublicIdV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_IDS, value);

export const isConversationMessageQueueQuoteTargetKind = (
  value: unknown,
): value is ConversationMessageQueueQuoteTargetKindV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KINDS, value);

export const isConversationMessageQueueState = (
  value: unknown,
): value is ConversationMessageQueueStateV1 => memberOf(CONVERSATION_MESSAGE_QUEUE_STATES, value);

export const isConversationMessageQueueNonterminalState = (
  value: unknown,
): value is ConversationMessageQueueNonterminalStateV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_NONTERMINAL_STATES, value);

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

export const isConversationMessageQueuePublicErrorCode = (
  value: unknown,
): value is ConversationMessageQueuePublicErrorCodeV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_PUBLIC_ERROR_CODES, value);

export const isConversationMessageQueueInternalErrorCode = (
  value: unknown,
): value is ConversationMessageQueueInternalErrorCodeV1 =>
  memberOf(CONVERSATION_MESSAGE_QUEUE_INTERNAL_ERROR_CODES, value);
