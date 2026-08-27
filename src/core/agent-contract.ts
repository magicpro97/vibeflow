/**
 * Dependency-free engine and host-tool vocabulary shared by CLI, server, and browser code.
 *
 * Keep this module free of platform globals and imports so boundary DTOs can depend on it
 * without pulling backend durability or Node-only code into the UI bundle.
 */
export const AGENT_ENGINE = Object.freeze({
  CLAUDE: "claude",
  COPILOT: "copilot",
  CODEX: "codex",
  OPENCODE: "opencode",
  ANTIGRAVITY: "antigravity",
} as const);

export type Engine = (typeof AGENT_ENGINE)[keyof typeof AGENT_ENGINE];

export const AGENT_ROLE_SOURCE = Object.freeze({
  BUILTIN: "builtin",
  REPO: "repo",
} as const);

export type AgentRoleSource = (typeof AGENT_ROLE_SOURCE)[keyof typeof AGENT_ROLE_SOURCE];
export const AGENT_ROLE_SOURCES = Object.freeze(Object.values(AGENT_ROLE_SOURCE));

/**
 * Canonical priority order used whenever more than one engine is available.
 * Keep docs/USER_GUIDE.md and test/engine-priority.test.ts in sync when changing it.
 */
export const ENGINES: readonly Engine[] = Object.freeze([
  AGENT_ENGINE.CLAUDE,
  AGENT_ENGINE.COPILOT,
  AGENT_ENGINE.CODEX,
  AGENT_ENGINE.OPENCODE,
  AGENT_ENGINE.ANTIGRAVITY,
]);

export const AGENT_HOST_TOOL = Object.freeze({
  PROPOSE_ACTION: "propose_action",
} as const);

export type AgentHostToolV1 = (typeof AGENT_HOST_TOOL)[keyof typeof AGENT_HOST_TOOL];

export const AGENT_HOST_TOOLS = Object.freeze(
  Object.values(AGENT_HOST_TOOL),
) as readonly AgentHostToolV1[];

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isAgentEngine = (value: unknown): value is Engine => memberOf(ENGINES, value);

export const isAgentHostTool = (value: unknown): value is AgentHostToolV1 =>
  memberOf(AGENT_HOST_TOOLS, value);

export const isAgentRoleSource = (value: unknown): value is AgentRoleSource =>
  memberOf(AGENT_ROLE_SOURCES, value);
