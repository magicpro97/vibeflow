type ValueOf<Contract> = Contract[keyof Contract];

const values = <const Contract extends Readonly<Record<string, string | number>>>(
  contract: Contract,
) => Object.freeze(Object.values(contract)) as readonly ValueOf<Contract>[];

export const PUBLIC_ACTION_SCHEMA_VERSION = "1.0" as const;
export const ACTION_PREVIEW_PROJECTOR_VERSION = "vf-public-projector/1" as const;

export const ACTION_PROPOSAL_ID_PATTERN = Object.freeze(/^vf-proposal-[0-9a-f]{64}$/u);
export const ACTION_APPROVAL_ID_PATTERN = Object.freeze(/^vf-approval-[0-9a-f]{64}$/u);
export const ACTION_OPERATION_ID_PATTERN = Object.freeze(/^vf-operation-[0-9a-f]{64}$/u);
export const ACTION_CORRELATION_ID_PATTERN = Object.freeze(/^vf-correlation-[0-9a-f]{64}$/u);
export const ACTION_APPROVAL_CHALLENGE_ID_PATTERN = Object.freeze(/^[A-Za-z0-9_-]{43}$/u);
export const ACTION_APPROVAL_CHALLENGE_DISPLAY_SUFFIX_PATTERN = Object.freeze(/^[0-9a-f]{12}$/u);
export const ACTION_APPROVAL_CHALLENGE_DISPLAY_SUFFIX_LENGTH = 12 as const;
export const ACTION_RAW_SHA256_PATTERN = Object.freeze(/^[0-9a-f]{64}$/u);
export const SIGNED_CURSOR_PATTERN = Object.freeze(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);

export const ACTION_DOMAIN = Object.freeze({
  CONVERSATION: "conversation",
  CAPABILITY: "capability",
} as const);
export type ActionDomain = ValueOf<typeof ACTION_DOMAIN>;
export const ACTION_DOMAINS = values(ACTION_DOMAIN);

export const ACTION_SCOPE = Object.freeze({
  CONVERSATION: "conversation",
  PROJECT: "project",
  USER: "user",
} as const);
export type ActionScope = ValueOf<typeof ACTION_SCOPE>;
export const ACTION_SCOPES = values(ACTION_SCOPE);

export const ACTION_RISK = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
} as const);
export type ActionRisk = ValueOf<typeof ACTION_RISK>;
export const ACTION_RISKS = values(ACTION_RISK);
export const ACTION_RISK_RANK = Object.freeze({
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
  UNKNOWN: 4,
} as const);
export const ACTION_RISK_BY_RANK = Object.freeze([
  ACTION_RISK.LOW,
  ACTION_RISK.MEDIUM,
  ACTION_RISK.HIGH,
  ACTION_RISK.CRITICAL,
] as const satisfies readonly ActionRisk[]);

export const ACTION_AUTHORITY_BINDING_MODE = Object.freeze({
  CURRENT: "current",
  RECOVERY_CHECKPOINT: "recovery-checkpoint",
} as const);
export type ActionAuthorityBindingMode = ValueOf<typeof ACTION_AUTHORITY_BINDING_MODE>;
export const ACTION_AUTHORITY_BINDING_MODES = values(ACTION_AUTHORITY_BINDING_MODE);

export const ACTION_EFFECT_CLASS = Object.freeze({
  PURE_LOCAL_READ: "pure-local-read",
  LOCAL_READ_WITH_CACHE: "local-read-with-cache",
  NETWORK_READ: "network-read",
  PROCESS_PROBE: "process-probe",
  PROJECT_WRITE: "project-write",
  USER_WRITE: "user-write",
  EXTERNAL_COMPENSATABLE: "external-compensatable",
  EXTERNAL_IRREVERSIBLE: "external-irreversible",
} as const);
export type ActionEffectClass = ValueOf<typeof ACTION_EFFECT_CLASS>;
export const ACTION_EFFECT_CLASSES = values(ACTION_EFFECT_CLASS);
export const ACTION_EFFECT_RISK_RANK = Object.freeze({
  [ACTION_EFFECT_CLASS.PURE_LOCAL_READ]: ACTION_RISK_RANK.LOW,
  [ACTION_EFFECT_CLASS.LOCAL_READ_WITH_CACHE]: ACTION_RISK_RANK.LOW,
  [ACTION_EFFECT_CLASS.NETWORK_READ]: ACTION_RISK_RANK.LOW,
  [ACTION_EFFECT_CLASS.PROCESS_PROBE]: ACTION_RISK_RANK.LOW,
  [ACTION_EFFECT_CLASS.PROJECT_WRITE]: ACTION_RISK_RANK.MEDIUM,
  [ACTION_EFFECT_CLASS.USER_WRITE]: ACTION_RISK_RANK.HIGH,
  [ACTION_EFFECT_CLASS.EXTERNAL_COMPENSATABLE]: ACTION_RISK_RANK.HIGH,
  [ACTION_EFFECT_CLASS.EXTERNAL_IRREVERSIBLE]: ACTION_RISK_RANK.CRITICAL,
} as const satisfies Readonly<Record<ActionEffectClass, number>>);

