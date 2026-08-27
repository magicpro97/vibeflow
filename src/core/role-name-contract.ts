export const WORKFLOW_ROLE_NAME = Object.freeze({
  CLI_ENGINE: "cli-engine",
  WEB_UI: "web-ui",
  SKILL_AUTHOR: "skill-author",
  PREFLIGHT_ENGINE: "preflight-engine",
  DISPATCH_RUNNER: "dispatch-runner",
  DOC_WRITER: "doc-writer",
} as const);

export const CONVERSATION_ROLE_NAME = Object.freeze({
  DIRECT: "direct",
  COORDINATION_COORDINATOR: "coordination-coordinator",
  COORDINATION_EXECUTOR: "coordination-executor",
  BRAINSTORM_PARTICIPANT: "brainstorm-participant",
  BRAINSTORM_SKEPTIC: "brainstorm-skeptic",
  BRAINSTORM_DOMAIN_EXPERT: "brainstorm-domain-expert",
  BRAINSTORM_EVALUATOR: "brainstorm-evaluator",
} as const);

export const WORKFLOW_ROLE_NAMES = Object.freeze(Object.values(WORKFLOW_ROLE_NAME));
export const CONVERSATION_ROLE_NAMES = Object.freeze(Object.values(CONVERSATION_ROLE_NAME));
export const BUILTIN_ROLE_NAMES = Object.freeze([
  ...WORKFLOW_ROLE_NAMES,
  ...CONVERSATION_ROLE_NAMES,
]);

export type WorkflowRoleNameV1 = (typeof WORKFLOW_ROLE_NAMES)[number];
export type ConversationRoleNameV1 = (typeof CONVERSATION_ROLE_NAMES)[number];
export type BuiltinRoleNameV1 = (typeof BUILTIN_ROLE_NAMES)[number];
