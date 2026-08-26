import { validateIdempotencyKey } from "../../actions/idempotency.js";
import { queueExactKeys, queueRecord } from "./conversation-message-queue-validation.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT,
  CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD,
  type ConversationPrivateContextBrokerErrorCodeV1,
  type ConversationPrivateContextStageIdempotencyFieldV1,
  isConversationPrivateContextBrokerErrorCode,
  isConversationPrivateContextBrokerSchemaVersion,
  isConversationPrivateContextCreateEngine,
  isConversationPrivateContextCreateHostTool,
  isConversationPrivateContextDigest,
  isConversationPrivateContextDraftStageState,
  isConversationPrivateContextMessageStageState,
  isConversationPrivateContextQueueItemId,
  isConversationPrivateContextSourceKind,
  isConversationPrivateContextSourceRecordRef,
} from "./conversation-private-context-broker-contract.js";
import { CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS } from "./conversation-private-context-broker-fields.js";
import {
  draftStageRecordDigest,
  messageStageRecordDigest,
} from "./conversation-private-context-broker-records.js";
import type {
  ConversationHomeCreateRequestV1,
  DiscardConversationDraftPrivateContextRequestV1,
  DiscardConversationMessagePrivateContextRequestV1,
  PrivateConversationDraftContextStageV1,
  PrivateConversationMessageContextStageV1,
  StageConversationDraftPrivateContextRequestV1,
  StageConversationMessagePrivateContextRequestV1,
} from "./conversation-private-context-broker-types.js";

export class ConversationPrivateContextBrokerConflictError extends Error {
  constructor(
    readonly code: ConversationPrivateContextBrokerErrorCodeV1,
    message: string,
    readonly privateContextPresent = false,
    readonly queueOwned = false,
  ) {
    super(message);
    if (!isConversationPrivateContextBrokerErrorCode(code))
      throw new Error("invalid private context broker conflict code");
  }
}

function validPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFC") === value &&
    Buffer.byteLength(value, "utf8") >=
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.minRepoRelativePathBytes &&
    Buffer.byteLength(value, "utf8") <=
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRepoRelativePathBytes &&
    !/[\\\0]/u.test(value) &&
    !value.startsWith("/") &&
    !value.startsWith("~") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

function validRange(start: unknown, end: unknown): start is number {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    (start as number) >= CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.minFileLine &&
    (end as number) >= (start as number) &&
    (end as number) - (start as number) + 1 <=
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFileRangeLines
  );
}

function stage(value: unknown, key: ConversationPrivateContextStageIdempotencyFieldV1): void {
  const fields =
    key === CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.MESSAGE
      ? CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.MESSAGE_STAGE_REQUEST
      : CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DRAFT_STAGE_REQUEST;
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, fields) ||
    !isConversationPrivateContextBrokerSchemaVersion(value.schema_version) ||
    !isConversationPrivateContextSourceKind(value.source_kind) ||
    !validPath(value.repo_relative_path) ||
    !validRange(value.start_line, value.end_line)
  )
    throw new Error("invalid private context stage request");
  validateIdempotencyKey(value[key]);
}

function discard(value: unknown, key: ConversationPrivateContextStageIdempotencyFieldV1): void {
  const fields =
    key === CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.MESSAGE
      ? CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.MESSAGE_DISCARD_REQUEST
      : CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DRAFT_DISCARD_REQUEST;
  if (
    !queueRecord(value) ||
    !queueExactKeys(value, fields) ||
    !isConversationPrivateContextBrokerSchemaVersion(value.schema_version) ||
    value.expected_private_context_present !== CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT
  )
    throw new Error("invalid private context discard request");
  validateIdempotencyKey(value.idempotency_key);
  validateIdempotencyKey(value[key]);
  if (value.idempotency_key === value[key])
    throw new Error("private context discard key must be distinct");
}

export function assertStageConversationMessagePrivateContextRequestV1(
  value: unknown,
): asserts value is StageConversationMessagePrivateContextRequestV1 {
  stage(value, CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.MESSAGE);
}

