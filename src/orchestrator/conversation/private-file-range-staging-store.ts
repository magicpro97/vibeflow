import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import {
  type JsonValue,
  type ProcessLock,
  acquireProcessLock,
  appendVffrFrame,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
  ensurePrivateDirectory,
  privateFileBytes,
  readVffrFile,
} from "../../durability/index.js";
import {
  type PrivateFileRangeStageInputV1,
  buildPrivateFileRangeStage,
  buildPrivateFileRangeStagingFrame,
  privateFileRangeHandoffBinding,
} from "./private-file-range-staging-builders.js";
import {
  PRIVATE_FILE_RANGE_MAX_FRAMES,
  PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN,
  PRIVATE_FILE_RANGE_STAGING_IDENTIFIER_PREFIX,
  PRIVATE_FILE_RANGE_STAGING_LIMIT,
  PRIVATE_FILE_RANGE_STAGING_PATTERN,
  PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
  PRIVATE_FILE_RANGE_STAGING_STATE,
  PRIVATE_FILE_RANGE_STAGING_STORAGE,
  type PrivateFileRangeHandoffBindingV1,
  type PrivateFileRangeStagingFrameMutationV1,
  type PrivateFileRangeStagingFrameV1,
  type PrivateFileRangeStagingRecordV1,
  type ResolvedPrivateFileRangeV1,
  assertPrivateFileRangeHandoffBindingV1,
  assertPrivateFileRangeStagingFrameChain,
  assertPrivateFileRangeStagingFrameV1,
  assertPrivateFileRangeStagingRecordV1,
} from "./private-file-range-staging-contract.js";
export {
  PRIVATE_FILE_RANGE_MAX_FRAMES,
  PRIVATE_FILE_RANGE_STAGING_STATE,
  PRIVATE_FILE_RANGE_STAGING_STATES,
  assertPrivateFileRangeHandoffBindingV1,
  isPrivateFileRangeStagingState,
} from "./private-file-range-staging-contract.js";
export type {
  PrivateFileRangeHandoffBindingV1,
  PrivateFileRangeStagingFrameV1,
  PrivateFileRangeStagingStateV1,
  ResolvedPrivateFileRangeV1,
} from "./private-file-range-staging-contract.js";

function cloneBinding(value: PrivateFileRangeHandoffBindingV1): PrivateFileRangeHandoffBindingV1 {
  assertPrivateFileRangeHandoffBindingV1(value);
  return structuredClone(value);
}

export function createPrivateFileRangeHandoffId(): string {
  return `${PRIVATE_FILE_RANGE_STAGING_IDENTIFIER_PREFIX}-${randomBytes(32).toString("hex")}`;
}

export class PrivateFileRangeStagingStoreV1 {
  private readonly records: string;
  private readonly frames: string;
  private readonly lockPath: string;

  constructor(artifactRoot: string) {
    const root = ensurePrivateDirectory(join(resolve(artifactRoot), "actions", "v1"));
    this.records = ensurePrivateDirectory(
      join(root, PRIVATE_FILE_RANGE_STAGING_STORAGE.RECORDS_DIRECTORY),
    );
    this.frames = ensurePrivateDirectory(
      join(root, PRIVATE_FILE_RANGE_STAGING_STORAGE.FRAMES_DIRECTORY),
    );
    this.lockPath = join(root, PRIVATE_FILE_RANGE_STAGING_STORAGE.WRITER_LOCK_FILE);
  }

