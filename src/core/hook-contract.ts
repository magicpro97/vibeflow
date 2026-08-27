/** Dependency-free universal hook protocol shared by every engine adapter and browser client. */
type ValueOf<Contract> = Contract[keyof Contract];

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const HOOK_EVENT = Object.freeze({
  PRE_TOOL_USE: "pre-tool-use",
  POST_TOOL_USE: "post-tool-use",
  PRE_WRITE: "pre-write",
  POST_WRITE: "post-write",
  PRE_COMMAND: "pre-command",
  POST_COMMAND: "post-command",
  STOP: "stop",
  SKILL_COMPLIANCE: "skill-compliance",
  VERIFY_RESULT: "verify-result",
} as const);
export type HookEvent = ValueOf<typeof HOOK_EVENT>;
export const HOOK_EVENTS = Object.freeze(Object.values(HOOK_EVENT));
export const isHookEvent = (value: unknown): value is HookEvent => memberOf(HOOK_EVENTS, value);

export const HOOK_DECISION = Object.freeze({
  ALLOW: "allow",
  WARN: "warn",
  REQUIRE_APPROVAL: "require_approval",
  BLOCK: "block",
} as const);
export type HookDecision = ValueOf<typeof HOOK_DECISION>;
export const HOOK_DECISIONS = Object.freeze(Object.values(HOOK_DECISION));
export const isHookDecision = (value: unknown): value is HookDecision =>
  memberOf(HOOK_DECISIONS, value);

export const RISK_LEVEL = Object.freeze({
  NONE: "none",
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const);
export type RiskLevel = ValueOf<typeof RISK_LEVEL>;
export const RISK_LEVELS = Object.freeze(Object.values(RISK_LEVEL));
export const isRiskLevel = (value: unknown): value is RiskLevel => memberOf(RISK_LEVELS, value);

/** Ordered least-to-most severe for threshold comparisons. */
export const RISK_LEVEL_ORDER = RISK_LEVELS;

/** Decisions that require a human/security boundary rather than advisory-only handling. */
export const SECURITY_BEARING_HOOK_DECISIONS = Object.freeze([
  HOOK_DECISION.REQUIRE_APPROVAL,
  HOOK_DECISION.BLOCK,
] as const);
export type SecurityBearingHookDecision = (typeof SECURITY_BEARING_HOOK_DECISIONS)[number];

/** Decisions retained in the audit/UI feed; no-op allows are deliberately omitted. */
export const AUDITED_HOOK_DECISIONS = Object.freeze([
  HOOK_DECISION.WARN,
  ...SECURITY_BEARING_HOOK_DECISIONS,
] as const);
export type AuditedHookDecision = (typeof AUDITED_HOOK_DECISIONS)[number];
export const isAuditedHookDecision = (value: unknown): value is AuditedHookDecision =>
  memberOf(AUDITED_HOOK_DECISIONS, value);

/** Binary answer returned by an interactive approval surface. */
export const HOOK_CONFIRMATION_DECISIONS = Object.freeze([
  HOOK_DECISION.ALLOW,
  HOOK_DECISION.BLOCK,
] as const);
export type HookConfirmationDecision = (typeof HOOK_CONFIRMATION_DECISIONS)[number];
export const isHookConfirmationDecision = (value: unknown): value is HookConfirmationDecision =>
  memberOf(HOOK_CONFIRMATION_DECISIONS, value);

export const HOOK_ENFORCEMENT_MODE = Object.freeze({
  NATIVE: "native",
  NATIVE_BASH_ONLY: "native-bash-only",
  POST_HOC_ONLY: "post-hoc-only",
} as const);
export type HookEnforcementMode = ValueOf<typeof HOOK_ENFORCEMENT_MODE>;
export const HOOK_ENFORCEMENT_MODES = Object.freeze(Object.values(HOOK_ENFORCEMENT_MODE));
export const isHookEnforcementMode = (value: unknown): value is HookEnforcementMode =>
  memberOf(HOOK_ENFORCEMENT_MODES, value);
