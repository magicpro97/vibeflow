import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "./conversation-message-queue-contract.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITIONS,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KINDS,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_KINDS,
  type ConversationPrivateContextBrokerSchemaVersionV1,
  type ConversationPrivateContextQueueDispositionV1,
  type ConversationPrivateContextSourceKindV1,
  type ConversationPrivateContextStageKindV1,
} from "./conversation-private-context-broker-wire.js";
export {
  CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINE,
  CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINES,
  CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOL,
  CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOLS,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_KINDS,
  isConversationPrivateContextCreateEngine,
  isConversationPrivateContextCreateHostTool,
} from "./conversation-private-context-broker-wire.js";
export type {
  ConversationPrivateContextCreateEngineV1,
  ConversationPrivateContextCreateHostToolV1,
  ConversationPrivateContextStageKindV1,
} from "./conversation-private-context-broker-wire.js";
import {
  PRIVATE_FILE_RANGE_MAX_FRAMES,
  PRIVATE_FILE_RANGE_STAGING_IDENTIFIER_PREFIX,
  PRIVATE_FILE_RANGE_STAGING_PATTERN,
} from "./private-file-range-staging-contract.js";
export {
  PRIVATE_FILE_RANGE_STAGING_STATE as CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE,
  PRIVATE_FILE_RANGE_STAGING_STATES as CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATES,
  isPrivateFileRangeStagingState as isConversationPrivateContextSourceFrameState,
} from "./private-file-range-staging-contract.js";
export type { PrivateFileRangeStagingStateV1 as ConversationPrivateContextSourceFrameStateV1 } from "./private-file-range-staging-contract.js";

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND = Object.freeze({
  MESSAGE_STAGE: "message-stage",
  DRAFT_STAGE: "draft-stage",
  DISCARD_BINDING: "discard-binding",
} as const);

export type ConversationPrivateContextBrokerRecordKindV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND];

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KINDS = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND),
) as readonly ConversationPrivateContextBrokerRecordKindV1[];

export const CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE = Object.freeze({
  AVAILABLE: "available",
  ADMISSION_OWNED: "admission-owned",
  CONSUMED: CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION.CONSUMED,
  RELEASED: CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION.RELEASED,
  DISCARDED: "discarded",
} as const);

export type ConversationPrivateContextMessageStageStateV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE];

export const CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATES = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE),
) as readonly ConversationPrivateContextMessageStageStateV1[];

export const CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE = Object.freeze({
  AVAILABLE: CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE,
  TRANSFER_OWNED: "transfer-owned",
  CONSUMED: CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.CONSUMED,
  DISCARDED: CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.DISCARDED,
} as const);

export type ConversationPrivateContextDraftStageStateV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE];

export const CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATES = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE),
) as readonly ConversationPrivateContextDraftStageStateV1[];

export const CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE =
  CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND;

export type ConversationPrivateContextDiscardNamespaceV1 = ConversationPrivateContextStageKindV1;

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE = Object.freeze({
  IDEMPOTENCY_CONFLICT: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT,
  PRIVATE_CONTEXT_CONFLICT: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
  RATE_LIMITED: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED,
} as const);

export type ConversationPrivateContextBrokerErrorCodeV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE];

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODES = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE),
) as readonly ConversationPrivateContextBrokerErrorCodeV1[];

export const CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME = Object.freeze({
  DELIVERED: CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED,
  STALE: CONVERSATION_MESSAGE_QUEUE_STATE.STALE,
} as const);

export type ConversationPrivateContextQueueOutcomeV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME];

export const CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOMES = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME),
) as readonly ConversationPrivateContextQueueOutcomeV1[];

export const CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT = Object.freeze({
  AFTER_PRIVATE_SOURCE_STAGE: "after-private-source-stage",
} as const);

export type ConversationPrivateContextFaultPointV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT];

export const CONVERSATION_PRIVATE_CONTEXT_FAULT_POINTS = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT),
) as readonly ConversationPrivateContextFaultPointV1[];

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS = Object.freeze({
  maxPendingContexts: 32,
  maxRecordBytes: 512 * 1_024,
  maxStageRecords: PRIVATE_FILE_RANGE_MAX_FRAMES,
  queueAdmissionRequiredFrameHeadroom: 2,
  genesisStageSequence: 0,
  minRepoRelativePathBytes: 1,
  maxRepoRelativePathBytes: 4_096,
  minFileLine: 1,
  maxFileRangeLines: 200,
  maxTopicBytes: 32 * 1_024,
  maxPolicyBytes: 256,
  minRounds: 1,
  maxRounds: 100,
  minParticipants: 1,
  maxParticipants: 64,
  maxParticipantRoleRefBytes: 256,
  maxParticipantModelBytes: 256,
  maxParticipantHostTools: 1,
} as const);

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_PATTERN = Object.freeze({
  digest: Object.freeze(/^sha256:[0-9a-f]{64}$/u),
  queueItem: Object.freeze(/^vf-queued-message-[0-9a-f]{64}$/u),
  sourceRecordRef: PRIVATE_FILE_RANGE_STAGING_PATTERN.HANDOFF_ID,
  storageKey: Object.freeze(/^[0-9a-f]{64}$/u),
} as const);

