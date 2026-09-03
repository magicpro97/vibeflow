import {
  PROCESS_START_IDENTITY_KIND,
  isProcessStartIdentity,
} from "../durability/process-identity-contract.js";
export { PROCESS_START_IDENTITY_WINDOWS_QUERY_STATUS as OWNED_WINDOWS_QUERY_STATUS } from "../durability/process-identity-contract.js";
export {
  OWNED_PROCESS_DIGEST_DOMAIN,
  OWNED_PROCESS_DIGEST_PREFIX,
  OWNED_PROCESS_LEGACY_OPTIONAL_RECORD_FIELDS,
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_RECORD_FIELDS,
  OWNED_PROCESS_RELEASE_PROOF_FIELD,
  OWNED_PROCESS_RELEASE_PROOF_FIELDS,
  OWNED_PROCESS_STORAGE_NAME,
  hasExactOwnedProcessRecordFields,
  isOwnedProcessRecordFileName,
  ownedProcessJsonFileName,
  ownedProcessRuntimeFileNames,
} from "./owned-process-persistence-contract.js";
export type {
  OwnedProcessRecordField,
  OwnedProcessReleaseProofField,
} from "./owned-process-persistence-contract.js";

export const OWNED_PROCESS_IDENTITY_PREFIX = Object.freeze({
  WINDOWS_EXITED_RECEIPT: PROCESS_START_IDENTITY_KIND.WINDOWS_EXITED_RECEIPT,
} as const);

export const OWNED_PROCESS_SCHEMA_VERSION = "1.0" as const;

export type OwnedProcessSchemaVersionV1 = typeof OWNED_PROCESS_SCHEMA_VERSION;

export const OWNED_PROCESS_STATE = Object.freeze({
  RESERVED: "reserved",
  RUNNING: "running",
  RELEASED: "released",
  UNCERTAIN: "uncertain",
} as const);

export type OwnedProcessState = (typeof OWNED_PROCESS_STATE)[keyof typeof OWNED_PROCESS_STATE];

export const OWNED_PROCESS_STATES = Object.freeze(
  Object.values(OWNED_PROCESS_STATE),
) as readonly OwnedProcessState[];

export const OWNED_PROCESS_STRATEGY = Object.freeze({
  POSIX_SESSION: "posix-session",
  WINDOWS_TREE: "windows-tree",
} as const);

export type OwnedProcessStrategy =
  (typeof OWNED_PROCESS_STRATEGY)[keyof typeof OWNED_PROCESS_STRATEGY];

export const OWNED_PROCESS_STRATEGIES = Object.freeze(
  Object.values(OWNED_PROCESS_STRATEGY),
) as readonly OwnedProcessStrategy[];

export const OWNED_PROCESS_QUIESCENCE_SCOPE = Object.freeze({
  POSIX_PROCESS_GROUP: "posix-process-group",
  LINUX_CGROUP_V2: "linux-cgroup-v2",
  WINDOWS_JOB: "windows-job",
  LEGACY_UNSCOPED: "legacy-unscoped",
} as const);

export type OwnedProcessQuiescenceScope =
  (typeof OWNED_PROCESS_QUIESCENCE_SCOPE)[keyof typeof OWNED_PROCESS_QUIESCENCE_SCOPE];

export const OWNED_PROCESS_QUIESCENCE_SCOPES = Object.freeze(
  Object.values(OWNED_PROCESS_QUIESCENCE_SCOPE),
) as readonly OwnedProcessQuiescenceScope[];

export const OWNED_PROCESS_PROOF_STRENGTH = Object.freeze({
  COOPERATIVE_LINEAGE: "cooperative-lineage",
  KERNEL_CONTAINED: "kernel-contained",
  LEGACY_UNQUALIFIED: "legacy-unqualified",
} as const);

export type OwnedProcessProofStrength =
  (typeof OWNED_PROCESS_PROOF_STRENGTH)[keyof typeof OWNED_PROCESS_PROOF_STRENGTH];

export const OWNED_PROCESS_PROOF_STRENGTHS = Object.freeze(
  Object.values(OWNED_PROCESS_PROOF_STRENGTH),
) as readonly OwnedProcessProofStrength[];

export const OWNED_PROCESS_QUIESCENCE_MODE = Object.freeze({
  ACTIVE: "active",
  RECOVERY: "recovery",
} as const);

export type OwnedProcessQuiescenceMode =
  (typeof OWNED_PROCESS_QUIESCENCE_MODE)[keyof typeof OWNED_PROCESS_QUIESCENCE_MODE];