export const ACTION_REVERSIBILITY_VALUE = Object.freeze({
  REVERSIBLE: "reversible",
  COMPENSATABLE: "compensatable",
  MANUAL: "manual",
  IRREVERSIBLE: "irreversible",
} as const);
export type Reversibility = ValueOf<typeof ACTION_REVERSIBILITY_VALUE>;
export const ACTION_REVERSIBILITY = values(ACTION_REVERSIBILITY_VALUE);
export const ACTION_REVERSIBILITY_RISK_RANK = Object.freeze({
  [ACTION_REVERSIBILITY_VALUE.REVERSIBLE]: ACTION_RISK_RANK.LOW,
  [ACTION_REVERSIBILITY_VALUE.COMPENSATABLE]: ACTION_RISK_RANK.MEDIUM,
  [ACTION_REVERSIBILITY_VALUE.MANUAL]: ACTION_RISK_RANK.HIGH,
  [ACTION_REVERSIBILITY_VALUE.IRREVERSIBLE]: ACTION_RISK_RANK.CRITICAL,
} as const satisfies Readonly<Record<Reversibility, number>>);

export const ACTION_PACKAGE_PIN_SOURCE_KIND = Object.freeze({
  REGISTRY: "registry",
  GIT: "git",
  LOCAL_DEV: "local-dev",
  LEGACY_ADOPT: "legacy-adopt",
} as const);
export type ActionPackagePinSourceKind = ValueOf<typeof ACTION_PACKAGE_PIN_SOURCE_KIND>;
export const ACTION_PACKAGE_PIN_SOURCE_KINDS = values(ACTION_PACKAGE_PIN_SOURCE_KIND);

export const ACTION_PACKAGE_PIN_TRUST_VALUE = Object.freeze({
  VERIFIED: "verified",
  SOURCE_PINNED: "source-pinned",
  DEV_UNVERIFIED: "dev-unverified",
  LEGACY_VERIFIED: "legacy-verified",
} as const);
export type ActionPackagePinTrust = ValueOf<typeof ACTION_PACKAGE_PIN_TRUST_VALUE>;
export const ACTION_PACKAGE_PIN_TRUST = values(ACTION_PACKAGE_PIN_TRUST_VALUE);

export const ACTION_DECISION = Object.freeze({ APPROVED: "approved", DENIED: "denied" } as const);
export type ActionDecision = ValueOf<typeof ACTION_DECISION>;
export const ACTION_DECISIONS = values(ACTION_DECISION);

export const ACTION_CHALLENGE_CLASS = Object.freeze({
  NORMAL_CONFIRM: "normal-confirm",
  FRESH_USER_SCOPE: "fresh-user-scope",
  PUBLIC_LITERAL: "public-literal",
  AUTOMATION_GRANT: "automation-grant",
  RECOVERY_TTY: "recovery-tty",
} as const);
export type ChallengeClass = ValueOf<typeof ACTION_CHALLENGE_CLASS>;
export const ACTION_CHALLENGE_CLASSES = values(ACTION_CHALLENGE_CLASS);
export const ACTION_APPROVAL_CHALLENGE_CLASSES = Object.freeze([
  ACTION_CHALLENGE_CLASS.FRESH_USER_SCOPE,
  ACTION_CHALLENGE_CLASS.PUBLIC_LITERAL,
] as const);
export type ActionApprovalChallengeClass = (typeof ACTION_APPROVAL_CHALLENGE_CLASSES)[number];
export const ACTION_APPROVAL_CHALLENGE_DISPLAY_PREFIX = Object.freeze({
  [ACTION_CHALLENGE_CLASS.FRESH_USER_SCOPE]: "user",
  [ACTION_CHALLENGE_CLASS.PUBLIC_LITERAL]: "publish",
} as const satisfies Readonly<Record<ActionApprovalChallengeClass, string>>);