export const CONVERSATION_PRIVATE_CONTEXT_STORAGE = Object.freeze({
  ROOT_DIRECTORY: "conversation-private-context",
  LAYOUT_VERSION: "v1",
  MESSAGE_STAGES_DIRECTORY: "message-stages",
  DRAFT_STAGES_DIRECTORY: "draft-stages",
  DISCARD_IDEMPOTENCY_DIRECTORY: "discard-idempotency",
  EVENTS_DIRECTORY: "events",
  CURRENT_FILE: "current.json",
  WRITER_LOCK_FILE: "writer.lock",
} as const);

export const CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX = Object.freeze({
  SOURCE: PRIVATE_FILE_RANGE_STAGING_IDENTIFIER_PREFIX,
  CONVERSATION: "conversation",
  REVISION: "revision",
  WORKFLOW: "workflow",
  RUN: "run",
  OPERATION: "vf-operation",
} as const);

export const CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND = Object.freeze({
  MESSAGE_QUEUE: "message-queue-private",
  CONVERSATION_CREATE: "conversation-create",
  DISCARD: "discard",
} as const);

export const CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND = Object.freeze({
  QUEUE: "queue",
  DISCARDED: CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.DISCARDED,
  CONVERSATION: "conversation",
} as const);

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN = Object.freeze({
  PRINCIPAL_KEY: "VF-CONVERSATION-DRAFT-PRIVATE-CONTEXT-PRINCIPAL-KEY\0v1\0",
  MESSAGE_STAGE_KEY: "VF-CONVERSATION-MESSAGE-PRIVATE-CONTEXT-STAGE-KEY\0v1\0",
  DRAFT_STAGE_KEY: "VF-CONVERSATION-DRAFT-PRIVATE-CONTEXT-STAGE-KEY\0v1\0",
  CREATE_IDEMPOTENCY: "VF-CONVERSATION-CREATE-IDEMPOTENCY\0v1\0",
  DISCARD_IDEMPOTENCY: "VF-CONVERSATION-PRIVATE-CONTEXT-DISCARD-IDEMPOTENCY\0v1\0",
  MESSAGE_STAGE_REQUEST: "VF-CONVERSATION-MESSAGE-PRIVATE-CONTEXT-STAGE-REQUEST\0v1\0",
  DRAFT_STAGE_REQUEST: "VF-CONVERSATION-DRAFT-PRIVATE-CONTEXT-STAGE-REQUEST\0v1\0",
  MESSAGE_STAGE_RECORD: "VF-CONVERSATION-MESSAGE-PRIVATE-CONTEXT-STAGE\0v1\0",
  DRAFT_STAGE_RECORD: "VF-CONVERSATION-DRAFT-PRIVATE-CONTEXT-STAGE\0v1\0",
  SOURCE_ID: "VF-CONVERSATION-PRIVATE-CONTEXT-SOURCE-ID\0v1\0",
  HOME_CREATE_ALLOCATION: "VF-CONVERSATION-HOME-CREATE-ALLOCATION\0v1\0",
  ROOT_KEY: "VF-CONVERSATION-PRIVATE-CONTEXT-ROOT-KEY\0v1\0",
  SOURCE_AUTHORITY: "VF-CONVERSATION-PRIVATE-CONTEXT-SOURCE-AUTHORITY\0v1\0",
  DISCARD_BINDING: "VF-CONVERSATION-PRIVATE-CONTEXT-DISCARD-BINDING\0v1\0",
  DISCARD_FILE_KEY: "VF-CONVERSATION-PRIVATE-CONTEXT-DISCARD-FILE-KEY\0v1\0",
  MESSAGE_DISCARD_REQUEST: "VF-CONVERSATION-MESSAGE-PRIVATE-CONTEXT-DISCARD-REQUEST\0v1\0",
  DRAFT_DISCARD_REQUEST: "VF-CONVERSATION-DRAFT-PRIVATE-CONTEXT-DISCARD-REQUEST\0v1\0",
} as const);

