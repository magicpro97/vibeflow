/**
 * Dependency-free workflow vocabulary shared by persistence, orchestration, CLI, and browser DTOs.
 *
 * Runtime values are the authority. Types, ordered arrays, and guards are derived from those
 * frozen values so hand-edited state and cross-process payloads cannot drift from TypeScript.
 */
type ValueOf<Contract> = Contract[keyof Contract];

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const GATE_STATE = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  RUNNING: "running",
  PENDING: "pending",
} as const);
export type GateState = ValueOf<typeof GATE_STATE>;
export const GATE_STATES = Object.freeze(Object.values(GATE_STATE));
export const isGateState = (value: unknown): value is GateState => memberOf(GATE_STATES, value);

export const WORK_UNIT_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  VERIFYING: "verifying",
  DONE: "done",
  BLOCKED: "blocked",
} as const);
export type WorkUnitStatus = ValueOf<typeof WORK_UNIT_STATUS>;
export const WORK_UNIT_STATUSES = Object.freeze(Object.values(WORK_UNIT_STATUS));
export const isWorkUnitStatus = (value: unknown): value is WorkUnitStatus =>
  memberOf(WORK_UNIT_STATUSES, value);

export const WORK_UNIT_RISK_CLASS = Object.freeze({
  DOCS: "docs",
  SIMPLE_CODE: "simple-code",
  FEATURE: "feature",
  ARCHITECTURE: "architecture",
  SECURITY: "security",
  DEPLOY: "deploy",
} as const);
export type WorkUnitRiskClass = ValueOf<typeof WORK_UNIT_RISK_CLASS>;
export const WORK_UNIT_RISK_CLASSES = Object.freeze(Object.values(WORK_UNIT_RISK_CLASS));
export const isWorkUnitRiskClass = (value: unknown): value is WorkUnitRiskClass =>
  memberOf(WORK_UNIT_RISK_CLASSES, value);

export const KNOWLEDGE_HEAVY_SOURCE = Object.freeze({
  RISK: "risk",
  REGEX: "regex",
} as const);
export type KnowledgeHeavySource = ValueOf<typeof KNOWLEDGE_HEAVY_SOURCE>;
export const KNOWLEDGE_HEAVY_SOURCES = Object.freeze(Object.values(KNOWLEDGE_HEAVY_SOURCE));
export const isKnowledgeHeavySource = (value: unknown): value is KnowledgeHeavySource =>
  memberOf(KNOWLEDGE_HEAVY_SOURCES, value);

export const ACCEPTANCE_PRIORITY = Object.freeze({
  MUST: "MUST",
  SHOULD: "SHOULD",
  NICE: "NICE",
} as const);
export type AcceptancePriority = ValueOf<typeof ACCEPTANCE_PRIORITY>;
export const ACCEPTANCE_PRIORITIES = Object.freeze(Object.values(ACCEPTANCE_PRIORITY));
export const isAcceptancePriority = (value: unknown): value is AcceptancePriority =>
  memberOf(ACCEPTANCE_PRIORITIES, value);

export const SECURITY_CONSENT = Object.freeze({
  RUN: "run",
  SKIP: "skip",
  ABSTAIN: "abstain",
} as const);
export type SecurityConsent = ValueOf<typeof SECURITY_CONSENT>;
export const SECURITY_CONSENTS = Object.freeze(Object.values(SECURITY_CONSENT));
export const isSecurityConsent = (value: unknown): value is SecurityConsent =>
  memberOf(SECURITY_CONSENTS, value);

export const SECURITY_VERDICT = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  NEEDS_REVIEW: "needs-review",
  SKIPPED: "skipped",
  ERROR: "error",
} as const);
export type SecurityVerdict = ValueOf<typeof SECURITY_VERDICT>;
export const SECURITY_VERDICTS = Object.freeze(Object.values(SECURITY_VERDICT));
export const isSecurityVerdict = (value: unknown): value is SecurityVerdict =>
  memberOf(SECURITY_VERDICTS, value);

export const WORK_UNIT_GATE = Object.freeze({
  BUILD: "build",
  LINT: "lint",
  TEST: "test",
  REVIEW: "review",
  SECURITY: "security",
  GOAL_EVAL: "goal_eval",
} as const);
export type WorkUnitGateName = ValueOf<typeof WORK_UNIT_GATE>;
export const WORK_UNIT_GATES = Object.freeze(Object.values(WORK_UNIT_GATE));
export const REQUIRED_WORK_UNIT_GATES = Object.freeze([
  WORK_UNIT_GATE.BUILD,
  WORK_UNIT_GATE.LINT,
  WORK_UNIT_GATE.TEST,
  WORK_UNIT_GATE.REVIEW,
] as const);
export type RequiredWorkUnitGateName = (typeof REQUIRED_WORK_UNIT_GATES)[number];
export const PENDING_REQUIRED_WORK_UNIT_GATES = Object.freeze({
  [WORK_UNIT_GATE.BUILD]: GATE_STATE.PENDING,
  [WORK_UNIT_GATE.LINT]: GATE_STATE.PENDING,
  [WORK_UNIT_GATE.TEST]: GATE_STATE.PENDING,
  [WORK_UNIT_GATE.REVIEW]: GATE_STATE.PENDING,
} satisfies Record<RequiredWorkUnitGateName, typeof GATE_STATE.PENDING>);
/** Measured implementation gates checked before the independent reviewer runs. */
export const PRE_REVIEW_WORK_UNIT_GATES = Object.freeze([
  WORK_UNIT_GATE.BUILD,
  WORK_UNIT_GATE.LINT,
  WORK_UNIT_GATE.TEST,
] as const);
export const isWorkUnitGateName = (value: unknown): value is WorkUnitGateName =>
  memberOf(WORK_UNIT_GATES, value);

export const WORKFLOW_DASHBOARD_STATUS = Object.freeze({
  RUNNING: WORK_UNIT_STATUS.RUNNING,
  BLOCKED: WORK_UNIT_STATUS.BLOCKED,
  PENDING: WORK_UNIT_STATUS.PENDING,
  DONE: WORK_UNIT_STATUS.DONE,
} as const);
export type WorkflowDashboardStatus = ValueOf<typeof WORKFLOW_DASHBOARD_STATUS>;
export const WORKFLOW_DASHBOARD_STATUSES = Object.freeze(Object.values(WORKFLOW_DASHBOARD_STATUS));
export const isWorkflowDashboardStatus = (value: unknown): value is WorkflowDashboardStatus =>
  memberOf(WORKFLOW_DASHBOARD_STATUSES, value);