export const ACTION_EXPECTED_SOURCE_MODE = Object.freeze({
  WRITABLE_REVISION: "writable-revision",
  LINEAGE_RECOVERY: "lineage-recovery",
} as const);
export type ActionExpectedSourceMode = ValueOf<typeof ACTION_EXPECTED_SOURCE_MODE>;
export const ACTION_EXPECTED_SOURCE_MODES = values(ACTION_EXPECTED_SOURCE_MODE);

export const ACTION_DELIVERY_VALUE = Object.freeze({
  NOT_APPLICABLE: "not-applicable",
  PENDING: "pending",
  DELIVERED: "delivered",
  FAILED: "failed",
} as const);
export type ActionDelivery = ValueOf<typeof ACTION_DELIVERY_VALUE>;
export const ACTION_DELIVERY = values(ACTION_DELIVERY_VALUE);

export const ACTOR_KIND = Object.freeze({
  HUMAN_BROWSER: "human-browser",
  HUMAN_CLI: "human-cli",
  AGENT: "agent",
  SYSTEM_RECOVERY: "system-recovery",
} as const);
export type ActorKind = ValueOf<typeof ACTOR_KIND>;
export const ACTOR_KINDS = values(ACTOR_KIND);

export const CREDENTIAL_CLASS = Object.freeze({
  LOOPBACK_SESSION: "loopback-session",
  INTERACTIVE_TTY: "interactive-tty",
  AUTOMATION_GRANT: "automation-grant",
  RECOVERY: "recovery",
} as const);
export type CredentialClass = ValueOf<typeof CREDENTIAL_CLASS>;
export const CREDENTIAL_CLASSES = values(CREDENTIAL_CLASS);

export const ACTION_PLANNING_MODE = Object.freeze({
  DURABLE: "durable",
  TRANSIENT: "transient",
} as const);
export type ActionPlanningMode = ValueOf<typeof ACTION_PLANNING_MODE>;
export const ACTION_PLANNING_MODES = values(ACTION_PLANNING_MODE);

export const ACTION_PLANNING_NETWORK_READ_VALUE = Object.freeze({
  ORDINARY_HOST_POLICY: "ordinary-host-policy",
  FORBID: "forbid",
  ALLOW_IF_GRANTED: "allow-if-granted",
} as const);
export type ActionPlanningNetworkRead = ValueOf<typeof ACTION_PLANNING_NETWORK_READ_VALUE>;
export const ACTION_PLANNING_NETWORK_READ = values(ACTION_PLANNING_NETWORK_READ_VALUE);
export const ACTION_PLANNING_TRANSIENT_NETWORK_READ = Object.freeze([
  ACTION_PLANNING_NETWORK_READ_VALUE.FORBID,
  ACTION_PLANNING_NETWORK_READ_VALUE.ALLOW_IF_GRANTED,
] as const);
export type ActionPlanningTransientNetworkRead =
  (typeof ACTION_PLANNING_TRANSIENT_NETWORK_READ)[number];

export const ACTION_TARGET_DISPOSITION_EXECUTION_VALUE = Object.freeze({
  HOST: "host",
  MANUAL: "manual",
  REQUIRED_USER_ACTION: "required-user-action",
  UNSUPPORTED: "unsupported",
} as const);
export type ActionTargetDispositionExecution = ValueOf<
  typeof ACTION_TARGET_DISPOSITION_EXECUTION_VALUE
>;
export const ACTION_TARGET_DISPOSITION_EXECUTION = values(
  ACTION_TARGET_DISPOSITION_EXECUTION_VALUE,
);

export const ACTION_TARGET_MANUAL_REASON = Object.freeze({
  MANUAL_CONFIG_CHANGE: "manual-config-change",
  MANUAL_RUNTIME_SETUP: "manual-runtime-setup",
  DISCLOSED_NOT_ENFORCED: "disclosed-not-enforced",
} as const);
export type ActionTargetManualReasonCode = ValueOf<typeof ACTION_TARGET_MANUAL_REASON>;
export const ACTION_TARGET_MANUAL_REASON_CODES = values(ACTION_TARGET_MANUAL_REASON);

export const ACTION_TARGET_REQUIRED_USER_ACTION_REASON = Object.freeze({
  NATIVE_INSTALL_REQUIRED: "native-install-required",
  EXTERNAL_CONFIRMATION_REQUIRED: "external-confirmation-required",
} as const);
export type ActionTargetRequiredUserActionReasonCode = ValueOf<
  typeof ACTION_TARGET_REQUIRED_USER_ACTION_REASON
