export const CONVERSATION_BRAINSTORM_ERROR_KIND = Object.freeze({
  VALIDATION: "validation",
  ENGINE_START: "engine_start",
  TRANSPORT: "transport",
} as const);
export type ConversationBrainstormErrorKindV1 =
  (typeof CONVERSATION_BRAINSTORM_ERROR_KIND)[keyof typeof CONVERSATION_BRAINSTORM_ERROR_KIND];
export const CONVERSATION_BRAINSTORM_ERROR_KINDS = Object.freeze(
  Object.values(CONVERSATION_BRAINSTORM_ERROR_KIND),
) as readonly ConversationBrainstormErrorKindV1[];
