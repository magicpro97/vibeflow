import { AGENT_ENGINE, AGENT_ROLE_SOURCE, type Engine } from "../core/agent-contract.js";

/** Dependency-light authority for dispatch, prompt, and native-session protocol vocabulary. */
export const ENGINE_SESSION_SCHEMA_VERSION = "1.0" as const;

export const DISPATCH_MODE = Object.freeze({
  CLI: "cli",
  BRIDGE: "bridge",
  DRY: "dry",
} as const);

export type DispatchMode = (typeof DISPATCH_MODE)[keyof typeof DISPATCH_MODE];
export const DISPATCH_MODES = Object.freeze(Object.values(DISPATCH_MODE));

export const ENGINE_PROMPT_MODE = Object.freeze({
  STDIN: "stdin",
  ARG: "arg",
} as const);

export type EnginePromptMode = (typeof ENGINE_PROMPT_MODE)[keyof typeof ENGINE_PROMPT_MODE];
export const ENGINE_PROMPT_MODES = Object.freeze(Object.values(ENGINE_PROMPT_MODE));

export const ENGINE_SESSION_PROTOCOL = Object.freeze({
  NATIVE: "native",
  BRIDGE: DISPATCH_MODE.BRIDGE,
} as const);

export type EngineSessionProtocol =
  (typeof ENGINE_SESSION_PROTOCOL)[keyof typeof ENGINE_SESSION_PROTOCOL];
export const ENGINE_SESSION_PROTOCOLS = Object.freeze(Object.values(ENGINE_SESSION_PROTOCOL));

export const ENGINE_OUTPUT_STREAM = Object.freeze({
  STDOUT: "stdout",
  STDERR: "stderr",
} as const);

export type EngineOutputStream = (typeof ENGINE_OUTPUT_STREAM)[keyof typeof ENGINE_OUTPUT_STREAM];
export const ENGINE_OUTPUT_STREAMS = Object.freeze(Object.values(ENGINE_OUTPUT_STREAM));

export const ENGINE_SESSION_MODE = Object.freeze({
  EXACT: "exact",
  REPLAY: "replay",
  FRESH: "fresh",
} as const);

export type EngineSessionMode = (typeof ENGINE_SESSION_MODE)[keyof typeof ENGINE_SESSION_MODE];
export const ENGINE_SESSION_MODES = Object.freeze(Object.values(ENGINE_SESSION_MODE));

/** What native-history reconciliation proves about exact session continuity. */
export const NATIVE_HISTORY_CONTINUITY = Object.freeze({
  INTACT: "intact",
  COMPACTED: "compacted",
  UNPROVED: "unproved",
} as const);

export type NativeHistoryContinuity =
  (typeof NATIVE_HISTORY_CONTINUITY)[keyof typeof NATIVE_HISTORY_CONTINUITY];

/** Engines whose CLI can resume one caller-supplied, validated native session id. */
export const ENGINE_EXACT_SESSION_RESUME = Object.freeze({
  CLAUDE: AGENT_ENGINE.CLAUDE,
  CODEX: AGENT_ENGINE.CODEX,
  OPENCODE: AGENT_ENGINE.OPENCODE,
} as const);

export type EngineExactSessionResume =
  (typeof ENGINE_EXACT_SESSION_RESUME)[keyof typeof ENGINE_EXACT_SESSION_RESUME];
export const ENGINE_EXACT_SESSION_RESUME_ENGINES = Object.freeze(
  Object.values(ENGINE_EXACT_SESSION_RESUME),
) as readonly EngineExactSessionResume[];

export const supportsExactNativeSessionResume = (
  engine: Engine,
): engine is EngineExactSessionResume =>
  ENGINE_EXACT_SESSION_RESUME_ENGINES.some((candidate) => candidate === engine);

/** Engines whose native CLI can enforce a resolved conversation role sandbox. */
export const ENGINE_CONVERSATION_ROLE_AUTHORITY = Object.freeze({
  CLAUDE: AGENT_ENGINE.CLAUDE,
  COPILOT: AGENT_ENGINE.COPILOT,
  CODEX: AGENT_ENGINE.CODEX,
} as const);
export type EngineConversationRoleAuthority =
  (typeof ENGINE_CONVERSATION_ROLE_AUTHORITY)[keyof typeof ENGINE_CONVERSATION_ROLE_AUTHORITY];
export const ENGINE_CONVERSATION_ROLE_AUTHORITY_ENGINES = Object.freeze(
  Object.values(ENGINE_CONVERSATION_ROLE_AUTHORITY),
) as readonly EngineConversationRoleAuthority[];
export const supportsConversationRoleAuthority = (
  engine: Engine,
): engine is EngineConversationRoleAuthority =>
  ENGINE_CONVERSATION_ROLE_AUTHORITY_ENGINES.some((candidate) => candidate === engine);

/** Engines whose native terminal protocol authenticates model output for coordination. */
export const ENGINE_AUTHENTICATED_COORDINATION_OUTPUT = Object.freeze({
  CLAUDE: AGENT_ENGINE.CLAUDE,
  CODEX: AGENT_ENGINE.CODEX,
} as const);
export type EngineAuthenticatedCoordinationOutput =
  (typeof ENGINE_AUTHENTICATED_COORDINATION_OUTPUT)[keyof typeof ENGINE_AUTHENTICATED_COORDINATION_OUTPUT];
