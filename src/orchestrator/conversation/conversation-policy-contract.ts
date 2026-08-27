export const CONVERSATION_POLICY = Object.freeze({
  DIRECT: "direct",
  COORDINATE: "coordinate",
  DEBATE: "debate",
  PLAN: "plan",
  REVIEW: "review",
  VERIFY: "verify",
  ORCHESTRATE: "orchestrate",
} as const);

export const CONVERSATION_POLICIES = Object.freeze(Object.values(CONVERSATION_POLICY));
export type ConversationPolicyNameV1 = (typeof CONVERSATION_POLICIES)[number];