>;
export const ACTION_TARGET_REQUIRED_USER_ACTION_REASON_CODES = values(
  ACTION_TARGET_REQUIRED_USER_ACTION_REASON,
);

export const ACTION_TARGET_UNSUPPORTED_REASON = Object.freeze({
  ADAPTER_UNAVAILABLE: "adapter-unavailable",
  ENFORCEMENT_UNAVAILABLE: "enforcement-unavailable",
  TARGET_UNSUPPORTED: "target-unsupported",
} as const);
export type ActionTargetUnsupportedReasonCode = ValueOf<typeof ACTION_TARGET_UNSUPPORTED_REASON>;
export const ACTION_TARGET_UNSUPPORTED_REASON_CODES = values(ACTION_TARGET_UNSUPPORTED_REASON);

export const ACTION_PERMISSION_CHANGE = Object.freeze({
  ADD: "add",
  REMOVE: "remove",
  EXPAND: "expand",
  NARROW: "narrow",
  UNCHANGED: "unchanged",
} as const);
export type ActionPermissionChange = ValueOf<typeof ACTION_PERMISSION_CHANGE>;
export const ACTION_PERMISSION_CHANGES = values(ACTION_PERMISSION_CHANGE);

export const ACTION_PERMISSION_ENFORCEMENT_VALUE = Object.freeze({
  BROKERED: "brokered",
  SANDBOXED: "sandboxed",
  ENGINE_ENFORCED: "engine-enforced",
  DISCLOSED_NOT_ENFORCED: "disclosed-not-enforced",
} as const);
export type ActionPermissionEnforcement = ValueOf<typeof ACTION_PERMISSION_ENFORCEMENT_VALUE>;
export const ACTION_PERMISSION_ENFORCEMENT = values(ACTION_PERMISSION_ENFORCEMENT_VALUE);
export const ACTION_RUNTIME_ENFORCEMENT_VALUE = Object.freeze({
  ...ACTION_PERMISSION_ENFORCEMENT_VALUE,
  UNSUPPORTED: ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.UNSUPPORTED,
} as const);
export type ActionRuntimeEnforcement = ValueOf<typeof ACTION_RUNTIME_ENFORCEMENT_VALUE>;
export const ACTION_RUNTIME_ENFORCEMENT = values(ACTION_RUNTIME_ENFORCEMENT_VALUE);

export const ACTION_DEPENDENCY_CHANGE = Object.freeze({
  ADD: "add",
  REMOVE: "remove",
  UPDATE: "update",
  UNCHANGED: "unchanged",
} as const);
export type ActionDependencyChange = ValueOf<typeof ACTION_DEPENDENCY_CHANGE>;
export const ACTION_DEPENDENCY_CHANGES = values(ACTION_DEPENDENCY_CHANGE);

export const ACTION_CONFIG_DIFF_MODE = Object.freeze({
  SURGICAL: "surgical",
  FULL_FILE: "full-file",
  MANUAL: "manual",
} as const);
export type ActionConfigDiffMode = ValueOf<typeof ACTION_CONFIG_DIFF_MODE>;
export const ACTION_CONFIG_DIFF_MODES = values(ACTION_CONFIG_DIFF_MODE);

export const ACTION_HEALTH_PLAN_KIND = Object.freeze({
  BINARY_VERSION: "binary-version",
  FILE_HASH: "file-hash",
  MCP_HANDSHAKE: "mcp-handshake",
  HOOK_SELFTEST: "hook-selftest",
  ROLE_PARSE: "role-parse",
  ENGINE_CONFIG: "engine-config",
} as const);
export type ActionHealthPlanKind = ValueOf<typeof ACTION_HEALTH_PLAN_KIND>;
export const ACTION_HEALTH_PLAN_KINDS = values(ACTION_HEALTH_PLAN_KIND);
export const ACTION_HEALTH_PLAN_RETRIES = Object.freeze([0, 1, 2] as const);
export type ActionHealthPlanRetry = (typeof ACTION_HEALTH_PLAN_RETRIES)[number];

export const ACTION_TIMELINE_ITEM_KIND = Object.freeze({
  REVISION_BOUNDARY: "revision-boundary",
  CONVERSATION_START: "conversation-start",
  CONVERSATION_EVENT: "conversation-event",
} as const);
export type ActionTimelineItemKind = ValueOf<typeof ACTION_TIMELINE_ITEM_KIND>;
export const ACTION_TIMELINE_ITEM_KINDS = values(ACTION_TIMELINE_ITEM_KIND);