export const ENGINE_AUTHENTICATED_COORDINATION_OUTPUT_ENGINES = Object.freeze(
  Object.values(ENGINE_AUTHENTICATED_COORDINATION_OUTPUT),
) as readonly EngineAuthenticatedCoordinationOutput[];
export const supportsAuthenticatedCoordinationOutput = (
  engine: Engine,
): engine is EngineAuthenticatedCoordinationOutput =>
  ENGINE_AUTHENTICATED_COORDINATION_OUTPUT_ENGINES.some((candidate) => candidate === engine);

/** Phase 1 is intentionally narrower because it requires the live-probed bootstrap route. */
export const ENGINE_PHASE_ONE_CONVERSATION_AUTHORITY = Object.freeze({
  CLAUDE: AGENT_ENGINE.CLAUDE,
  CODEX: AGENT_ENGINE.CODEX,
} as const);
export const ENGINE_PHASE_ONE_CONVERSATION_AUTHORITY_ENGINES = Object.freeze(
  Object.values(ENGINE_PHASE_ONE_CONVERSATION_AUTHORITY),
);
export const supportsPhaseOneConversationAuthority = (engine: Engine): boolean =>
  ENGINE_PHASE_ONE_CONVERSATION_AUTHORITY_ENGINES.some((candidate) => candidate === engine);

export const ENGINE_ISOLATION_KIND = Object.freeze({
  WORKTREE: "worktree",
  CONTAINER: "container",
} as const);

export type EngineIsolationKind =
  (typeof ENGINE_ISOLATION_KIND)[keyof typeof ENGINE_ISOLATION_KIND];
export const ENGINE_ISOLATION_KINDS = Object.freeze(Object.values(ENGINE_ISOLATION_KIND));

export const ENGINE_COORDINATION_WORKSPACE_ACCESS = Object.freeze({
  EXECUTOR: "executor",
  REVIEW: "review",
} as const);

export type EngineCoordinationWorkspaceAccess =
  (typeof ENGINE_COORDINATION_WORKSPACE_ACCESS)[keyof typeof ENGINE_COORDINATION_WORKSPACE_ACCESS];

export const ENGINE_ROLE_SOURCE = AGENT_ROLE_SOURCE;

export type EngineRoleSource = (typeof ENGINE_ROLE_SOURCE)[keyof typeof ENGINE_ROLE_SOURCE];
export const ENGINE_ROLE_SOURCES = Object.freeze(Object.values(ENGINE_ROLE_SOURCE));

export const ENGINE_NATIVE_SESSION_STATUS = Object.freeze({
  CAPTURED: "captured",
  UNAVAILABLE: "unavailable",
} as const);

export type EngineNativeSessionStatus =
  (typeof ENGINE_NATIVE_SESSION_STATUS)[keyof typeof ENGINE_NATIVE_SESSION_STATUS];
export const ENGINE_NATIVE_SESSION_STATUSES = Object.freeze(
  Object.values(ENGINE_NATIVE_SESSION_STATUS),
);

export const ENGINE_EVIDENCE_STATUS = Object.freeze({
  PERSISTED: "persisted",
} as const);

export type EngineEvidenceStatus =
  (typeof ENGINE_EVIDENCE_STATUS)[keyof typeof ENGINE_EVIDENCE_STATUS];

export const ENGINE_ATTEMPT_START_OUTCOME = Object.freeze({
  ACCEPTED: "accepted",
  PROVED_ABSENT: "proved-absent",
  UNKNOWN: "unknown",
} as const);

export type EngineAttemptStartOutcome =
  (typeof ENGINE_ATTEMPT_START_OUTCOME)[keyof typeof ENGINE_ATTEMPT_START_OUTCOME];
export const ENGINE_ATTEMPT_START_OUTCOMES = Object.freeze(
  Object.values(ENGINE_ATTEMPT_START_OUTCOME),
);

export const ENGINE_IDENTITY = Object.freeze({
  UNKNOWN: "unknown",
} as const);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isDispatchMode = (value: unknown): value is DispatchMode =>
  memberOf(DISPATCH_MODES, value);
export const isEnginePromptMode = (value: unknown): value is EnginePromptMode =>
  memberOf(ENGINE_PROMPT_MODES, value);
export const isEngineSessionProtocol = (value: unknown): value is EngineSessionProtocol =>
  memberOf(ENGINE_SESSION_PROTOCOLS, value);
export const isEngineOutputStream = (value: unknown): value is EngineOutputStream =>
  memberOf(ENGINE_OUTPUT_STREAMS, value);
export const isEngineSessionMode = (value: unknown): value is EngineSessionMode =>
  memberOf(ENGINE_SESSION_MODES, value);
export const isEngineIsolationKind = (value: unknown): value is EngineIsolationKind =>
  memberOf(ENGINE_ISOLATION_KINDS, value);
export const isEngineRoleSource = (value: unknown): value is EngineRoleSource =>
  memberOf(ENGINE_ROLE_SOURCES, value);
export const isEngineNativeSessionStatus = (value: unknown): value is EngineNativeSessionStatus =>
  memberOf(ENGINE_NATIVE_SESSION_STATUSES, value);
export const isEngineAttemptStartOutcome = (value: unknown): value is EngineAttemptStartOutcome =>
  memberOf(ENGINE_ATTEMPT_START_OUTCOMES, value);
