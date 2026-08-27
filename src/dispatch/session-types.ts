import type { RoleSandbox } from "../agents/role.js";
import type { Engine } from "../core.js";
import type {
  CONVERSATION_OPERATION_STATE,
  ConversationOperationStateV1,
  ConversationReconciliationStatusV1,
} from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { type EnvPolicy, isConversationEnvPolicy } from "./env-filter.js";
import type { OwnedProcessPlatform } from "./owned-process-platform.js";
import type { OwnedProcessController, OwnedProcessReleaseProof } from "./owned-process-runtime.js";
import type { OwnedSupervisorExitOutcome } from "./owned-process-status.js";
import {
  type ENGINE_SESSION_SCHEMA_VERSION,
  type EngineAttemptStartOutcome,
  type EngineEvidenceStatus,
  type EngineIsolationKind,
  type EngineNativeSessionStatus,
  type EngineOutputStream,
  type EngineRoleSource,
  type EngineSessionMode,
  type EngineSessionProtocol,
  isEngineRoleSource,
} from "./session-contract.js";
import type { EngineTerminalObservation } from "./session-terminal.js";
import type { EngineSummary } from "./types.js";

export type SessionMode = EngineSessionMode;

export interface IsolationLeaseProjection {
  kind: EngineIsolationKind;
  cwd: string;
  evidence_ref: string;
}

export interface SessionProvenance {
  roleSource: EngineRoleSource;
  roleHash: string;
  skillHashes: string[];
}

export interface SessionTraceMetadata {
  role_resolved_hash: string;
  skill_resolved_hashes: string[];
}

export interface SpawnOptionsProjection {
  engine: Engine;
  model: string | null;
  sessionMode: SessionMode;
  rendered_prompt: string;
  rendered_tools: string[];
  sandbox: RoleSandbox | null;
  env_policy: EnvPolicy;
  isolation: IsolationLeaseProjection | null;
  provenance: SessionProvenance;
  trace_metadata: SessionTraceMetadata;
}

export type SpawnOptionsInput = {
  engine: Engine;
  model: string | null;
  sessionMode: SessionMode;
  rendered_prompt: string;
  rendered_tools: readonly string[];
  sandbox: RoleSandbox | null;
  env_policy: EnvPolicy;
  isolation: IsolationLeaseProjection | null;
  provenance: Readonly<SessionProvenance>;
  trace_metadata: Readonly<SessionTraceMetadata>;
};

const canonicalSpawnProjections = new WeakSet<object>();
const modelCredential =
  /(?:^|[._/@:+-])(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|A[KS]IA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{20,})(?=$|[._/@:+-])|(?:^|[._/@:+-])(?:token|secret|password|credential|api[_-]?key|access[_-]?key)(?:$|[._/@:+-])/i;
const localModelPath =
  /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|(?:src|test|tests|docs|lib|dist|build|private|artifacts?|evidence|coverage|scripts?|config)[\\/])/i;

function isSafeModelIdentifier(value: string): boolean {
  return (
    value.length >= 1 &&
    Buffer.byteLength(value, "utf8") <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !localModelPath.test(value) &&
    !modelCredential.test(value)
  );
}

/** Create the only runtime-authorized, immutable conversation spawn projection. */
export function createSpawnOptionsProjection(input: SpawnOptionsInput): SpawnOptionsProjection {
  if (!isConversationEnvPolicy(input.env_policy, input.engine)) {
    throw new Error("spawn.env_policy must be canonical conversation authority");
  }
  if (!isEngineRoleSource(input.provenance.roleSource)) {
    throw new Error("spawn provenance roleSource must be builtin or repo");
  }
  if (input.model !== null && !isSafeModelIdentifier(input.model)) {
    throw new Error("spawn model must be a safe engine identifier");
  }
  const provenance = Object.freeze({
    roleSource: input.provenance.roleSource,
    roleHash: input.provenance.roleHash,
    skillHashes: Object.freeze([...input.provenance.skillHashes]) as unknown as string[],
  });
  const traceMetadata = Object.freeze({
    role_resolved_hash: input.trace_metadata.role_resolved_hash,
    skill_resolved_hashes: Object.freeze([
      ...input.trace_metadata.skill_resolved_hashes,
    ]) as unknown as string[],
  });
  const projection: SpawnOptionsProjection = Object.freeze({
    engine: input.engine,
    model: input.model,
    sessionMode: input.sessionMode,
    rendered_prompt: input.rendered_prompt,
    rendered_tools: Object.freeze([...input.rendered_tools]) as unknown as string[],
    sandbox: input.sandbox,
    env_policy: input.env_policy,
    isolation: input.isolation,
    provenance,
    trace_metadata: traceMetadata,
  });
  canonicalSpawnProjections.add(projection);
  return projection;
}

