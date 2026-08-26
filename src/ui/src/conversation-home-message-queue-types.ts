import type {
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  ConversationMessageQueueSchemaVersionV1,
  ConversationMessageQueueStaleReasonV1,
  ConversationMessageQueueStateV1,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import type { HomeCanonicalQuoteReference } from "./conversation-home-types.js";

export type HomeMessageQueueState = ConversationMessageQueueStateV1;
export type HomeMessageQueueStaleReason = ConversationMessageQueueStaleReasonV1;

export interface HomeEnqueueMessageRequest {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  idempotency_key: string;
  expected_authority_digest: string;
  content: string;
  target_participants: "all" | string[];
  quote_refs: HomeCanonicalQuoteReference[];
  private_context_present: boolean;
}

export interface HomeEditQueuedMessageRequest {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  idempotency_key: string;
  expected_item_digest: string;
  content: string;
}

export interface HomeQueuedMessage {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  queue_item_id: string;
  queue_sequence: number;
  root_session_id: string;
  author_public_id: "human";
  content: string;
  content_digest: string;
  target_participants: "all" | string[];
  quote_refs: HomeCanonicalQuoteReference[];
  private_context_present: boolean;
  predecessor_queue_item_id: string | null;
  admitted_authority_digest: string;
  effective_authority_digest: string;
  state: HomeMessageQueueState;
  stale_reason: HomeMessageQueueStaleReason | null;
  admitted_at: string;
  updated_at: string;
  item_digest: string;
}

export interface HomeMessageQueueSnapshot {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  current_authority_digest: string;
  max_nonterminal_items: typeof CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems;
  items: HomeQueuedMessage[];
}

export interface HomeMessageQueueInvalidation {
  schema_version: ConversationMessageQueueSchemaVersionV1;
  root_session_id: string;
  queue_item_id: string;
  state: HomeMessageQueueState;
  item_digest: string;
}

export interface HomeOptimisticQueuedMessage {
  kind: "optimistic";
  projection_key: string;
  root_session_id: string;
  client_order: number;
  content: string;
  target_participants: "all" | string[];
  quote_refs: HomeCanonicalQuoteReference[];
  private_context_present: boolean;
}

export type HomeQueuedMessageProjection =
  | { kind: "authoritative"; item: HomeQueuedMessage }
  | HomeOptimisticQueuedMessage;

export interface HomeQueuedMessageEditBinding {
  root_session_id: string;
  queue_item_id: string;
  item_digest: string;
  queue_sequence: number;
  target_participants: "all" | string[];
  quote_refs: HomeCanonicalQuoteReference[];
  private_context_present: boolean;
}