  // biome-ignore format: production file ceiling
  private assertId(id: string): void { if (!PRIVATE_FILE_RANGE_STAGING_PATTERN.HANDOFF_ID.test(id)) throw new Error("invalid private file range handoff id"); }

  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }

  private codec(id: string) {
    return {
      domain: PRIVATE_FILE_RANGE_STAGING_STORAGE.DOMAIN,
      maxFrames: PRIVATE_FILE_RANGE_MAX_FRAMES,
      maxPayloadBytes: PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_RECORD_BYTES,
      maxAggregateBytes:
        PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_RECORD_BYTES * PRIVATE_FILE_RANGE_MAX_FRAMES,
      validatePayload: (payload: Record<string, unknown>) => {
        assertPrivateFileRangeStagingFrameV1(payload);
        const value = payload;
        const { frame_digest: _digest, ...preimage } = value;
        if (
          value.handoff_id !== id ||
          digestV1(PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN.FRAME, preimage) !== value.frame_digest
        )
          throw new Error("invalid private file range staging frame");
      },
      computePayloadDigest: (payload: Record<string, unknown>) => {
        assertPrivateFileRangeStagingFrameV1(payload);
        return payload.frame_digest;
      },
      validateJournalIdentity: (payload: Record<string, unknown>) => payload.handoff_id === id,
    };
  }

  private appendFrame(
    record: PrivateFileRangeStagingRecordV1,
    frames: readonly PrivateFileRangeStagingFrameV1[],
    mutation: PrivateFileRangeStagingFrameMutationV1,
    lock: ProcessLock,
  ): void {
    const next = buildPrivateFileRangeStagingFrame(record, frames.at(-1) ?? null, mutation);
    assertPrivateFileRangeStagingFrameChain([...frames, next]);
    appendVffrFrame(
      join(this.frames, `${record.handoff_id}.frames`),
      PRIVATE_FILE_RANGE_STAGING_STORAGE.DOMAIN,
      next as unknown as JsonValue,
      { ...this.codec(record.handoff_id), lock },
    );
  }

  stage(input: PrivateFileRangeStageInputV1): PrivateFileRangeHandoffBindingV1 {
    this.assertId(input.handoff_id);
    const { record, binding: output } = buildPrivateFileRangeStage(input);
    this.withLock(`private-file-range-stage:${input.handoff_id}`, (lock) => {
      createOrVerifyPrivateFile(
        join(this.records, `${input.handoff_id}.json`),
        canonicalJsonBytes(record),
        { lock, maxBytes: PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_RECORD_BYTES },
      );
      const frames = this.readFrames(input.handoff_id);
      if (frames.length === 0)
        this.appendFrame(
          record,
          frames,
          {
            state: PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE,
            reservation_key: null,
            consumed_by: null,
            recorded_at: input.staged_at,
          },
          lock,
        );
    });
    return output;
  }

  readRecord(id: string): PrivateFileRangeStagingRecordV1 | null {
    this.assertId(id);
    const bytes = privateFileBytes(
      join(this.records, `${id}.json`),
      PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_RECORD_BYTES,
    );
    if (!bytes) return null;
    // biome-ignore format: production file ceiling
    let record: PrivateFileRangeStagingRecordV1;
    try {
      const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      assertPrivateFileRangeStagingRecordV1(decoded);
      record = decoded;
    } catch (error) {
      throw new Error("private file range staging record is corrupt", { cause: error });
    }
    const { record_digest: _digest, ...preimage } = record;
    if (
      record.handoff_id !== id ||
      !canonicalJsonBytes(record).equals(bytes) ||
      digestV1(PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN.RECORD, preimage) !== record.record_digest
    )
      throw new Error("private file range staging record is corrupt");
    assertPrivateFileRangeHandoffBindingV1(privateFileRangeHandoffBinding(record));
    return structuredClone(record);
  }

  readFrames(id: string): PrivateFileRangeStagingFrameV1[] {
    this.assertId(id);
    const path = join(this.frames, `${id}.frames`);
    if (
      privateFileBytes(
        path,
        PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_RECORD_BYTES * PRIVATE_FILE_RANGE_MAX_FRAMES,
      ) === null
    )
      return [];
    const decoded = readVffrFile(path, this.codec(id)).map((item) =>
      structuredClone(item.payload as unknown as PrivateFileRangeStagingFrameV1),
    );
    assertPrivateFileRangeStagingFrameChain(decoded);
    const record = this.readRecord(id);
    if (!record || decoded.some((frame) => frame.handoff_record_digest !== record.record_digest))
      throw new Error("private file range staging frame authority changed");
    return decoded;
  }

  // biome-ignore format: production file ceiling
  reserve(bindingValue: PrivateFileRangeHandoffBindingV1, reservationKey: string, at: string): void {
    const requested = cloneBinding(bindingValue);
    this.withLock(`private-file-range-reserve:${bindingValue.handoff_id}`, (lock) => {
      const record = this.readRecord(requested.handoff_id);
      const frames = this.readFrames(requested.handoff_id);
      const current = frames.at(-1);
      // biome-ignore format: production file ceiling
      if (!record || canonicalJsonBytes(privateFileRangeHandoffBinding(record)).compare(canonicalJsonBytes(requested)) !== 0)
        throw new Error("private file range handoff binding changed");
      if (Date.parse(at) >= Date.parse(record.expires_at))
        throw new Error("private file range handoff expired");
      if (
        current?.state === PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED &&
        current.reservation_key === reservationKey
      )
        return;
      if (current?.state !== PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE)
        throw new Error("private file range handoff is not available");
      this.appendFrame(
        record,
        frames,
        {
          state: PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED,
          reservation_key: reservationKey,
          consumed_by: null,
          recorded_at: at,
        },
        lock,
      );
    });
  }

  // biome-ignore format: production file ceiling
  release(bindingValue: PrivateFileRangeHandoffBindingV1, reservationKey: string, at: string): void {
    const requested = cloneBinding(bindingValue);
    this.withLock(`private-file-range-release:${bindingValue.handoff_id}`, (lock) => {
      const record = this.readRecord(requested.handoff_id);
      const frames = this.readFrames(requested.handoff_id);
      const current = frames.at(-1);
      // biome-ignore format: production file ceiling
      if (!record || canonicalJsonBytes(privateFileRangeHandoffBinding(record)).compare(canonicalJsonBytes(requested)) !== 0)
        throw new Error("private file range handoff binding changed");
      if (!current || current.state === PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE) return;
      if (
        current.state !== PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED ||
        current.reservation_key !== reservationKey
      )
        throw new Error("private file range handoff reservation changed");
      this.appendFrame(
        record,
        frames,
        {
          state: PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE,
          reservation_key: null,
          consumed_by: null,
          recorded_at: at,
        },
        lock,
      );
    });
  }

  consume(
    bindingValue: PrivateFileRangeHandoffBindingV1,
    reservationKey: string,
    consumedBy: string,
    at: string,
  ): void {
    const requested = cloneBinding(bindingValue);
    this.withLock(`private-file-range-consume:${bindingValue.handoff_id}`, (lock) => {
      const record = this.readRecord(requested.handoff_id);
      const frames = this.readFrames(requested.handoff_id);
      const current = frames.at(-1);
      // biome-ignore format: production file ceiling
      if (!record || canonicalJsonBytes(privateFileRangeHandoffBinding(record)).compare(canonicalJsonBytes(requested)) !== 0)
        throw new Error("private file range handoff binding changed");
      if (current?.state === PRIVATE_FILE_RANGE_STAGING_STATE.CONSUMED) {
        if (current.reservation_key !== reservationKey || current.consumed_by !== consumedBy)
          throw new Error("private file range handoff consumption conflict");
        return;
      }
      if (
        current?.state !== PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED ||
        current.reservation_key !== reservationKey
      )
        throw new Error("private file range handoff reservation changed");
      this.appendFrame(
        record,
        frames,
        {
          state: PRIVATE_FILE_RANGE_STAGING_STATE.CONSUMED,
          reservation_key: reservationKey,
          consumed_by: consumedBy,
          recorded_at: at,
        },
        lock,
      );
    });
  }

  content(bindingValue: PrivateFileRangeHandoffBindingV1): ResolvedPrivateFileRangeV1 {
    const requested = cloneBinding(bindingValue);
    const record = this.readRecord(requested.handoff_id);
    if (
      !record ||
      canonicalJsonBytes(privateFileRangeHandoffBinding(record)).compare(
        canonicalJsonBytes(requested),
      ) !== 0
    )
      throw new Error("private file range handoff binding changed");
    const bytes = Buffer.from(record.content, "utf8");
    if (
      bytes.length !== record.content_byte_length ||
      digestV1(PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN.CONTENT, {
        schema_version: PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
        content: record.content,
      }) !== record.content_utf8_sha256
    )
      throw new Error("private file range handoff content is corrupt");
    // biome-ignore format: production file ceiling
    return { repo_relative_path: record.repo_relative_path, start_line: record.start_line, end_line: record.end_line, line_count: record.line_count, content: record.content };
  }
}