export function assertDiscardConversationMessagePrivateContextRequestV1(
  value: unknown,
): asserts value is DiscardConversationMessagePrivateContextRequestV1 {
  discard(value, CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.MESSAGE);
}

export function assertStageConversationDraftPrivateContextRequestV1(
  value: unknown,
): asserts value is StageConversationDraftPrivateContextRequestV1 {
  stage(value, CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.DRAFT);
}

export function assertDiscardConversationDraftPrivateContextRequestV1(
  value: unknown,
): asserts value is DiscardConversationDraftPrivateContextRequestV1 {
  discard(value, CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.DRAFT);
}

export function assertConversationHomeCreateRequestV1(
  value: unknown,
): asserts value is ConversationHomeCreateRequestV1 {
  if (!queueRecord(value)) throw new Error("invalid Home create request");
  const keys = Object.keys(value);
  const hasField = (fields: readonly string[], key: string): boolean => fields.includes(key);
  if (
    CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.HOME_CREATE_REQUIRED.some(
      (key) => !Object.hasOwn(value, key),
    ) ||
    keys.some(
      (key) =>
        !hasField(CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.HOME_CREATE_REQUIRED, key) &&
        !hasField(CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.HOME_CREATE_OPTIONAL, key),
    ) ||
    !isConversationPrivateContextBrokerSchemaVersion(value.schema_version) ||
    typeof value.topic !== "string" ||
    value.topic.normalize("NFC") !== value.topic ||
    !value.topic.trim() ||
    Buffer.byteLength(value.topic, "utf8") >
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxTopicBytes ||
    typeof value.private_context_present !== "boolean"
  )
    throw new Error("invalid Home create request");
  validateIdempotencyKey(value.idempotency_key);
  if (
    (value.policy !== undefined &&
      (typeof value.policy !== "string" ||
        !value.policy.trim() ||
        value.policy.normalize("NFC") !== value.policy ||
        Buffer.byteLength(value.policy, "utf8") >
          CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxPolicyBytes)) ||
    (value.max_rounds !== undefined &&
      (!Number.isSafeInteger(value.max_rounds) ||
        (value.max_rounds as number) < CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.minRounds ||
        (value.max_rounds as number) > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRounds))
  )
    throw new Error("invalid Home create options");
  if (value.participants === undefined) return;
  if (
    !Array.isArray(value.participants) ||
    value.participants.length < CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.minParticipants ||
    value.participants.length > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxParticipants
  )
    throw new Error("invalid Home create participants");
  for (const candidate of value.participants) {
    if (
      !queueRecord(candidate) ||
      Object.keys(candidate).some(
        (key) => !hasField(CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.HOME_CREATE_PARTICIPANT, key),
      ) ||
      !Object.hasOwn(candidate, "role_ref") ||
      !Object.hasOwn(candidate, "engine") ||
      typeof candidate.role_ref !== "string" ||
      !candidate.role_ref.trim() ||
      candidate.role_ref.normalize("NFC") !== candidate.role_ref ||
      Buffer.byteLength(candidate.role_ref, "utf8") >
        CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxParticipantRoleRefBytes ||
      !isConversationPrivateContextCreateEngine(candidate.engine) ||
      (candidate.model !== undefined &&
        (typeof candidate.model !== "string" ||
          !candidate.model.trim() ||
          candidate.model.normalize("NFC") !== candidate.model ||
          Buffer.byteLength(candidate.model, "utf8") >
            CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxParticipantModelBytes)) ||
      (candidate.host_tools !== undefined &&
        (!Array.isArray(candidate.host_tools) ||
          candidate.host_tools.length >
            CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxParticipantHostTools ||
          new Set(candidate.host_tools).size !== candidate.host_tools.length ||
          candidate.host_tools.some((tool) => !isConversationPrivateContextCreateHostTool(tool))))
    )
      throw new Error("invalid Home create participant");
  }
}

