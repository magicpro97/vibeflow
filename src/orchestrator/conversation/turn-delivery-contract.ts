export const CONVERSATION_TURN_DELIVERY_SCHEMA_VERSION = "1.0" as const;

export const CONVERSATION_TURN_INSTRUCTION_KIND = Object.freeze({
  DIRECT: "direct",
  DEBATE_PARTICIPANT: "debate-participant",
  COORDINATOR_PLAN: "coordinator-plan",
  EXECUTOR_TASK: "executor-task",
  COORDINATOR_CLARIFICATION: "coordinator-clarification",
  EXECUTOR_RESOLUTION: "executor-resolution",
  COORDINATOR_REVIEW: "coordinator-review",
} as const);
export type ConversationTurnInstructionKind =
  (typeof CONVERSATION_TURN_INSTRUCTION_KIND)[keyof typeof CONVERSATION_TURN_INSTRUCTION_KIND];

export const CONVERSATION_TURN_PRIVATE_CONTEXT_KIND = Object.freeze({
  CONVERSATION_CREATE: "conversation-create",
  USER_MESSAGE: "user-message",
} as const);
export type ConversationTurnPrivateContextKind =
  (typeof CONVERSATION_TURN_PRIVATE_CONTEXT_KIND)[keyof typeof CONVERSATION_TURN_PRIVATE_CONTEXT_KIND];
export const CONVERSATION_TURN_PRIVATE_CONTEXT_KINDS = Object.freeze(
  Object.values(CONVERSATION_TURN_PRIVATE_CONTEXT_KIND),
) as readonly ConversationTurnPrivateContextKind[];
export const isConversationTurnPrivateContextKind = (
  value: unknown,
): value is ConversationTurnPrivateContextKind =>
  typeof value === "string" &&
  CONVERSATION_TURN_PRIVATE_CONTEXT_KINDS.some((candidate) => candidate === value);

export const CONVERSATION_TURN_PROJECTION_PROFILE = Object.freeze({
  PUBLIC_V1: "vf-public-turn/1",
} as const);
export type ConversationTurnProjectionProfile =
  (typeof CONVERSATION_TURN_PROJECTION_PROFILE)[keyof typeof CONVERSATION_TURN_PROJECTION_PROFILE];

export const CONVERSATION_TURN_DELIVERY_MODE = Object.freeze({
  EXACT_DELTA: "exact-delta",
  FULL_HISTORY: "full-history",
} as const);
export type ConversationTurnDeliveryMode =
  (typeof CONVERSATION_TURN_DELIVERY_MODE)[keyof typeof CONVERSATION_TURN_DELIVERY_MODE];
export const CONVERSATION_TURN_DELIVERY_MODES = Object.freeze(
  Object.values(CONVERSATION_TURN_DELIVERY_MODE),
) as readonly ConversationTurnDeliveryMode[];

export const CONVERSATION_TURN_NATIVE_SESSION_USE = Object.freeze({
  REQUIRED_EXACT: "required-exact",
  NOT_USED: "not-used",
} as const);
export type ConversationTurnNativeSessionUse =
  (typeof CONVERSATION_TURN_NATIVE_SESSION_USE)[keyof typeof CONVERSATION_TURN_NATIVE_SESSION_USE];

export const CONVERSATION_TURN_RECIPIENT_HISTORY_SOURCE = Object.freeze({
  NATIVE_SESSION: "native-session",
  BOUNDED_PUBLIC_REPLAY: "bounded-public-replay",
} as const);
export type ConversationTurnRecipientHistorySource =
  (typeof CONVERSATION_TURN_RECIPIENT_HISTORY_SOURCE)[keyof typeof CONVERSATION_TURN_RECIPIENT_HISTORY_SOURCE];

export const CONVERSATION_TURN_HISTORY_SUMMARY_KIND = Object.freeze({
  CLAIM: "claim",
  ANSWER: "answer",
  EMPTY: "empty",
} as const);
export type ConversationTurnHistorySummaryKind =
  (typeof CONVERSATION_TURN_HISTORY_SUMMARY_KIND)[keyof typeof CONVERSATION_TURN_HISTORY_SUMMARY_KIND];

export const CONVERSATION_TURN_RECIPIENT_HISTORY_LIMIT = Object.freeze({
  MAX_ENTRIES: 8,
  MAX_SUMMARY_BYTES: 2 * 1024,
} as const);

export const CONVERSATION_TURN_PROMPT_PREFIX = "VF-TURN/1\n" as const;

export const CONVERSATION_PRIVATE_FILE_RANGE_PROMPT = Object.freeze({
  PREFIX: "VF-PRIVATE-FILE-RANGES/1\n",
  SCHEMA_VERSION: CONVERSATION_TURN_DELIVERY_SCHEMA_VERSION,
  KIND: "repo-file-ranges",
} as const);
