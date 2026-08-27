import type {
  ConversationPrivateContextBrokerSchemaVersionV1,
  ConversationPrivateContextDiscardNamespaceV1,
  ConversationPrivateContextDraftStageStateV1,
  ConversationPrivateContextMessageStageStateV1,
  ConversationPrivateContextSourceKindV1,
} from "./conversation-private-context-broker-contract.js";
import type { ConversationHomeCreateWireRequestV1 } from "./conversation-private-context-broker-wire.js";
import type { ConversationCreateParticipant } from "./types.js";

export type {
  DiscardConversationDraftPrivateContextRequestV1,
  DiscardConversationMessagePrivateContextRequestV1,
  PublicConversationPrivateContextPresenceV1,
  StageConversationDraftPrivateContextRequestV1,
  StageConversationMessagePrivateContextRequestV1,
} from "./conversation-private-context-broker-wire.js";

export type ConversationHomeCreateRequestV1 =
  ConversationHomeCreateWireRequestV1<ConversationCreateParticipant>;

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
