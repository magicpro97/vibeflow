import {
  AGENT_ENGINE,
  AGENT_HOST_TOOL,
  AGENT_HOST_TOOLS,
  type AgentHostToolV1,
  ENGINES,
  type Engine,
  isAgentEngine,
  isAgentHostTool,
} from "../../core/agent-contract.js";

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION = "1.0" as const;
export const CONVERSATION_PRIVATE_CONTEXT_SOURCE_BINDING_SCHEMA_VERSION =
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION;
export const CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT = true as const;

export const CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINE = AGENT_ENGINE;

export type ConversationPrivateContextCreateEngineV1 = Engine;

export const CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINES = ENGINES;

export const CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOL = AGENT_HOST_TOOL;

export type ConversationPrivateContextCreateHostToolV1 = AgentHostToolV1;

export const CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOLS = AGENT_HOST_TOOLS;

export const isConversationPrivateContextCreateEngine = isAgentEngine;
export const isConversationPrivateContextCreateHostTool = isAgentHostTool;

export type ConversationPrivateContextBrokerSchemaVersionV1 =
  typeof CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION;

export const CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND = Object.freeze({
  PRIVATE_FILE_RANGE: "private-file-range",
} as const);

export type ConversationPrivateContextSourceKindV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND];

export const CONVERSATION_PRIVATE_CONTEXT_SOURCE_KINDS = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND),
) as readonly ConversationPrivateContextSourceKindV1[];

export const CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND = Object.freeze({
  MESSAGE: "message",
  DRAFT: "draft",
} as const);

export type ConversationPrivateContextStageKindV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND];

export const CONVERSATION_PRIVATE_CONTEXT_STAGE_KINDS = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND),
) as readonly ConversationPrivateContextStageKindV1[];

export const CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION = Object.freeze({
  CONSUMED: "consumed",
  RELEASED: "released",
} as const);

export type ConversationPrivateContextQueueDispositionV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION];

export const CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITIONS = Object.freeze(
  Object.values(CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION),
) as readonly ConversationPrivateContextQueueDispositionV1[];

export interface PublicConversationPrivateContextPresenceV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  private_context_present: boolean;
}

export interface ConversationPrivateRangeSelectionV1 {
  repo_relative_path: string;
  start_line: number;
  end_line: number;
}

export interface StageConversationMessagePrivateContextRequestV1
  extends ConversationPrivateRangeSelectionV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  enqueue_idempotency_key: string;
  source_kind: ConversationPrivateContextSourceKindV1;
}

export interface DiscardConversationMessagePrivateContextRequestV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  idempotency_key: string;
  enqueue_idempotency_key: string;
  expected_private_context_present: typeof CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT;
}

export interface StageConversationDraftPrivateContextRequestV1
  extends ConversationPrivateRangeSelectionV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  create_idempotency_key: string;
  source_kind: ConversationPrivateContextSourceKindV1;
}

export interface DiscardConversationDraftPrivateContextRequestV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  idempotency_key: string;
  create_idempotency_key: string;
  expected_private_context_present: typeof CONVERSATION_PRIVATE_CONTEXT_EXPECTED_PRESENT;
}

export interface ConversationHomeCreateParticipantWireV1 {
  role_ref: string;
  engine: ConversationPrivateContextCreateEngineV1;
  model?: string;
  host_tools?: ConversationPrivateContextCreateHostToolV1[];
}

export interface ConversationHomeCreateWireRequestV1<
  Participant extends
    ConversationHomeCreateParticipantWireV1 = ConversationHomeCreateParticipantWireV1,
> {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  idempotency_key: string;
  topic: string;
  policy?: string;
  participants?: Participant[];
  max_rounds?: number;
  private_context_present: boolean;
}