export const CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITION = Object.freeze({
  AVAILABLE_TO_ADMISSION_OWNED: "available->admission-owned",
  ADMISSION_OWNED_TO_AVAILABLE: "admission-owned->available",
  ADMISSION_OWNED_TO_CONSUMED: "admission-owned->consumed",
  ADMISSION_OWNED_TO_RELEASED: "admission-owned->released",
  AVAILABLE_TO_DISCARDED: "available->discarded",
} as const);

export type ConversationPrivateContextMessageStageTransitionV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITION)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITION];

export const CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITIONS = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITION),
) as readonly ConversationPrivateContextMessageStageTransitionV1[];

export const CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITION = Object.freeze({
  AVAILABLE_TO_TRANSFER_OWNED: "available->transfer-owned",
  TRANSFER_OWNED_TO_CONSUMED: "transfer-owned->consumed",
  AVAILABLE_TO_DISCARDED:
    CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITION.AVAILABLE_TO_DISCARDED,
} as const);

export type ConversationPrivateContextDraftStageTransitionV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITION)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITION];

export const CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITIONS = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITION),
) as readonly ConversationPrivateContextDraftStageTransitionV1[];

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isConversationPrivateContextBrokerSchemaVersion = (
  value: unknown,
): value is ConversationPrivateContextBrokerSchemaVersionV1 =>
  value === CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION;

export const isConversationPrivateContextSourceKind = (
  value: unknown,
): value is ConversationPrivateContextSourceKindV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_SOURCE_KINDS, value);

export const isConversationPrivateContextBrokerRecordKind = (
  value: unknown,
): value is ConversationPrivateContextBrokerRecordKindV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KINDS, value);

export const isConversationPrivateContextMessageStageState = (
  value: unknown,
): value is ConversationPrivateContextMessageStageStateV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATES, value);

export const isConversationPrivateContextDraftStageState = (
  value: unknown,
): value is ConversationPrivateContextDraftStageStateV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATES, value);

export const isConversationPrivateContextDiscardNamespace = (
  value: unknown,
): value is ConversationPrivateContextDiscardNamespaceV1 =>
  memberOf(Object.values(CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE), value);

export const isConversationPrivateContextStageKind = (
  value: unknown,
): value is ConversationPrivateContextStageKindV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_STAGE_KINDS, value);

export const isConversationPrivateContextBrokerErrorCode = (
  value: unknown,
): value is ConversationPrivateContextBrokerErrorCodeV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODES, value);

export const isConversationPrivateContextQueueOutcome = (
  value: unknown,
): value is ConversationPrivateContextQueueOutcomeV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOMES, value);

export const isConversationPrivateContextQueueDisposition = (
  value: unknown,
): value is ConversationPrivateContextQueueDispositionV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITIONS, value);

export const isConversationPrivateContextFaultPoint = (
  value: unknown,
): value is ConversationPrivateContextFaultPointV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_FAULT_POINTS, value);

export const isConversationPrivateContextMessageStageTransition = (
  value: unknown,
): value is ConversationPrivateContextMessageStageTransitionV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITIONS, value);

export const isConversationPrivateContextDraftStageTransition = (
  value: unknown,
): value is ConversationPrivateContextDraftStageTransitionV1 =>
  memberOf(CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITIONS, value);

export const isConversationPrivateContextDigest = (value: unknown): value is string =>
  typeof value === "string" && CONVERSATION_PRIVATE_CONTEXT_BROKER_PATTERN.digest.test(value);

export const isConversationPrivateContextQueueItemId = (value: unknown): value is string =>
  typeof value === "string" && CONVERSATION_PRIVATE_CONTEXT_BROKER_PATTERN.queueItem.test(value);

export const isConversationPrivateContextSourceRecordRef = (value: unknown): value is string =>
  typeof value === "string" &&
  CONVERSATION_PRIVATE_CONTEXT_BROKER_PATTERN.sourceRecordRef.test(value);

export {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITIONS,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_BINDING_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KINDS,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD,
  CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD,
  type ConversationHomeCreateParticipantWireV1,
  type ConversationHomeCreateWireRequestV1,
  type ConversationPrivateRangeSelectionV1,
  type ConversationPrivateContextBrokerSchemaVersionV1,
  type ConversationPrivateContextQueueDispositionV1,
  type ConversationPrivateContextSourceKindV1,
  type ConversationPrivateContextStageIdempotencyFieldV1,
  type ConversationPrivateContextWireFieldV1,
  type DiscardConversationDraftPrivateContextRequestV1,
  type DiscardConversationMessagePrivateContextRequestV1,
  type PublicConversationPrivateContextPresenceV1,
  type StageConversationDraftPrivateContextRequestV1,
  type StageConversationMessagePrivateContextRequestV1,
} from "./conversation-private-context-broker-wire.js";