function exactStageCommon(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    queueExactKeys(value, fields) &&
    isConversationPrivateContextBrokerSchemaVersion(value.schema_version) &&
    isConversationPrivateContextDigest(value.owner_principal_digest) &&
    isConversationPrivateContextDigest(value.canonical_request_digest) &&
    isConversationPrivateContextSourceKind(value.source_kind) &&
    isConversationPrivateContextSourceRecordRef(value.source_record_ref) &&
    isConversationPrivateContextDigest(value.source_record_digest) &&
    Number.isSafeInteger(value.stage_sequence) &&
    (value.stage_sequence as number) >=
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.genesisStageSequence &&
    ((value.stage_sequence === CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.genesisStageSequence &&
      value.previous_record_digest === null) ||
      ((value.stage_sequence as number) >
        CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.genesisStageSequence &&
        isConversationPrivateContextDigest(value.previous_record_digest))) &&
    typeof value.staged_at === "string" &&
    !Number.isNaN(Date.parse(value.staged_at)) &&
    typeof value.updated_at === "string" &&
    !Number.isNaN(Date.parse(value.updated_at)) &&
    Date.parse(value.updated_at) >= Date.parse(value.staged_at) &&
    isConversationPrivateContextDigest(value.record_digest)
  );
}

export function assertPrivateConversationMessageContextStageV1(
  value: unknown,
): asserts value is PrivateConversationMessageContextStageV1 {
  if (
    !queueRecord(value) ||
    !exactStageCommon(value, CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.MESSAGE_STAGE)
  )
    throw new Error("invalid message private context stage");
  if (!isConversationPrivateContextMessageStageState(value.stage_state))
    throw new Error("invalid message private context stage state");
  const terminalNull =
    value.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE ||
    value.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.DISCARDED;
  const owned =
    value.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED ||
    value.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.CONSUMED ||
    value.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.RELEASED;
  if (
    typeof value.root_session_id !== "string" ||
    !value.root_session_id ||
    !isConversationPrivateContextDigest(value.enqueue_idempotency_key_digest) ||
    !isConversationPrivateContextDigest(value.staged_authority_digest) ||
    (!terminalNull && !owned) ||
    (terminalNull &&
      (value.queue_item_id !== null || value.private_context_binding_digest !== null)) ||
    (owned &&
      (!isConversationPrivateContextQueueItemId(value.queue_item_id) ||
        !isConversationPrivateContextDigest(value.private_context_binding_digest)))
  )
    throw new Error("invalid message private context stage state");
  const typed = value as unknown as PrivateConversationMessageContextStageV1;
  const { record_digest: _digest, ...preimage } = typed;
  if (messageStageRecordDigest(preimage) !== typed.record_digest)
    throw new Error("message private context stage digest changed");
}

export function assertPrivateConversationDraftContextStageV1(
  value: unknown,
): asserts value is PrivateConversationDraftContextStageV1 {
  if (
    !queueRecord(value) ||
    !exactStageCommon(value, CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DRAFT_STAGE)
  )
    throw new Error("invalid draft private context stage");
  if (!isConversationPrivateContextDraftStageState(value.stage_state))
    throw new Error("invalid draft private context stage state");
  const terminalNull =
    value.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE ||
    value.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.DISCARDED;
  const owned =
    value.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED ||
    value.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.CONSUMED;
  const allocated = [
    value.allocated_root_session_id,
    value.allocated_conversation_id,
    value.allocated_revision_id,
  ];
  if (
    !isConversationPrivateContextDigest(value.create_idempotency_key_digest) ||
    (!terminalNull && !owned) ||
    (terminalNull &&
      (allocated.some((item) => item !== null) || value.initial_turn_context_digest !== null)) ||
    (owned &&
      (allocated.some((item) => typeof item !== "string" || !item) ||
        !isConversationPrivateContextDigest(value.initial_turn_context_digest)))
  )
    throw new Error("invalid draft private context stage state");
  const typed = value as unknown as PrivateConversationDraftContextStageV1;
  const { record_digest: _digest, ...preimage } = typed;
  if (draftStageRecordDigest(preimage) !== typed.record_digest)
    throw new Error("draft private context stage digest changed");
}