export const CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD = Object.freeze({
  SCHEMA_VERSION: "schema_version",
  PRIVATE_CONTEXT_PRESENT: "private_context_present",
  EXPECTED_PRIVATE_CONTEXT_PRESENT: "expected_private_context_present",
  ENQUEUE_IDEMPOTENCY_KEY: "enqueue_idempotency_key",
  CREATE_IDEMPOTENCY_KEY: "create_idempotency_key",
  IDEMPOTENCY_KEY: "idempotency_key",
  SOURCE_KIND: "source_kind",
  REPO_RELATIVE_PATH: "repo_relative_path",
  START_LINE: "start_line",
  END_LINE: "end_line",
  TOPIC: "topic",
  POLICY: "policy",
  PARTICIPANTS: "participants",
  MAX_ROUNDS: "max_rounds",
  ROLE_REF: "role_ref",
  ENGINE: "engine",
  MODEL: "model",
  HOST_TOOLS: "host_tools",
  OWNER_PRINCIPAL_DIGEST: "owner_principal_digest",
  ROOT_SESSION_ID: "root_session_id",
  ENQUEUE_IDEMPOTENCY_KEY_DIGEST: "enqueue_idempotency_key_digest",
  CREATE_IDEMPOTENCY_KEY_DIGEST: "create_idempotency_key_digest",
  STAGED_AUTHORITY_DIGEST: "staged_authority_digest",
  CANONICAL_REQUEST_DIGEST: "canonical_request_digest",
  SOURCE_RECORD_REF: "source_record_ref",
  SOURCE_RECORD_DIGEST: "source_record_digest",
  STAGE_SEQUENCE: "stage_sequence",
  PREVIOUS_RECORD_DIGEST: "previous_record_digest",
  STAGED_AT: "staged_at",
  UPDATED_AT: "updated_at",
  STAGE_STATE: "stage_state",
  QUEUE_ITEM_ID: "queue_item_id",
  PRIVATE_CONTEXT_BINDING_DIGEST: "private_context_binding_digest",
  RECORD_DIGEST: "record_digest",
  ALLOCATED_ROOT_SESSION_ID: "allocated_root_session_id",
  ALLOCATED_CONVERSATION_ID: "allocated_conversation_id",
  ALLOCATED_REVISION_ID: "allocated_revision_id",
  INITIAL_TURN_CONTEXT_DIGEST: "initial_turn_context_digest",
  NAMESPACE: "namespace",
  IDEMPOTENCY_KEY_DIGEST: "idempotency_key_digest",
  SELECTED_KEY_DIGEST: "selected_key_digest",
  BINDING_DIGEST: "binding_digest",
} as const);

export type ConversationPrivateContextWireFieldV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD];

export const CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD = Object.freeze({
  MESSAGE: CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD.ENQUEUE_IDEMPOTENCY_KEY,
  DRAFT: CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD.CREATE_IDEMPOTENCY_KEY,
} as const);

export type ConversationPrivateContextStageIdempotencyFieldV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD];

const field = CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD;

const messageStageFields = Object.freeze([
  field.SCHEMA_VERSION,
  field.OWNER_PRINCIPAL_DIGEST,
  field.ROOT_SESSION_ID,
  field.ENQUEUE_IDEMPOTENCY_KEY_DIGEST,
  field.STAGED_AUTHORITY_DIGEST,
  field.CANONICAL_REQUEST_DIGEST,
  field.SOURCE_KIND,
  field.SOURCE_RECORD_REF,
  field.SOURCE_RECORD_DIGEST,
  field.STAGE_SEQUENCE,
  field.PREVIOUS_RECORD_DIGEST,
  field.STAGED_AT,
  field.UPDATED_AT,
  field.STAGE_STATE,
  field.QUEUE_ITEM_ID,
  field.PRIVATE_CONTEXT_BINDING_DIGEST,
  field.RECORD_DIGEST,
] as const);

