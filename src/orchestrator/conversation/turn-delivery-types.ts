import type { Engine } from "../../core/agent-contract.js";
import type { PersistedResumeBinding } from "./artifact-store.js";
import type { ConversationInteractionState } from "./conversation-interaction-contract.js";
import type {
  PublicQuoteProjectionV1,
  PublicQuoteReferenceV1,
  PublicReactionProjectionV1,
} from "./conversation-interaction-types.js";
import type {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  ConversationMessageQueueTargetParticipantsV1,
} from "./conversation-message-queue-contract.js";
import type {
  CONVERSATION_TURN_DELIVERY_SCHEMA_VERSION,
  CONVERSATION_TURN_INSTRUCTION_KIND,
  CONVERSATION_TURN_PROJECTION_PROFILE,
  ConversationTurnDeliveryMode,
  ConversationTurnHistorySummaryKind,
  ConversationTurnNativeSessionUse,
  ConversationTurnPrivateContextKind,
  ConversationTurnRecipientHistorySource,
} from "./turn-delivery-contract.js";

export type {
  PublicMessageLocatorV1,
  PublicQuoteProjectionV1,
  PublicQuoteReferenceV1,
  PublicReactionProjectionV1,
  ReactionEmojiV1,
} from "./conversation-interaction-types.js";

export type ConversationTurnInstructionV1 =
  | {
      kind: typeof CONVERSATION_TURN_INSTRUCTION_KIND.DIRECT;
      topic: string | null;
    }
  | {
      kind: typeof CONVERSATION_TURN_INSTRUCTION_KIND.DEBATE_PARTICIPANT;
      topic: string;
      round: number;
    };

export interface ConversationTurnMessageV1 {
  message_id: string;
  public_seq: number;
  author_public_id: typeof CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN;
  content: string;
  target_participants: ConversationMessageQueueTargetParticipantsV1;
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

export interface ConversationTurnRecipientHistoryEntryV1 {
  message_id: string;
  public_seq: number;
  role_ref: string;
  round_id: string;
  summary_kind: ConversationTurnHistorySummaryKind;
  summary: string | null;
  summary_truncated: boolean;
  source_content_digest: string;
}

export interface ConversationTurnRecipientHistoryV1 {
  source: ConversationTurnRecipientHistorySource;
  source_response_count: number;
  replayed_response_count: number;
  truncated_response_count: number;
  entries: readonly ConversationTurnRecipientHistoryEntryV1[];
}

export interface ConversationTurnPrivateFileRangeContextV1 {
  context_kind: ConversationTurnPrivateContextKind;
  message_public_seq: number | null;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  content: string;
}

export interface ConversationTurnEnvelopeV1 {
  schema_version: typeof CONVERSATION_TURN_DELIVERY_SCHEMA_VERSION;
  projection_profile: typeof CONVERSATION_TURN_PROJECTION_PROFILE.PUBLIC_V1;
  conversation_id: string;
  revision_id: string;
  recipient_participant_id: string;
  recipient_engine: Engine;
  delivery_mode: ConversationTurnDeliveryMode;
  native_session_use: ConversationTurnNativeSessionUse;
  after_public_seq: number;
  through_public_seq: number;
  prior_delivery_digest: string | null;
  interaction_state: ConversationInteractionState;
  after_interaction_sequence: number;
  through_interaction_sequence: number;
  prior_interaction_head_digest: string | null;
  interaction_head_digest: string | null;
  instruction: ConversationTurnInstructionV1;
  user_messages: ConversationTurnMessageV1[];
  public_responses: ConversationTurnResponseV1[];
  recipient_history: ConversationTurnRecipientHistoryV1;
  quoted_messages: ConversationTurnQuoteProjectionV1[];
  peer_reactions: PublicReactionProjectionV1[];
}

export interface ConversationTurnDeliveryReceiptV1 {
  schema_version: typeof CONVERSATION_TURN_DELIVERY_SCHEMA_VERSION;
  participant_id: string;
  prior_attempt_id: string | null;
  delivery_mode: ConversationTurnEnvelopeV1["delivery_mode"];
  after_public_seq: number;
  through_public_seq: number;
  envelope_digest: string;
  interaction_state: ConversationInteractionState;
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
