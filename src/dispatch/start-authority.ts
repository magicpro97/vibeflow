import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Engine } from "../core.js";
import { isAgentEngine } from "../core/agent-contract.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
  sha256Digest,
} from "../durability/index.js";
import {
  ENGINE_ATTEMPT_START_OUTCOME,
  ENGINE_SESSION_SCHEMA_VERSION,
  isEngineAttemptStartOutcome,
} from "./session-contract.js";
import type {
  AttemptStartAuthorityRecordV1,
  DurableAttemptStartAuthorityReaderV1,
} from "./session-types.js";

const MAX_RECORD_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const ATTEMPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function key(attemptId: string): string {
  return digestV1("VF-ATTEMPT-START-AUTHORITY-KEY\0v1\0", { attempt_id: attemptId }).slice(7);
}

function assertRecord(value: unknown): asserts value is AttemptStartAuthorityRecordV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid attempt start authority record");
  const row = value as unknown as AttemptStartAuthorityRecordV1;
  if (
    Object.keys(row).sort().join(",") !==
      [
        "attempt_id",
        "engine",
        "evidence_ref",
        "evidence_sha256",
        "native_session_id",
        "outcome",
        "process_quiescent",
        "record_digest",
        "recorded_at",
        "schema_version",
      ]
        .sort()
        .join(",") ||
    row.schema_version !== ENGINE_SESSION_SCHEMA_VERSION ||
    !ATTEMPT_ID.test(row.attempt_id) ||
    !isAgentEngine(row.engine) ||
    !isEngineAttemptStartOutcome(row.outcome) ||
    (row.native_session_id !== null &&
      (typeof row.native_session_id !== "string" || row.native_session_id.length === 0)) ||
    typeof row.evidence_ref !== "string" ||
    !DIGEST.test(row.evidence_sha256) ||
    row.process_quiescent !== true ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.recorded_at) ||
    !DIGEST.test(row.record_digest) ||
    (row.outcome === ENGINE_ATTEMPT_START_OUTCOME.ACCEPTED) !== (row.native_session_id !== null)
  )
    throw new Error("invalid attempt start authority record");
  const { record_digest: _digest, ...preimage } = row;
  if (digestV1("VF-ATTEMPT-START-AUTHORITY\0v1\0", preimage) !== row.record_digest)
    throw new Error("invalid attempt start authority digest");
}

function evidenceBelongsToRoot(root: string, ref: string, optional: boolean): string | null {
  if (!isAbsolute(ref)) {
    if (optional) return null;
    throw new Error("attempt evidence is not rooted by the concrete adapter");
  }
  const absolute = resolve(ref);
  let owner: string;
  let expected: string;
  try {
    owner = realpathSync(dirname(absolute));
    expected = realpathSync(root);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const nested = relative(expected, owner);
  if (nested.startsWith("..") || resolve(expected, nested) !== owner)
    throw new Error("attempt evidence escapes adapter authority root");
  return absolute;
}

export class AttemptStartAuthorityStore {
  private readonly evidenceRoot: string;
  private readonly recordsRoot: string;
  private readonly lockPath: string;

  constructor(evidenceRoot: string) {
    this.evidenceRoot = ensurePrivateDirectory(resolve(evidenceRoot));
    this.recordsRoot = ensurePrivateDirectory(join(this.evidenceRoot, "start-authority"));
    this.lockPath = join(this.recordsRoot, "writer.lock");
  }

  record(input: {
    attempt_id: string;
    engine: Engine;
    outcome: AttemptStartAuthorityRecordV1["outcome"];
    native_session_id: string | null;
    evidence_ref: string;
    recorded_at?: string;
  }): AttemptStartAuthorityRecordV1 | null {
    if (!ATTEMPT_ID.test(input.attempt_id)) throw new Error("invalid attempt authority identity");
    const evidencePath = evidenceBelongsToRoot(this.evidenceRoot, input.evidence_ref, true);
    if (!evidencePath) return null;
    const evidence = privateFileBytes(evidencePath, MAX_EVIDENCE_BYTES);
    if (!evidence) throw new Error("attempt authority evidence is absent");
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidence));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { attempt_id?: unknown }).attempt_id !== input.attempt_id
    )
      throw new Error("attempt authority evidence identity changed");
    const preimage = {
      schema_version: ENGINE_SESSION_SCHEMA_VERSION,
      attempt_id: input.attempt_id,
      engine: input.engine,
      outcome: input.outcome,
      native_session_id: input.native_session_id,
      evidence_ref: evidencePath,
      evidence_sha256: sha256Digest(evidence),
      process_quiescent: true as const,
      recorded_at: input.recorded_at ?? new Date().toISOString(),
    };
    const record = {
      ...preimage,
      record_digest: digestV1("VF-ATTEMPT-START-AUTHORITY\0v1\0", preimage),
    };
    assertRecord(record);
    const lock = acquireProcessLock(this.lockPath, {
      operation: `attempt-start-authority:${input.attempt_id}`,
    });
    try {
      createOrVerifyPrivateFile(
        join(this.recordsRoot, `${key(input.attempt_id)}.json`),
        canonicalJsonBytes(record),
        { lock, maxBytes: MAX_RECORD_BYTES },
      );
    } finally {
      lock.release();
    }
    return structuredClone(record);
  }

  read(attemptId: string): AttemptStartAuthorityRecordV1 | null {
    if (!ATTEMPT_ID.test(attemptId)) throw new Error("invalid attempt authority identity");
    const bytes = privateFileBytes(
      join(this.recordsRoot, `${key(attemptId)}.json`),
      MAX_RECORD_BYTES,
    );
    if (!bytes) return null;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertRecord(value);
    if (value.attempt_id !== attemptId || !canonicalJsonBytes(value).equals(bytes))
      throw new Error("attempt start authority storage changed");
    const evidencePath = evidenceBelongsToRoot(this.evidenceRoot, value.evidence_ref, false);
    if (!evidencePath) throw new Error("attempt start authority evidence is absent");
    const evidence = privateFileBytes(evidencePath, MAX_EVIDENCE_BYTES);
    if (!evidence || sha256Digest(evidence) !== value.evidence_sha256)
      throw new Error("attempt start authority evidence changed");
    return structuredClone(value);
  }
}

const readers = new WeakSet<object>();

class DurableAttemptStartAuthorityReader implements DurableAttemptStartAuthorityReaderV1 {
  constructor(private readonly store: AttemptStartAuthorityStore) {
    if (Object.getPrototypeOf(store) !== AttemptStartAuthorityStore.prototype)
      throw new Error("attempt start authority store is not concrete");
    readers.add(this);
    Object.freeze(this);
  }

  read(attemptId: string): AttemptStartAuthorityRecordV1 | null {
    return this.store.read(attemptId);
  }
}

export function createDurableAttemptStartAuthorityReaderV1(
  store: AttemptStartAuthorityStore,
): DurableAttemptStartAuthorityReaderV1 {
  return new DurableAttemptStartAuthorityReader(store);
}

export function assertDurableAttemptStartAuthorityReaderV1(
  value: unknown,
): asserts value is DurableAttemptStartAuthorityReaderV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== DurableAttemptStartAuthorityReader.prototype ||
    !readers.has(value)
  )
    throw new Error("untrusted durable attempt start authority reader");
}