const draftStageFields = Object.freeze([
  field.SCHEMA_VERSION,
  field.OWNER_PRINCIPAL_DIGEST,
  field.CREATE_IDEMPOTENCY_KEY_DIGEST,
  field.CANONICAL_REQUEST_DIGEST,
  field.SOURCE_KIND,
  field.SOURCE_RECORD_REF,
  field.SOURCE_RECORD_DIGEST,
  field.STAGE_SEQUENCE,
  field.PREVIOUS_RECORD_DIGEST,
  field.STAGED_AT,
  field.UPDATED_AT,
  field.STAGE_STATE,
  field.ALLOCATED_ROOT_SESSION_ID,
  field.ALLOCATED_CONVERSATION_ID,
  field.ALLOCATED_REVISION_ID,
  field.INITIAL_TURN_CONTEXT_DIGEST,
  field.RECORD_DIGEST,
] as const);

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS = Object.freeze({
  PUBLIC_PRESENCE: Object.freeze([
    field.SCHEMA_VERSION,
    field.PRIVATE_CONTEXT_PRESENT,
  ] as const satisfies readonly (keyof PublicConversationPrivateContextPresenceV1)[]),
  MESSAGE_STAGE_REQUEST: Object.freeze([
    field.SCHEMA_VERSION,
    CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.MESSAGE,
    field.SOURCE_KIND,
    field.REPO_RELATIVE_PATH,
    field.START_LINE,
    field.END_LINE,
  ] as const satisfies readonly (keyof StageConversationMessagePrivateContextRequestV1)[]),
  DRAFT_STAGE_REQUEST: Object.freeze([
    field.SCHEMA_VERSION,
    CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.DRAFT,
    field.SOURCE_KIND,
    field.REPO_RELATIVE_PATH,
    field.START_LINE,
    field.END_LINE,
  ] as const satisfies readonly (keyof StageConversationDraftPrivateContextRequestV1)[]),
  MESSAGE_DISCARD_REQUEST: Object.freeze([
    field.SCHEMA_VERSION,
    field.IDEMPOTENCY_KEY,
    CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.MESSAGE,
    field.EXPECTED_PRIVATE_CONTEXT_PRESENT,
  ] as const satisfies readonly (keyof DiscardConversationMessagePrivateContextRequestV1)[]),
  DRAFT_DISCARD_REQUEST: Object.freeze([
    field.SCHEMA_VERSION,
    field.IDEMPOTENCY_KEY,
    CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.DRAFT,
    field.EXPECTED_PRIVATE_CONTEXT_PRESENT,
  ] as const satisfies readonly (keyof DiscardConversationDraftPrivateContextRequestV1)[]),
  HOME_CREATE_REQUIRED: Object.freeze([
    field.SCHEMA_VERSION,
    field.IDEMPOTENCY_KEY,
    field.TOPIC,
    field.PRIVATE_CONTEXT_PRESENT,
  ] as const satisfies readonly (keyof ConversationHomeCreateWireRequestV1)[]),
  HOME_CREATE_OPTIONAL: Object.freeze([
    field.POLICY,
    field.PARTICIPANTS,
    field.MAX_ROUNDS,
  ] as const satisfies readonly (keyof ConversationHomeCreateWireRequestV1)[]),
  HOME_CREATE_PARTICIPANT: Object.freeze([
    field.ROLE_REF,
    field.ENGINE,
    field.MODEL,
    field.HOST_TOOLS,
  ] as const satisfies readonly (keyof ConversationHomeCreateParticipantWireV1)[]),
  MESSAGE_STAGE: messageStageFields,
  DRAFT_STAGE: draftStageFields,
  DISCARD_BINDING: Object.freeze([
    field.SCHEMA_VERSION,
    field.NAMESPACE,
    field.OWNER_PRINCIPAL_DIGEST,
    field.ROOT_SESSION_ID,
    field.IDEMPOTENCY_KEY_DIGEST,
    field.SELECTED_KEY_DIGEST,
    field.CANONICAL_REQUEST_DIGEST,
    field.BINDING_DIGEST,
  ] as const),
} as const);
