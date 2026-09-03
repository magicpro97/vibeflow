import { CONVERSATION_MESSAGE_QUEUE_LIMITS } from "./conversation-message-queue-contract.js";

export const CONVERSATION_INTERACTION_SCHEMA_VERSION = "1.0" as const;

export const CONVERSATION_REACTION_EMOJI = Object.freeze({
  APPROVE: "👍",
  NEEDS_CHANGES: "👎",
  APPRECIATE: "❤️",
  CELEBRATE: "🎉",
  WATCHING: "👀",
  QUESTION: "🤔",
  CONFIRMED: "✅",
  URGENT: "❗",
} as const);
export type ReactionEmojiV1 =
  (typeof CONVERSATION_REACTION_EMOJI)[keyof typeof CONVERSATION_REACTION_EMOJI];
export const REACTION_EMOJIS = Object.freeze(
  Object.values(CONVERSATION_REACTION_EMOJI),
) as readonly ReactionEmojiV1[];

export const CONVERSATION_INTERACTION_ACTOR_KIND = Object.freeze({
  HUMAN: "human",
  PARTICIPANT: "participant",
} as const);
export type ConversationInteractionActorKind =
  (typeof CONVERSATION_INTERACTION_ACTOR_KIND)[keyof typeof CONVERSATION_INTERACTION_ACTOR_KIND];
export const CONVERSATION_INTERACTION_ACTOR_KINDS = Object.freeze(
  Object.values(CONVERSATION_INTERACTION_ACTOR_KIND),
) as readonly ConversationInteractionActorKind[];

export const CONVERSATION_REACTION_OPERATION = Object.freeze({
  ADD: "add",
  REMOVE: "remove",
} as const);
export type ConversationReactionOperationKind =
  (typeof CONVERSATION_REACTION_OPERATION)[keyof typeof CONVERSATION_REACTION_OPERATION];
export const CONVERSATION_REACTION_OPERATIONS = Object.freeze(
  Object.values(CONVERSATION_REACTION_OPERATION),
) as readonly ConversationReactionOperationKind[];

export const CONVERSATION_HUMAN_REACTION_REQUEST_MODE = Object.freeze({
  ADD: CONVERSATION_REACTION_OPERATION.ADD,
  REMOVE: CONVERSATION_REACTION_OPERATION.REMOVE,
  TOGGLE_SELF: "toggle-self",
} as const);
export type ConversationHumanReactionRequestMode =
  (typeof CONVERSATION_HUMAN_REACTION_REQUEST_MODE)[keyof typeof CONVERSATION_HUMAN_REACTION_REQUEST_MODE];
export const CONVERSATION_HUMAN_REACTION_REQUEST_MODES = Object.freeze(
  Object.values(CONVERSATION_HUMAN_REACTION_REQUEST_MODE),
) as readonly ConversationHumanReactionRequestMode[];

export const CONVERSATION_INTERACTION_ENTRY_KIND = Object.freeze({
  REACTION_OPERATION: "reaction-operation",
  PARTICIPANT_SOCIAL_INTENT: "participant-social-intent",
} as const);
export type ConversationInteractionEntryKind =
  (typeof CONVERSATION_INTERACTION_ENTRY_KIND)[keyof typeof CONVERSATION_INTERACTION_ENTRY_KIND];

export const CONVERSATION_INTERACTION_STATE = Object.freeze({
  READY: "ready",
  DEGRADED: "degraded",
} as const);
export type ConversationInteractionState =
  (typeof CONVERSATION_INTERACTION_STATE)[keyof typeof CONVERSATION_INTERACTION_STATE];
export const CONVERSATION_INTERACTION_STATES = Object.freeze(
  Object.values(CONVERSATION_INTERACTION_STATE),
) as readonly ConversationInteractionState[];

export const CONVERSATION_SOCIAL_DIAGNOSTIC_CODE = Object.freeze({
  RESPONSE_UNAVAILABLE: "social_intent_response_unavailable",
  AUTHORITY_CORRUPT: "interaction_authority_corrupt",
  INVALID_INTENT: "invalid_social_intent",
} as const);
export type ConversationSocialDiagnosticCode =
  (typeof CONVERSATION_SOCIAL_DIAGNOSTIC_CODE)[keyof typeof CONVERSATION_SOCIAL_DIAGNOSTIC_CODE];

/** Queue quotes and interaction projections share one canonical public-message bound. */
export const CONVERSATION_INTERACTION_LIMITS = Object.freeze({
  maxQuotes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxQuotes,
  maxAgentReactionRequests: 16,
  maxParticipantReactionAdds: 3,
  maxReferenceBytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxReferenceBytes,
  maxObjectBytes: 2 * 1024 * 1024,
  maxFrames: 16_384,
  maxRequestBindings: 16_384,
} as const);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isConversationInteractionActorKind = (
  value: unknown,
): value is ConversationInteractionActorKind =>
  memberOf(CONVERSATION_INTERACTION_ACTOR_KINDS, value);
export const isConversationReactionOperation = (
  value: unknown,
): value is ConversationReactionOperationKind => memberOf(CONVERSATION_REACTION_OPERATIONS, value);
export const isConversationHumanReactionRequestMode = (
  value: unknown,
): value is ConversationHumanReactionRequestMode =>
  memberOf(CONVERSATION_HUMAN_REACTION_REQUEST_MODES, value);
