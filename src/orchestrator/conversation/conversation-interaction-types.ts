import type {
  CONVERSATION_INTERACTION_ENTRY_KIND,
  CONVERSATION_INTERACTION_SCHEMA_VERSION,
  ConversationInteractionActorKind,
  ConversationInteractionState,
  ConversationReactionOperationKind,
  ReactionEmojiV1,
} from "./conversation-interaction-contract.js";
import type { ConversationMessageQueueQuoteTargetKindV1 } from "./conversation-message-queue-contract.js";

export {
  CONVERSATION_REACTION_EMOJI,
  REACTION_EMOJIS,
  type ReactionEmojiV1,
} from "./conversation-interaction-contract.js";

export interface PublicMessageLocatorV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  target_event_id: string;
  target_kind: ConversationMessageQueueQuoteTargetKindV1;
  content_digest: string;
}

export interface PublicQuoteReferenceV1 extends PublicMessageLocatorV1 {
  author_public_id: string;
}

export interface PublicQuoteProjectionV1 extends PublicQuoteReferenceV1 {
  preview_text: string;
  created_at: string;
}

export interface PublicReactionProjectionV1 {
  target: PublicMessageLocatorV1;
  emoji: ReactionEmojiV1;
  count: number;
  reacted_by_recipient: boolean;
  actor_public_ids: string[];
}

export interface ConversationReactionOperationV1 {
  schema_version: typeof CONVERSATION_INTERACTION_SCHEMA_VERSION;
  operation_id: string;
  root_session_id: string;
  actor_public_id: string;
  actor_kind: ConversationInteractionActorKind;
  operation: ConversationReactionOperationKind;
  target: PublicMessageLocatorV1;
  emoji: ReactionEmojiV1;
  prior_interaction_head_digest: string;
  created_at: string;
  operation_digest: string;
}

export interface ConversationParticipantSocialIntentV1 {
  schema_version: typeof CONVERSATION_INTERACTION_SCHEMA_VERSION;
  intent_id: string;
  root_session_id: string;
  actor_participant_id: string;
  response: PublicMessageLocatorV1;
  quote_refs: PublicQuoteReferenceV1[];
  reaction_operations: ConversationReactionOperationV1[];
  diagnostic_code: string | null;
  prior_interaction_head_digest: string;
  created_at: string;
  intent_digest: string;
}

export type ConversationInteractionEntryV1 =
  | {
      kind: typeof CONVERSATION_INTERACTION_ENTRY_KIND.REACTION_OPERATION;
      operation: ConversationReactionOperationV1;
    }
  | {
      kind: typeof CONVERSATION_INTERACTION_ENTRY_KIND.PARTICIPANT_SOCIAL_INTENT;
      intent: ConversationParticipantSocialIntentV1;
    };

export interface ConversationInteractionFrameV1 {
  schema_version: typeof CONVERSATION_INTERACTION_SCHEMA_VERSION;
  root_session_id: string;
  sequence: number;
  previous_frame_digest: string | null;
  entry: ConversationInteractionEntryV1;
  frame_digest: string;
}

export interface ConversationInteractionHeadV1 {
  schema_version: typeof CONVERSATION_INTERACTION_SCHEMA_VERSION;
  root_session_id: string;
  sequence: number;
  last_frame_digest: string | null;
  updated_at: string;
  content_digest: string;
}

export interface ConversationInteractionFoldV1 {
  schema_version: typeof CONVERSATION_INTERACTION_SCHEMA_VERSION;
  root_session_id: string;
  head_digest: string;
  head_sequence: number;
  head_digests_by_sequence: Record<string, string>;
  reaction_sequences_by_operation_id: Record<string, number>;
  reactions: ConversationReactionOperationV1[];
  participant_intents: ConversationParticipantSocialIntentV1[];
}

export interface AgentReactionRequestV1 {
  operation: ConversationReactionOperationKind;
  target: PublicMessageLocatorV1;
  emoji: ReactionEmojiV1;
}

export interface AgentSocialIntentRequestV1 {
  present: boolean;
  quote_refs: unknown;
  reactions: unknown;
}

export interface ConversationInteractionProjectionV1 {
  schema_version: typeof CONVERSATION_INTERACTION_SCHEMA_VERSION;
  state: ConversationInteractionState;
  root_session_id: string;
  interaction_head_digest: string | null;
  interaction_head_sequence: number;
  interaction_head_digests_by_sequence: Record<string, string>;
  reaction_changes: Array<
    PublicReactionProjectionV1 & { last_changed_interaction_sequence: number }
  >;
  message_locators_by_event_id: Record<string, PublicMessageLocatorV1>;
  quote_projections_by_response_event_id: Record<string, PublicQuoteProjectionV1[]>;
  reaction_projections: PublicReactionProjectionV1[];
  diagnostics_by_response_event_id: Record<string, string>;
}

export interface ConversationTimelineInteractionV1 {
  state: ConversationInteractionState;
  message_locator: PublicMessageLocatorV1 | null;
  quote_refs: Array<{
    quoting_message_id: string;
    quote_order: number;
    target: PublicQuoteProjectionV1;
  }>;
  reactions: PublicReactionProjectionV1[];
  diagnostic_code: string | null;
}