export function isCanonicalSpawnOptionsProjection(projection: SpawnOptionsProjection): boolean {
  return canonicalSpawnProjections.has(projection);
}

export type OperationLifecycleState = ConversationOperationStateV1;

export interface AttemptProcessRelease {
  proof: OwnedProcessReleaseProof | null;
  terminal: EngineTerminalObservation | null;
}

export interface EngineChunk {
  stream: EngineOutputStream;
  /** Public-safe, newline-framed content. Incomplete control records stay buffered. */
  content: string;
}

export interface InternalResumeBinding {
  attemptId: string;
  engine: Engine;
  nativeSessionId: string;
}

export interface EngineSessionResult {
  attemptId: string;
  engine: Engine;
  ok: boolean;
  state:
    | typeof CONVERSATION_OPERATION_STATE.COMPLETED
    | typeof CONVERSATION_OPERATION_STATE.AMBIGUOUS;
  lifecycle: OperationLifecycleState[];
  output: string;
  summary?: EngineSummary;
  reason?: string;
  evidenceStatus: EngineEvidenceStatus;
  nativeSessionStatus: EngineNativeSessionStatus;
}

export interface AttemptHandle<T = EngineSessionResult> {
  readonly attemptId: string;
  readonly completion: Promise<T>;
  terminate(reason?: string): Promise<void>;
  /** Internal-only resume channel. Public DTO/evidence must never serialize this binding. */
  readResumeBinding(): InternalResumeBinding | undefined;
  /** Internal-only durable evidence channel. Public result never contains this path/ref. */
  readEvidenceBinding(): { attemptId: string; internalRef: string } | undefined;
}

export interface AttemptStartAuthorityRecordV1 {
  schema_version: typeof ENGINE_SESSION_SCHEMA_VERSION;
  attempt_id: string;
  engine: Engine;
  outcome: EngineAttemptStartOutcome;
  native_session_id: string | null;
  evidence_ref: string;
  evidence_sha256: string;
  process_quiescent: true;
  recorded_at: string;
  record_digest: string;
}

/** Branded reader minted only from the concrete adapter-owned durable evidence store. */
export interface DurableAttemptStartAuthorityReaderV1 {
  read(attemptId: string): AttemptStartAuthorityRecordV1 | null;
}

export interface EngineSessionRequest {
  attemptId: string;
  spawn: SpawnOptionsProjection;
  nativeSessionId?: string;
  signal: AbortSignal;
  /** Receives only public-safe EngineChunk values; raw process chunks remain adapter-internal. */
  onChunk?: (chunk: EngineChunk) => void;
  onLifecycle?: (state: OperationLifecycleState) => void;
}

export interface HistoryReconcileRequest {
  engine: Engine;
  nativeSessionId: string;
  history?: readonly unknown[];
}

export interface HistoryReconcileResult {
  status: ConversationReconciliationStatusV1;
  imported_turn_count: number;
  imported_tool_count: number;
  completeness_reason: string;
}

export interface EngineSessionAdapter {
  start(request: EngineSessionRequest): AttemptHandle;
  reconcileHistory(request: HistoryReconcileRequest): Promise<HistoryReconcileResult>;
  /** Absent means this adapter is ineligible for revision start/retry authority. */
  readonly startAuthority?: DurableAttemptStartAuthorityReaderV1;
}

export interface EngineProcess {
  pid?: number;
  /** Startup I/O failed after spawn; the adapter still owns and must reap this process. */
  startupError?: Error;
  /** Typed owned-supervisor terminal outcome, including whether stream drain was proved. */
  rootExited?: Promise<OwnedSupervisorExitOutcome>;
  stdin?: { write(value: string | Uint8Array): unknown; end(): unknown } | null;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface EngineProcessSpawnOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdinText: string;
  detached: boolean;
  ownedRuntime?: OwnedProcessController;
}

export type EngineProcessSpawner = (
  argv: string[],
  options: EngineProcessSpawnOptions,
) => EngineProcess;

export interface EngineSessionAdapterOptions {
  spawn?: EngineProcessSpawner;
  sourceEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  graceMs?: number;
  /** Bridge commands acknowledge at successful process exit rather than native session protocol. */
  protocol?: EngineSessionProtocol;
  /** The configured spawner creates a detached process group owned by this adapter. */
  ownsProcessGroup?: boolean;
  evidenceRoot?: string;
  /** Trusted private root for bounded, lifecycle-owned Copilot argv prompt files. */
  privatePromptFileRoot?: string;
  historyRoots?: Partial<Record<Engine, readonly string[]>>;
  ownedProcessPlatform?: OwnedProcessPlatform;
  writeEvidence?: (
    attemptId: string,
    evidence: Readonly<Record<string, unknown>>,
  ) => string | Promise<string>;
}
