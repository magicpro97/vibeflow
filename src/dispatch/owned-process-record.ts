import { readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { Engine } from "../core/types.js";
import {
  acquireProcessLock,
  atomicCompareAndSwap,
  canonicalJsonBytes,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
} from "../durability/index.js";
import {
  OWNED_PROCESS_AUTHORITY_ERROR,
  assertOwnedProcessWriteTransition,
} from "./owned-process-authority-contract.js";
import {
  OWNED_PROCESS_DIGEST_DOMAIN,
  OWNED_PROCESS_DIGEST_PREFIX,
  OWNED_PROCESS_LIMIT,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_SCHEMA_VERSION,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STORAGE_NAME,
  OWNED_PROCESS_STRATEGY,
  isOwnedProcessRecordFileName,
  ownedProcessJsonFileName,
} from "./owned-process-contract.js";
import type { OwnedProcessPlatform } from "./owned-process-platform.js";
import {
  type OwnedAttemptProcessRecordV1,
  assertOwnedProcessRecord,
  buildOwnedProcessRecord,
  expectedOwnedProcessCurrentBytes,
  normalizeStoredOwnedProcessRecord,
  ownedProcessTimestamp,
} from "./owned-process-record-validation.js";

export type { OwnedProcessState } from "./owned-process-contract.js";
export {
  assertOwnedProcessRecord,
  buildOwnedProcessRecord,
  ownedProcessPreimage,
  ownedProcessTimestamp,
} from "./owned-process-record-validation.js";
export type {
  OwnedAttemptProcessRecordV1,
  OwnedProcessRecordFieldParity,
  OwnedProcessReleaseProof,
  OwnedProcessReleaseProofFieldParity,
} from "./owned-process-record-validation.js";

function key(attemptId: string): string {
  return digestV1(OWNED_PROCESS_DIGEST_DOMAIN.RECORD_STORAGE_KEY, {
    [OWNED_PROCESS_RECORD_FIELD.ATTEMPT_ID]: attemptId,
  }).slice(OWNED_PROCESS_DIGEST_PREFIX.length);
}

function entryForAttempt(attemptId: string): string {
  return ownedProcessJsonFileName(key(attemptId));
}

function assertAttemptBinding(
  requestedAttemptId: string,
  record: OwnedAttemptProcessRecordV1,
  error: string,
): void {
  if (record[OWNED_PROCESS_RECORD_FIELD.ATTEMPT_ID] !== requestedAttemptId) {
    throw new Error(error);
  }
}

export class OwnedProcessRecordStore {
  readonly root: string;
  private readonly recordsRoot: string;
  private readonly lockPath: string;

  constructor(root: string) {
    this.root = ensurePrivateDirectory(resolve(root));
    this.recordsRoot = ensurePrivateDirectory(
      join(this.root, OWNED_PROCESS_STORAGE_NAME.RECORD_DIRECTORY),
    );
    this.lockPath = join(this.recordsRoot, OWNED_PROCESS_STORAGE_NAME.WRITER_LOCK_FILE);
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
      [OWNED_PROCESS_RECORD_FIELD.SCHEMA_VERSION]: OWNED_PROCESS_SCHEMA_VERSION,
      [OWNED_PROCESS_RECORD_FIELD.ATTEMPT_ID]: attemptId,
      [OWNED_PROCESS_RECORD_FIELD.ENGINE]: engine,
      [OWNED_PROCESS_RECORD_FIELD.HOST]: hostname(),
      [OWNED_PROCESS_RECORD_FIELD.PLATFORM]: platform.platform,
      [OWNED_PROCESS_RECORD_FIELD.STRATEGY]: platform.strategy,
      [OWNED_PROCESS_RECORD_FIELD.QUIESCENCE_SCOPE]:
        platform.quiescenceScope ??
        (platform.strategy === OWNED_PROCESS_STRATEGY.WINDOWS_TREE
          ? OWNED_PROCESS_QUIESCENCE_SCOPE.WINDOWS_JOB
          : OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP),
      [OWNED_PROCESS_RECORD_FIELD.PROOF_STRENGTH]:
        platform.proofStrength ??
        (platform.strategy === OWNED_PROCESS_STRATEGY.WINDOWS_TREE
          ? OWNED_PROCESS_PROOF_STRENGTH.KERNEL_CONTAINED
          : OWNED_PROCESS_PROOF_STRENGTH.COOPERATIVE_LINEAGE),
      [OWNED_PROCESS_RECORD_FIELD.OWNER_PID]: process.pid,
      [OWNED_PROCESS_RECORD_FIELD.OWNER_IDENTITY]: ownerIdentity,
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_PID]: null,
      [OWNED_PROCESS_RECORD_FIELD.SUPERVISOR_IDENTITY]: null,
      [OWNED_PROCESS_RECORD_FIELD.CLI_PID]: null,
      [OWNED_PROCESS_RECORD_FIELD.CLI_IDENTITY]: null,
      [OWNED_PROCESS_RECORD_FIELD.TERMINAL_KIND]: null,
      [OWNED_PROCESS_RECORD_FIELD.STATE]: OWNED_PROCESS_STATE.RESERVED,
      [OWNED_PROCESS_RECORD_FIELD.RELEASE_REASON]: null,
      [OWNED_PROCESS_RECORD_FIELD.EXIT_CODE]: null,
      [OWNED_PROCESS_RECORD_FIELD.PROCESS_QUIESCENT]: false,
      [OWNED_PROCESS_RECORD_FIELD.PRIOR_RECORD_DIGEST]: null,
      [OWNED_PROCESS_RECORD_FIELD.RECORDED_AT]: now,
      [OWNED_PROCESS_RECORD_FIELD.UPDATED_AT]: now,
    });
    this.write(attemptId, null, record);
    return record;
  }

  read(attemptId: string): OwnedAttemptProcessRecordV1 | null {
    return this.readEntry(entryForAttempt(attemptId), attemptId);
  }

  entries(): string[] {
    return readdirSync(this.recordsRoot).filter((entry) =>
      entry.endsWith(OWNED_PROCESS_STORAGE_NAME.RECORD_FILE_EXTENSION),
    );
  }

  readEntry(entry: string, requestedAttemptId?: string): OwnedAttemptProcessRecordV1 | null {
    if (!isOwnedProcessRecordFileName(entry)) {
      throw new Error(OWNED_PROCESS_AUTHORITY_ERROR.STORAGE_BINDING);
    }
    const bytes = privateFileBytes(
      join(this.recordsRoot, entry),
      OWNED_PROCESS_LIMIT.MAX_RECORD_BYTES,
    );
    if (!bytes) return null;
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assertOwnedProcessRecord(value);
    if (!canonicalJsonBytes(value).equals(bytes)) throw new Error("owned process record changed");
    const record = normalizeStoredOwnedProcessRecord(value);
    if (
      entry !== entryForAttempt(record[OWNED_PROCESS_RECORD_FIELD.ATTEMPT_ID]) ||
      (requestedAttemptId !== undefined &&
        record[OWNED_PROCESS_RECORD_FIELD.ATTEMPT_ID] !== requestedAttemptId)
    ) {
      throw new Error(OWNED_PROCESS_AUTHORITY_ERROR.STORAGE_BINDING);
    }
    return record;
  }

  listOpenRecords(): OwnedAttemptProcessRecordV1[] {
    return this.entries()
      .map((entry) => this.readEntry(entry))
      .filter((record): record is OwnedAttemptProcessRecordV1 => Boolean(record))
      .filter(
        (record) => record[OWNED_PROCESS_RECORD_FIELD.STATE] !== OWNED_PROCESS_STATE.RELEASED,
      );
  }

  write(
    attemptId: string,
    current: OwnedAttemptProcessRecordV1 | null,
    next: OwnedAttemptProcessRecordV1,
  ): void {
    if (current) {
      assertOwnedProcessRecord(current);
      assertAttemptBinding(attemptId, current, OWNED_PROCESS_AUTHORITY_ERROR.WRITE_BINDING);
    }
    assertOwnedProcessRecord(next);
    assertAttemptBinding(attemptId, next, OWNED_PROCESS_AUTHORITY_ERROR.WRITE_BINDING);
    assertOwnedProcessWriteTransition(current, next);
    const currentBytes = current ? expectedOwnedProcessCurrentBytes(current) : null;
    const nextBytes =
      current && canonicalJsonBytes(current).equals(canonicalJsonBytes(next))
        ? expectedOwnedProcessCurrentBytes(current)
        : canonicalJsonBytes(next);
    const lock = acquireProcessLock(this.lockPath, {
      operation: `${OWNED_PROCESS_STORAGE_NAME.LOCK_OPERATION_PREFIX}${attemptId}`,
    });
    try {
      atomicCompareAndSwap(
        join(this.recordsRoot, entryForAttempt(attemptId)),
        currentBytes,
        nextBytes,
        { lock, maxBytes: OWNED_PROCESS_LIMIT.MAX_RECORD_BYTES },
      );
    } finally {
      lock.release();
    }
  }
}
