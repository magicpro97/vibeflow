import type {
  ConversationPrivateContextBrokerSchemaVersionV1,
  ConversationPrivateContextDiscardNamespaceV1,
  ConversationPrivateContextDraftStageStateV1,
  ConversationPrivateContextMessageStageStateV1,
  ConversationPrivateContextSourceKindV1,
} from "./conversation-private-context-broker-contract.js";
import type { ConversationCreateParticipant } from "./types.js";

export interface PublicConversationPrivateContextPresenceV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  private_context_present: boolean;
}

export interface StageConversationMessagePrivateContextRequestV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  enqueue_idempotency_key: string;
  source_kind: ConversationPrivateContextSourceKindV1;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
}

export interface DiscardConversationMessagePrivateContextRequestV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  idempotency_key: string;
  enqueue_idempotency_key: string;
  expected_private_context_present: true;
}

export interface StageConversationDraftPrivateContextRequestV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  create_idempotency_key: string;
  source_kind: ConversationPrivateContextSourceKindV1;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
}

export interface DiscardConversationDraftPrivateContextRequestV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  idempotency_key: string;
  create_idempotency_key: string;
  expected_private_context_present: true;
}

export interface ConversationHomeCreateRequestV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  idempotency_key: string;
  topic: string;
  policy?: string;
  participants?: ConversationCreateParticipant[];
  max_rounds?: number;
  private_context_present: boolean;
}

export interface PrivateConversationMessageContextStageV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  owner_principal_digest: string;
  root_session_id: string;
  enqueue_idempotency_key_digest: string;
  staged_authority_digest: string;
  canonical_request_digest: string;
  source_kind: ConversationPrivateContextSourceKindV1;
  source_record_ref: string;
  source_record_digest: string;
  stage_sequence: number;
  previous_record_digest: string | null;
  staged_at: string;
  updated_at: string;
  record_digest: string;
  stage_state: ConversationPrivateContextMessageStageStateV1;
  queue_item_id: string | null;
  private_context_binding_digest: string | null;
}

export interface PrivateConversationDraftContextStageV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  owner_principal_digest: string;
  create_idempotency_key_digest: string;
  canonical_request_digest: string;
  source_kind: ConversationPrivateContextSourceKindV1;
  source_record_ref: string;
  source_record_digest: string;
  stage_sequence: number;
  previous_record_digest: string | null;
  staged_at: string;
  updated_at: string;
  record_digest: string;
  stage_state: ConversationPrivateContextDraftStageStateV1;
  allocated_root_session_id: string | null;
  allocated_conversation_id: string | null;
  allocated_revision_id: string | null;
  initial_turn_context_digest: string | null;
}

export interface PrivateConversationContextDiscardBindingV1 {
  schema_version: ConversationPrivateContextBrokerSchemaVersionV1;
  namespace: ConversationPrivateContextDiscardNamespaceV1;
  owner_principal_digest: string;
  root_session_id: string | null;
  idempotency_key_digest: string;
  selected_key_digest: string;
  canonical_request_digest: string;
  binding_digest: string;
}