export const OWNED_PROCESS_QUIESCENCE_MODES = Object.freeze(
  Object.values(OWNED_PROCESS_QUIESCENCE_MODE),
) as readonly OwnedProcessQuiescenceMode[];

export const OWNED_SUPERVISOR_PHASE = Object.freeze({
  CLI_EXITED: "cli-exited",
  STREAMS_DRAINED: "streams-drained",
  FAILED: "supervisor-failed",
} as const);

export type OwnedSupervisorPhase =
  (typeof OWNED_SUPERVISOR_PHASE)[keyof typeof OWNED_SUPERVISOR_PHASE];

export const OWNED_SUPERVISOR_PHASES = Object.freeze(
  Object.values(OWNED_SUPERVISOR_PHASE),
) as readonly OwnedSupervisorPhase[];

export const OWNED_SUPERVISOR_TERMINAL_PHASE = Object.freeze({
  STREAMS_DRAINED: OWNED_SUPERVISOR_PHASE.STREAMS_DRAINED,
  SUPERVISOR_FAILED: OWNED_SUPERVISOR_PHASE.FAILED,
  STREAMS_DRAIN_UNPROVEN: "streams-drain-unproven",
  SUPERVISOR_EXITED_UNPROVEN: "supervisor-exited-unproven",
} as const);

export type OwnedSupervisorTerminalPhase =
  (typeof OWNED_SUPERVISOR_TERMINAL_PHASE)[keyof typeof OWNED_SUPERVISOR_TERMINAL_PHASE];

export const OWNED_SUPERVISOR_TERMINAL_PHASES = Object.freeze(
  Object.values(OWNED_SUPERVISOR_TERMINAL_PHASE),
) as readonly OwnedSupervisorTerminalPhase[];

export const OWNED_SUPERVISOR_RECEIPT_PHASE = Object.freeze({
  BIND_ACK: "bind-ack",
} as const);

export type OwnedSupervisorReceiptPhase =
  (typeof OWNED_SUPERVISOR_RECEIPT_PHASE)[keyof typeof OWNED_SUPERVISOR_RECEIPT_PHASE];

export const OWNED_SUPERVISOR_RECEIPT_PHASES = Object.freeze(
  Object.values(OWNED_SUPERVISOR_RECEIPT_PHASE),
) as readonly OwnedSupervisorReceiptPhase[];

export const OWNED_SUPERVISOR_RECEIPT_KEY = Object.freeze({
  PHASE: "phase",
  SUPERVISOR_PID: "supervisor_pid",
  CONTAINMENT: "containment",
  CLI_PID: "cli_pid",
  CLI_IDENTITY: "cli_identity",
  CLI_IDENTITY_STATE: "cli_identity_state",
  CLI_PGID: "cli_pgid",
} as const);

export type OwnedSupervisorReceiptKey =
  (typeof OWNED_SUPERVISOR_RECEIPT_KEY)[keyof typeof OWNED_SUPERVISOR_RECEIPT_KEY];

export const OWNED_SUPERVISOR_RECEIPT_KEYS = Object.freeze(
  Object.values(OWNED_SUPERVISOR_RECEIPT_KEY),
) as readonly OwnedSupervisorReceiptKey[];

export type OwnedSupervisorLaunchReceiptV1 = {
  [OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID]: number;
  [OWNED_SUPERVISOR_RECEIPT_KEY.CONTAINMENT]: OwnedProcessQuiescenceScope;
};

export type OwnedCliLaunchReceiptV1 = {
  [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID]: number;
  [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY]: string | null;
  [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY_STATE]: OwnedCliIdentityState;
  [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PGID]: number | null;
};

const exactWireFields =
  <Wire>() =>
  <const Fields extends readonly (keyof Wire)[]>(
    fields: Fields & (Exclude<keyof Wire, Fields[number]> extends never ? unknown : never),
  ): Readonly<Fields> =>
    Object.freeze(fields);

export const OWNED_SUPERVISOR_RECEIPT_FIELDS = Object.freeze({
  SUPERVISOR: exactWireFields<OwnedSupervisorLaunchReceiptV1>()([
    OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID,
    OWNED_SUPERVISOR_RECEIPT_KEY.CONTAINMENT,
  ] as const),
  CLI: exactWireFields<OwnedCliLaunchReceiptV1>()([
    OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID,
    OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY,
    OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY_STATE,
    OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PGID,
  ] as const),
} as const);

