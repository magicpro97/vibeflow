export const CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD = Object.freeze({
  MESSAGE: "enqueue_idempotency_key",
  DRAFT: "create_idempotency_key",
} as const);

export type ConversationPrivateContextStageIdempotencyFieldV1 =
  (typeof CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD)[keyof typeof CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD];

const messageStageFields = Object.freeze([
  "schema_version",
  "owner_principal_digest",
  "root_session_id",
  "enqueue_idempotency_key_digest",
  "staged_authority_digest",
  "canonical_request_digest",
  "source_kind",
  "source_record_ref",
  "source_record_digest",
  "stage_sequence",
  "previous_record_digest",
  "staged_at",
  "updated_at",
  "stage_state",
  "queue_item_id",
  "private_context_binding_digest",
  "record_digest",
] as const);

const draftStageFields = Object.freeze([
  "schema_version",
  "owner_principal_digest",
  "create_idempotency_key_digest",
  "canonical_request_digest",
  "source_kind",
  "source_record_ref",
  "source_record_digest",
  "stage_sequence",
  "previous_record_digest",
  "staged_at",
  "updated_at",
  "stage_state",
  "allocated_root_session_id",
  "allocated_conversation_id",
  "allocated_revision_id",
  "initial_turn_context_digest",
  "record_digest",
] as const);

export const CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS = Object.freeze({
  MESSAGE_STAGE_REQUEST: Object.freeze([
    "schema_version",
    CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.MESSAGE,
    "source_kind",
    "repo_relative_path",
    "start_line",
    "end_line",
  ] as const),
  DRAFT_STAGE_REQUEST: Object.freeze([
    "schema_version",
    CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.DRAFT,
    "source_kind",
    "repo_relative_path",
    "start_line",
    "end_line",
  ] as const),
  MESSAGE_DISCARD_REQUEST: Object.freeze([
    "schema_version",
    "idempotency_key",
    CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.MESSAGE,
    "expected_private_context_present",
  ] as const),
  DRAFT_DISCARD_REQUEST: Object.freeze([
    "schema_version",
    "idempotency_key",
    CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.DRAFT,
    "expected_private_context_present",
  ] as const),
  HOME_CREATE_REQUIRED: Object.freeze([
    "schema_version",
    "idempotency_key",
    "topic",
    "private_context_present",
  ] as const),
  HOME_CREATE_OPTIONAL: Object.freeze(["policy", "participants", "max_rounds"] as const),
  HOME_CREATE_PARTICIPANT: Object.freeze(["role_ref", "engine", "model", "host_tools"] as const),
  MESSAGE_STAGE: messageStageFields,
  DRAFT_STAGE: draftStageFields,
  DISCARD_BINDING: Object.freeze([
    "schema_version",
    "namespace",
    "owner_principal_digest",
    "root_session_id",
    "idempotency_key_digest",
    "selected_key_digest",
    "canonical_request_digest",
    "binding_digest",
  ] as const),
} as const);
