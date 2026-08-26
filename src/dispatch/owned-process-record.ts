import { readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { Engine } from "../core.js";
import {
  acquireProcessLock,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../durability/index.js";
import {
  OWNED_PROCESS_LIMIT,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_PROOF_STRENGTHS,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_QUIESCENCE_SCOPES,
  OWNED_PROCESS_SCHEMA_VERSION,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STATES,
  OWNED_PROCESS_STRATEGIES,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TERMINAL_KINDS,
  type OwnedProcessState,
  type OwnedProcessTerminalKind,
} from "./owned-process-contract.js";
import type { OwnedProcessPlatform } from "./owned-process-platform.js";

const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LEGACY_PRIOR_DIGEST_MISSING = Symbol("owned-process-legacy-prior-digest-missing");
const LEGACY_PROOF_BINDING_MISSING = Symbol("owned-process-legacy-proof-binding-missing");
export type { OwnedProcessState } from "./owned-process-contract.js";

export interface OwnedAttemptProcessRecordV1 {
  schema_version: typeof OWNED_PROCESS_SCHEMA_VERSION;
  attempt_id: string;
  engine: Engine;
  host: string;
  platform: NodeJS.Platform;
  strategy: OwnedProcessPlatform["strategy"];
  quiescence_scope: (typeof OWNED_PROCESS_QUIESCENCE_SCOPES)[number];
  proof_strength: (typeof OWNED_PROCESS_PROOF_STRENGTHS)[number];
  owner_pid: number;
  owner_identity: string;
  supervisor_pid: number | null;
  supervisor_identity: string | null;
  cli_pid: number | null;
  cli_identity: string | null;
  terminal_kind: OwnedProcessTerminalKind | null;
  state: OwnedProcessState;
  release_reason: string | null;
  exit_code: number | null;
  process_quiescent: boolean;
  prior_record_digest: string | null;
  recorded_at: string;
  updated_at: string;
  record_digest: string;
}

export interface OwnedProcessReleaseProof {
  process_quiescent: true;
  strategy: OwnedProcessPlatform["strategy"];
  quiescence_scope: OwnedAttemptProcessRecordV1["quiescence_scope"];
  proof_strength: OwnedAttemptProcessRecordV1["proof_strength"];
  runtime_record_digest: string;
  released_record_digest: string;
  release_verifier: string;
  terminal_kind: OwnedProcessTerminalKind | null;
  exit_code: number | null;
  released_at: string;
}

function key(attemptId: string): string {
  return digestV1("VF-OWNED-CLI-RUNTIME-KEY\0v1\0", { attempt_id: attemptId }).slice(7);
}

function recordDigest(value: Omit<OwnedAttemptProcessRecordV1, "record_digest">): string {
  return digestV1("VF-OWNED-CLI-RUNTIME\0v1\0", value);
}

function legacyRecordDigest(value: Omit<OwnedAttemptProcessRecordV1, "record_digest">): string {
  const { prior_record_digest: _ignored, ...legacy } = value;
  return digestV1("VF-OWNED-CLI-RUNTIME\0v1\0", legacy);
}

export function ownedProcessTimestamp(): string {
  return new Date().toISOString();
}

export function ownedProcessPreimage(
  record: OwnedAttemptProcessRecordV1,
): Omit<OwnedAttemptProcessRecordV1, "record_digest"> {
  const { record_digest: _ignored, ...value } = record;
  return value;
}

export function buildOwnedProcessRecord(
  value: Omit<OwnedAttemptProcessRecordV1, "record_digest">,
): OwnedAttemptProcessRecordV1 {
  const record = { ...value, record_digest: recordDigest(value) };
  assertOwnedProcessRecord(record);
  return record;
}

export function assertOwnedProcessRecord(
  value: unknown,
): asserts value is OwnedAttemptProcessRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid owned process record");
  const row = value as OwnedAttemptProcessRecordV1;
  const hasQuiescenceScope = Object.prototype.hasOwnProperty.call(row, "quiescence_scope");
  const hasProofStrength = Object.prototype.hasOwnProperty.call(row, "proof_strength");
  const isLegacyUnscoped = !hasQuiescenceScope && !hasProofStrength;
  const hasLegacyProofBinding =
    row.quiescence_scope === OWNED_PROCESS_QUIESCENCE_SCOPE.LEGACY_UNSCOPED &&
    row.proof_strength === OWNED_PROCESS_PROOF_STRENGTH.LEGACY_UNQUALIFIED;
  const hasQualifiedProofBinding =
    (row.strategy === OWNED_PROCESS_STRATEGY.WINDOWS_TREE &&
      row.quiescence_scope === OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB &&
      row.proof_strength === OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED) ||
    (row.strategy === OWNED_PROCESS_STRATEGY.POSIX_SESSION &&
      row.quiescence_scope === OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP &&
      row.proof_strength === OWNED_PROCESS_PROOF_STRENGTH.COOPERATIVE_LINEAGE);
  if (
    row.schema_version !== OWNED_PROCESS_SCHEMA_VERSION ||
    !ATTEMPT_ID.test(row.attempt_id) ||
    typeof row.host !== "string" ||
    typeof row.platform !== "string" ||
    !OWNED_PROCESS_STRATEGIES.includes(row.strategy) ||
    hasQuiescenceScope !== hasProofStrength ||
    (!isLegacyUnscoped && !OWNED_PROCESS_QUIESCENCE_SCOPES.includes(row.quiescence_scope)) ||
    (!isLegacyUnscoped && !OWNED_PROCESS_PROOF_STRENGTHS.includes(row.proof_strength)) ||
    (!hasQualifiedProofBinding &&
      !(
        row.state === OWNED_PROCESS_STATE.RELEASED &&
        (isLegacyUnscoped || hasLegacyProofBinding)
      )) ||
    !Number.isSafeInteger(row.owner_pid) ||
    row.owner_pid < 1 ||
    typeof row.owner_identity !== "string" ||
    (row.supervisor_pid !== null &&
      (!Number.isSafeInteger(row.supervisor_pid) || row.supervisor_pid < 1)) ||
    (row.supervisor_identity !== null && typeof row.supervisor_identity !== "string") ||
    (row.cli_pid !== null && (!Number.isSafeInteger(row.cli_pid) || row.cli_pid < 1)) ||
    (row.cli_identity !== null && typeof row.cli_identity !== "string") ||
    (row.terminal_kind !== null && !OWNED_PROCESS_TERMINAL_KINDS.includes(row.terminal_kind)) ||
    !OWNED_PROCESS_STATES.includes(row.state) ||
    (row.release_reason !== null && typeof row.release_reason !== "string") ||
    (row.exit_code !== null && !Number.isSafeInteger(row.exit_code)) ||
    typeof row.process_quiescent !== "boolean" ||
    (row.prior_record_digest != null && !DIGEST.test(row.prior_record_digest)) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(row.recorded_at) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(row.updated_at) ||
    !DIGEST.test(row.record_digest) ||
    (row.state === OWNED_PROCESS_STATE.RUNNING &&
      (!row.supervisor_pid || !row.supervisor_identity || !row.cli_pid || !row.cli_identity)) ||
    (row.state === OWNED_PROCESS_STATE.RELEASED && row.process_quiescent !== true) ||
    (row.state !== OWNED_PROCESS_STATE.RELEASED && row.process_quiescent !== false)
  ) {
    throw new Error("invalid owned process record");
  }
  const { record_digest, ...preimage } = row;
  if (
    recordDigest({ ...preimage, prior_record_digest: row.prior_record_digest ?? null }) !==
      record_digest &&
    !(
      row.prior_record_digest === undefined &&
      legacyRecordDigest(preimage as never) === record_digest
    )
  ) {
    throw new Error("invalid owned process digest");
  }
}

type StoredOwnedAttemptProcessRecord = OwnedAttemptProcessRecordV1 & {
  [LEGACY_PRIOR_DIGEST_MISSING]?: true;
  [LEGACY_PROOF_BINDING_MISSING]?: true;
};

function expectedCurrentBytes(
  current: StoredOwnedAttemptProcessRecord,
): Uint8Array<ArrayBufferLike> {
  if (!current[LEGACY_PRIOR_DIGEST_MISSING] && !current[LEGACY_PROOF_BINDING_MISSING])
    return canonicalJsonBytes(current);
  if (current[LEGACY_PRIOR_DIGEST_MISSING] && current[LEGACY_PROOF_BINDING_MISSING]) {
    const {
      prior_record_digest: _prior,
      proof_strength: _strength,
      quiescence_scope: _scope,
      ...legacy
    } = current;
    return canonicalJsonBytes(legacy);
  }
  if (current[LEGACY_PRIOR_DIGEST_MISSING]) {
    const { prior_record_digest: _prior, ...legacy } = current;
    return canonicalJsonBytes(legacy);
  }
  const { proof_strength: _strength, quiescence_scope: _scope, ...legacy } = current;
  return canonicalJsonBytes(legacy);
}

export class OwnedProcessRecordStore {
  readonly root: string;
  private readonly recordsRoot: string;
  private readonly lockPath: string;

  constructor(root: string) {
    this.root = ensurePrivateDirectory(resolve(root));
    this.recordsRoot = ensurePrivateDirectory(join(this.root, "process-runtime"));
    this.lockPath = join(this.recordsRoot, "writer.lock");
  }

  reserve(
    attemptId: string,
    engine: Engine,
    platform: OwnedProcessPlatform,
  ): OwnedAttemptProcessRecordV1 {
    const ownerIdentity = platform.observe(process.pid)?.identity;
    if (!ownerIdentity) throw new Error("process start identity is unavailable");
    const now = ownedProcessTimestamp();
    const record = buildOwnedProcessRecord({
      schema_version: OWNED_PROCESS_SCHEMA_VERSION,
      attempt_id: attemptId,
      engine,
      host: hostname(),
      platform: platform.platform,
      strategy: platform.strategy,
      quiescence_scope:
        platform.quiescenceScope ??
        (platform.strategy === OWNED_PROCESS_STRATEGY.WINDOWS_TREE
          ? OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB
          : OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP),
      proof_strength:
        platform.proofStrength ??
        (platform.strategy === OWNED_PROCESS_STRATEGY.WINDOWS_TREE
          ? OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED
          : OWNED_PROCESS_PROOF_STRENGTH.COOPERATIVE_LINEAGE),
      owner_pid: process.pid,
      owner_identity: ownerIdentity,
      supervisor_pid: null,
      supervisor_identity: null,
      cli_pid: null,
      cli_identity: null,
      terminal_kind: null,
      state: OWNED_PROCESS_STATE.RESERVED,
      release_reason: null,
      exit_code: null,
      process_quiescent: false,
      prior_record_digest: null,
      recorded_at: now,
      updated_at: now,
    });
    this.write(attemptId, null, record);
    return record;
  }

  read(attemptId: string): OwnedAttemptProcessRecordV1 | null {
    return this.readEntry(`${key(attemptId)}.json`);
  }

  entries(): string[] {
    return readdirSync(this.recordsRoot).filter((entry) => entry.endsWith(".json"));
  }

  readEntry(entry: string): OwnedAttemptProcessRecordV1 | null {
    const bytes = privateFileBytes(
      join(this.recordsRoot, entry),
      OWNED_PROCESS_LIMIT.MAX_RECORD_BYTES,
    );
    if (!bytes) return null;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertOwnedProcessRecord(value);
    if (!canonicalJsonBytes(value).equals(bytes)) throw new Error("owned process record changed");
    const missingPriorDigest = !Object.prototype.hasOwnProperty.call(
      value as object,
      "prior_record_digest",
    );
    const missingProofBinding =
      !Object.prototype.hasOwnProperty.call(value as object, "quiescence_scope") &&
      !Object.prototype.hasOwnProperty.call(value as object, "proof_strength");
    const normalized = structuredClone(
      value as OwnedAttemptProcessRecordV1,
    ) as StoredOwnedAttemptProcessRecord;
    if (missingPriorDigest) {
      normalized.prior_record_digest = null;
      Object.defineProperty(normalized, LEGACY_PRIOR_DIGEST_MISSING, { value: true });
    }
    if (missingProofBinding) {
      normalized.quiescence_scope = OWNED_PROCESS_QUIESCENCE_SCOPE.LEGACY_UNSCOPED;
      normalized.proof_strength = OWNED_PROCESS_PROOF_STRENGTH.LEGACY_UNQUALIFIED;
      Object.defineProperty(normalized, LEGACY_PROOF_BINDING_MISSING, { value: true });
    }
    return normalized;
  }

  listOpenRecords(): OwnedAttemptProcessRecordV1[] {
    return this.entries()
      .map((entry) => this.readEntry(entry))
      .filter((record): record is OwnedAttemptProcessRecordV1 => Boolean(record))
      .filter((record) => record.state !== OWNED_PROCESS_STATE.RELEASED);
  }

  write(
    attemptId: string,
    current: OwnedAttemptProcessRecordV1 | null,
    next: OwnedAttemptProcessRecordV1,
  ): void {
    const lock = acquireProcessLock(this.lockPath, { operation: `owned-process:${attemptId}` });
    try {
      atomicCompareAndSwap(
        join(this.recordsRoot, `${key(attemptId)}.json`),
        current ? expectedCurrentBytes(current as StoredOwnedAttemptProcessRecord) : null,
        canonicalJsonBytes(next),
        { lock, maxBytes: OWNED_PROCESS_LIMIT.MAX_RECORD_BYTES },
      );
    } finally {
      lock.release();
    }
  }
}