export const OWNED_SUPERVISOR_STATUS_KEY = Object.freeze({
  PHASE: "phase",
  EXIT_CODE: "exit_code",
} as const);

export type OwnedSupervisorStatusV1 = {
  [OWNED_SUPERVISOR_STATUS_KEY.PHASE]: OwnedSupervisorPhase;
  [OWNED_SUPERVISOR_STATUS_KEY.EXIT_CODE]: number;
};

export const OWNED_SUPERVISOR_STATUS_FIELDS = exactWireFields<OwnedSupervisorStatusV1>()([
  OWNED_SUPERVISOR_STATUS_KEY.PHASE,
  OWNED_SUPERVISOR_STATUS_KEY.EXIT_CODE,
] as const);

export const OWNED_CLI_IDENTITY_STATE = Object.freeze({
  AVAILABLE: "available",
  ABSENT_AFTER_PROBE: "absent-after-probe",
  UNKNOWN: "unknown",
} as const);

export type OwnedCliIdentityState =
  (typeof OWNED_CLI_IDENTITY_STATE)[keyof typeof OWNED_CLI_IDENTITY_STATE];

export const OWNED_CLI_IDENTITY_STATES = Object.freeze(
  Object.values(OWNED_CLI_IDENTITY_STATE),
) as readonly OwnedCliIdentityState[];

export const OWNED_PROCESS_PRESENCE_KIND = Object.freeze({
  PRESENT: "present",
  ABSENT: "absent",
  UNKNOWN: "unknown",
} as const);

export type OwnedProcessPresenceKind =
  (typeof OWNED_PROCESS_PRESENCE_KIND)[keyof typeof OWNED_PROCESS_PRESENCE_KIND];

export const OWNED_PROCESS_PRESENCE_KINDS = Object.freeze(
  Object.values(OWNED_PROCESS_PRESENCE_KIND),
) as readonly OwnedProcessPresenceKind[];

export const OWNED_SUPERVISOR_OUTCOME_KIND = Object.freeze({
  RUNNING: "running",
  EXITED: "exited",
  FAILED: "failed",
} as const);

export type OwnedSupervisorOutcomeKind =
  (typeof OWNED_SUPERVISOR_OUTCOME_KIND)[keyof typeof OWNED_SUPERVISOR_OUTCOME_KIND];

export const OWNED_SUPERVISOR_OUTCOME_KINDS = Object.freeze(
  Object.values(OWNED_SUPERVISOR_OUTCOME_KIND),
) as readonly OwnedSupervisorOutcomeKind[];

export const OWNED_PROCESS_EXIT_CODE = Object.freeze({
  SUPERVISOR_UNPROVEN: 1,
  SUPERVISOR_START_FAILED: 124,
  SUPERVISOR_FAILED: 125,
  OUTPUT_DRAIN_UNPROVEN: 125,
} as const);

export const OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE = Object.freeze({
  BROKEN_PIPE: "EPIPE",
  STREAM_DESTROYED: "ERR_STREAM_DESTROYED",
} as const);

export type OwnedProcessIgnorableStreamErrorCode =
  (typeof OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE)[keyof typeof OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE];

export const OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODES = Object.freeze(
  Object.values(OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE),
) as readonly OwnedProcessIgnorableStreamErrorCode[];

export const OWNED_PROCESS_TERMINAL_KIND = Object.freeze({
  CLAUDE_RESULT_SUCCESS: "claude-result-success",
  CODEX_TURN_COMPLETED: "codex-turn-completed",
  OUTPUT_DRAIN_UNPROVEN: "output-drain-unproven",
} as const);

export type OwnedProcessTerminalKind =
  (typeof OWNED_PROCESS_TERMINAL_KIND)[keyof typeof OWNED_PROCESS_TERMINAL_KIND];

export const OWNED_PROCESS_TERMINAL_KINDS = Object.freeze(
  Object.values(OWNED_PROCESS_TERMINAL_KIND),
) as readonly OwnedProcessTerminalKind[];

export const OWNED_PROCESS_ENV = Object.freeze({
  ARGV_BASE64: "VF_OWNED_ARGV_B64",
  BIND_ACK: "VF_OWNED_BIND_ACK",
  CWD: "VF_OWNED_CWD",
  RECEIPT: "VF_OWNED_RECEIPT",
  STATUS: "VF_OWNED_STATUS",
} as const);

export const OWNED_WINDOWS_LIMIT = Object.freeze({
  DIRECTORY_BUFFER_CHARS: 32_768,
} as const);

