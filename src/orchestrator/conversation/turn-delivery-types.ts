import type { PersistedResumeBinding } from "./artifact-store.js";
import type {
  PublicQuoteProjectionV1,
  PublicQuoteReferenceV1,
  PublicReactionProjectionV1,
} from "./conversation-interaction-types.js";

export type {
  PublicMessageLocatorV1,
  PublicQuoteProjectionV1,
  PublicQuoteReferenceV1,
  PublicReactionProjectionV1,
  ReactionEmojiV1,
} from "./conversation-interaction-types.js";

export type ConversationTurnInstructionV1 =
  | {
      kind: "direct";
      topic: string | null;
    }
  | {
      kind: "debate-participant";
      topic: string;
      round: number;
    };

export interface ConversationTurnMessageV1 {
  message_id: string;
  public_seq: number;
  author_public_id: "human";
  content: string;
  target_participants: "all" | string[];
  content_digest: string;
}

export interface ConversationTurnResponseV1 {
  message_id: string;
  public_seq: number;
  author_public_id: string;
  role_ref: string;
  round_id: string;
  answer: string | null;
  claim: string | null;
  evidence: string[];
  artifact_refs: string[];
  content_digest: string;
}

export interface ConversationTurnQuoteProjectionV1 {
  quoting_message_id: string;
  quote_order: number;
  target: PublicQuoteReferenceV1 | PublicQuoteProjectionV1;
}

export interface ConversationTurnPrivateFileRangeContextV1 {
  context_kind: "conversation-create" | "user-message";
  message_public_seq: number | null;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  content: string;
}

export interface ConversationTurnEnvelopeV1 {
  schema_version: "1.0";
  projection_profile: "vf-public-turn/1";
  conversation_id: string;
  revision_id: string;
  recipient_participant_id: string;
  delivery_mode: "exact-delta" | "full-history";
  after_public_seq: number;
  through_public_seq: number;
  prior_delivery_digest: string | null;
  interaction_state: "ready" | "degraded";
  after_interaction_sequence: number;
  through_interaction_sequence: number;
  prior_interaction_head_digest: string | null;
  interaction_head_digest: string | null;
  instruction: ConversationTurnInstructionV1;
  user_messages: ConversationTurnMessageV1[];
  public_responses: ConversationTurnResponseV1[];
  quoted_messages: ConversationTurnQuoteProjectionV1[];
  peer_reactions: PublicReactionProjectionV1[];
}

export interface ConversationTurnDeliveryReceiptV1 {
  schema_version: "1.0";
  participant_id: string;
  prior_attempt_id: string | null;
  delivery_mode: ConversationTurnEnvelopeV1["delivery_mode"];
  after_public_seq: number;
  through_public_seq: number;
  envelope_digest: string;
  interaction_state: "ready" | "degraded";
  after_interaction_sequence: number;
  through_interaction_sequence: number;
  prior_interaction_head_digest: string | null;
  interaction_head_digest: string | null;
}

export interface PreparedConversationTurnV1 {
  prompt_input: string;
  private_context_prompt: string | null;
  envelope: ConversationTurnEnvelopeV1;
  receipt: ConversationTurnDeliveryReceiptV1;
  applicable_user_message_count: number;
}

export interface ConversationTurnPreparationRequestV1 {
  participant_id: string;
  instruction: ConversationTurnInstructionV1;
}

export interface PersistedTurnDeliveryV1 {
  participant_id: string;
  attempt_id: string;
  through_public_seq: number;
  envelope_digest: string;
  interaction_sequence?: number;
  interaction_head_digest?: string;
}

export type ResumeWithDeliveryAuthorityV1 = PersistedResumeBinding & {
  delivery_public_seq: number;
  delivery_digest: string;
  delivery_interaction_sequence?: number;
  delivery_interaction_digest?: string;
};