export const OWNED_WINDOWS_JOB = Object.freeze({
  ACTIVE_PROCESSES_OFFSET: 40,
  BASIC_ACCOUNTING_BYTES: 48,
  BASIC_ACCOUNTING_INFORMATION_CLASS: 1,
  EXTENDED_LIMIT_BYTES: 144,
  EXTENDED_LIMIT_INFORMATION_CLASS: 9,
  KILL_ON_JOB_CLOSE_FLAG: 0x00002000,
  LIMIT_FLAGS_OFFSET: 16,
  ONLY_SUPERVISOR_ACTIVE_COUNT: 1,
} as const);

export const OWNED_PROCESS_LIMIT = Object.freeze({
  IDENTITY_SETTLE_ATTEMPTS: 4,
  MAX_RECORD_BYTES: 64 * 1024,
} as const);

export const OWNED_PROCESS_TIMING_MS = Object.freeze({
  BIND_ACK_POLL: 10,
  CLI_RECEIPT_TIMEOUT: 12_000,
  OUTPUT_DRAIN_PROOF_TIMEOUT: 30_000,
  IDENTITY_SETTLE_POLL: 10,
  PARENT_REAP_HOLD_TICK: 1_000,
  PLATFORM_PROBE_TIMEOUT: 1_000,
  WINDOWS_COLD_START_PROBE_TIMEOUT: 10_000,
  REAP_POLL: 25,
  RECOVERY_GRACE: 250,
  SUPERVISOR_BOOT: 2_000,
  SUPERVISOR_STATUS_POLL: 10,
  TREE_TERMINATE_TIMEOUT: 3_000,
} as const);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isOwnedProcessState = (value: unknown): value is OwnedProcessState =>
  memberOf(OWNED_PROCESS_STATES, value);

export const isOwnedProcessStrategy = (value: unknown): value is OwnedProcessStrategy =>
  memberOf(OWNED_PROCESS_STRATEGIES, value);

export const isOwnedProcessQuiescenceScope = (
  value: unknown,
): value is OwnedProcessQuiescenceScope => memberOf(OWNED_PROCESS_QUIESCENCE_SCOPES, value);

export const isOwnedProcessProofStrength = (value: unknown): value is OwnedProcessProofStrength =>
  memberOf(OWNED_PROCESS_PROOF_STRENGTHS, value);

export const isOwnedProcessQuiescenceMode = (value: unknown): value is OwnedProcessQuiescenceMode =>
  memberOf(OWNED_PROCESS_QUIESCENCE_MODES, value);

export const isOwnedSupervisorPhase = (value: unknown): value is OwnedSupervisorPhase =>
  memberOf(OWNED_SUPERVISOR_PHASES, value);

export const isOwnedSupervisorTerminalPhase = (
  value: unknown,
): value is OwnedSupervisorTerminalPhase => memberOf(OWNED_SUPERVISOR_TERMINAL_PHASES, value);

export const isOwnedSupervisorReceiptPhase = (
  value: unknown,
): value is OwnedSupervisorReceiptPhase => memberOf(OWNED_SUPERVISOR_RECEIPT_PHASES, value);

export const isOwnedSupervisorReceiptKey = (value: unknown): value is OwnedSupervisorReceiptKey =>
  memberOf(OWNED_SUPERVISOR_RECEIPT_KEYS, value);

export const isOwnedCliIdentityState = (value: unknown): value is OwnedCliIdentityState =>
  memberOf(OWNED_CLI_IDENTITY_STATES, value);

export function isOwnedCliIdentityClaim(
  identity: unknown,
  identityState: unknown,
): identity is string | null {
  if (!isOwnedCliIdentityState(identityState)) return false;
  return identityState === OWNED_CLI_IDENTITY_STATE.AVAILABLE
    ? isProcessStartIdentity(identity)
    : identity === null;
}

export const isOwnedProcessPresenceKind = (value: unknown): value is OwnedProcessPresenceKind =>
  memberOf(OWNED_PROCESS_PRESENCE_KINDS, value);

export const isOwnedSupervisorOutcomeKind = (value: unknown): value is OwnedSupervisorOutcomeKind =>
  memberOf(OWNED_SUPERVISOR_OUTCOME_KINDS, value);

export const isOwnedProcessIgnorableStreamErrorCode = (
  value: unknown,
): value is OwnedProcessIgnorableStreamErrorCode =>
  memberOf(OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODES, value);

export const isOwnedProcessTerminalKind = (value: unknown): value is OwnedProcessTerminalKind =>
  memberOf(OWNED_PROCESS_TERMINAL_KINDS, value);
