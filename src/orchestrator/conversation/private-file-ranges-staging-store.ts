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
import { readConversationPrivateFileRange } from "./conversation-private-context-source.js";
import {
  PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN,
  PRIVATE_FILE_RANGES_STAGING_IDENTIFIER_PREFIX,
  PRIVATE_FILE_RANGES_STAGING_LIMIT,
  PRIVATE_FILE_RANGES_STAGING_PATTERN,
  PRIVATE_FILE_RANGES_STAGING_STATE,
  PRIVATE_FILE_RANGES_STAGING_STORAGE,
  type PrivateFileRangesHandoffBindingV1,
  type PrivateFileRangesStageInputV1,
  type PrivateFileRangesStagingFrameV1,
  type PrivateFileRangesStagingRangeV1,
  type PrivateFileRangesStagingRecordV1,
  type ResolvedPrivateFileRangesV1,
  aggregateContentDigest,
  assertPrivateFileRangesHandoffBindingV1,
  assertPrivateFileRangesStagingFrameChain,
  assertPrivateFileRangesStagingFrameV1,
  assertPrivateFileRangesStagingRecordV1,
  isPrivateFileRangeRepoRelativePath,
} from "./private-file-ranges-staging-contract.js";
import { normalizePrivateFileRanges } from "./private-file-ranges-staging-store-helpers.js";

export {
  PRIVATE_FILE_RANGES_STAGING_LIMIT,
  PRIVATE_FILE_RANGES_STAGING_STATE,
  PRIVATE_FILE_RANGES_STAGING_STORAGE,
  assertPrivateFileRangesHandoffBindingV1,
} from "./private-file-ranges-staging-contract.js";
export type {
  PrivateFileRangesHandoffBindingV1,
  PrivateFileRangesStagingFrameV1,
  PrivateFileRangesStagingRecordV1,
  ResolvedPrivateFileRangesV1,
} from "./private-file-ranges-staging-contract.js";

export function createPrivateFileRangesHandoffId(): string {
  return `${PRIVATE_FILE_RANGES_STAGING_IDENTIFIER_PREFIX}-${randomBytes(32).toString("hex")}`;
}

function cloneBinding(value: PrivateFileRangesHandoffBindingV1): PrivateFileRangesHandoffBindingV1 {
  assertPrivateFileRangesHandoffBindingV1(value);
  return structuredClone(value);
}

function expiresAt(stagedAt: string, ttl: number | undefined): string {
  const duration = ttl ?? PRIVATE_FILE_RANGES_STAGING_LIMIT.DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(duration) || duration <= 0)
    throw new Error("invalid private file ranges TTL");
  const result = Date.parse(stagedAt) + duration;
  if (!Number.isFinite(result)) throw new Error("invalid private file ranges expiry");
  return new Date(result).toISOString();
}

function frame(
  record: PrivateFileRangesStagingRecordV1,
  prior: PrivateFileRangesStagingFrameV1 | null,
): PrivateFileRangesStagingFrameV1 {
  const preimage = {
    schema_version: "1.0" as const,
    handoff_id: record.handoff_id,
    sequence: (prior?.sequence ?? -1) + 1,
    previous_frame_digest: prior?.frame_digest ?? null,
    handoff_record_digest: record.record_digest,
    state: PRIVATE_FILE_RANGES_STAGING_STATE.AVAILABLE,
    reservation_key: null,
    consumed_by: null,
    recorded_at: record.staged_at,
  };
  return {
    ...preimage,
    frame_digest: digestV1(PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN.FRAME, preimage),
  };
}

function requestDigest(
  ranges: readonly { repo_relative_path: string; start_line: number; end_line: number }[],
): string {
  return digestV1(PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN.REQUEST, {
    schema_version: "1.0",
    ranges,
  });
}

function codec(id: string) {
  return {
    domain: PRIVATE_FILE_RANGES_STAGING_STORAGE.DOMAIN,
    maxFrames: PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_FRAMES,
    maxPayloadBytes: PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_RECORD_BYTES,
    maxAggregateBytes:
      PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_RECORD_BYTES *
      PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_FRAMES,
    validatePayload: (payload: Record<string, unknown>) => {
      assertPrivateFileRangesStagingFrameV1(payload);
      if (
        payload.handoff_id !== id ||
        digestV1(
          PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN.FRAME,
          (() => {
            const { frame_digest: _digest, ...preimage } = payload;
            return preimage;
          })(),
        ) !== payload.frame_digest
      )
        throw new Error("invalid private file ranges staging frame");
    },
    computePayloadDigest: (payload: Record<string, unknown>) => {
      assertPrivateFileRangesStagingFrameV1(payload);
      return payload.frame_digest as string;
    },
    validateJournalIdentity: (payload: Record<string, unknown>) => payload.handoff_id === id,
  };
}

export class PrivateFileRangesStagingStoreV1 {
  private readonly records: string;
  private readonly frames: string;
  private readonly lockPath: string;

  constructor(
    private readonly artifactRoot: string,
    private readonly repoRoot: string,
  ) {
    const root = ensurePrivateDirectory(join(resolve(artifactRoot), "actions", "v1"));
    this.records = ensurePrivateDirectory(
      join(root, PRIVATE_FILE_RANGES_STAGING_STORAGE.RECORDS_DIRECTORY),
    );
    this.frames = ensurePrivateDirectory(
      join(root, PRIVATE_FILE_RANGES_STAGING_STORAGE.FRAMES_DIRECTORY),
    );
    this.lockPath = join(root, PRIVATE_FILE_RANGES_STAGING_STORAGE.WRITER_LOCK_FILE);
  }

  private assertId(id: string): void {
    if (!PRIVATE_FILE_RANGES_STAGING_PATTERN.HANDOFF_ID.test(id))
      throw new Error("invalid private file ranges handoff id");
  }
  private withLock<T>(operation: string, run: (lock: ProcessLock) => T): T {
    const lock = acquireProcessLock(this.lockPath, { operation });
    try {
      return run(lock);
    } finally {
      lock.release();
    }
  }
  readRecord(id: string): PrivateFileRangesStagingRecordV1 | null {
    this.assertId(id);
    const bytes = privateFileBytes(
      join(this.records, `${id}.json`),
      PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_RECORD_BYTES,
    );
    if (!bytes) return null;
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      assertPrivateFileRangesStagingRecordV1(value);
      const record = value;
      if (record.handoff_id !== id)
        throw new Error("private file ranges staging record identity changed");
      const { record_digest: _digest, ...preimage } = record;
      if (
        !canonicalJsonBytes(record).equals(bytes) ||
        digestV1(PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN.RECORD, preimage) !==
          record.record_digest
      )
        throw new Error("private file ranges staging record is corrupt");
      return structuredClone(record);
    } catch (error) {
      throw new Error("private file ranges staging record is corrupt", { cause: error });
    }
  }
  readFrames(id: string): PrivateFileRangesStagingFrameV1[] {
    this.assertId(id);
    const path = join(this.frames, `${id}.frames`);
    if (
      privateFileBytes(
        path,
        PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_RECORD_BYTES *
          PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_FRAMES,
      ) === null
    ) {
      if (this.readRecord(id))
        throw new Error("private file ranges staging frame journal is missing");
      return [];
    }
    const decoded = readVffrFile(path, codec(id)).map((item) =>
      structuredClone(item.payload as unknown as PrivateFileRangesStagingFrameV1),
    );
    assertPrivateFileRangesStagingFrameChain(decoded);
    const record = this.readRecord(id);
    if (!record || decoded.some((item) => item.handoff_record_digest !== record.record_digest))
      throw new Error("private file ranges staging frame authority changed");
    return decoded;
  }
  private appendFrame(
    record: PrivateFileRangesStagingRecordV1,
    frames: readonly PrivateFileRangesStagingFrameV1[],
    lock: ProcessLock,
  ): void {
    const next = frame(record, frames.at(-1) ?? null);
    appendVffrFrame(
      join(this.frames, `${record.handoff_id}.frames`),
      PRIVATE_FILE_RANGES_STAGING_STORAGE.DOMAIN,
      next as unknown as JsonValue,
      { ...codec(record.handoff_id), lock },
    );
  }

  stage(input: PrivateFileRangesStageInputV1): PrivateFileRangesHandoffBindingV1 {
    this.assertId(input.handoff_id);
    if (
      typeof input.staged_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.staged_at) ||
      !Number.isFinite(Date.parse(input.staged_at)) ||
      new Date(Date.parse(input.staged_at)).toISOString() !== input.staged_at
    )
      throw new Error("invalid private file ranges timestamp");
    const ranges = normalizePrivateFileRanges(input.ranges);
    const current = this.readRecord(input.handoff_id);
    const wantedRequestDigest = requestDigest(ranges);
    if (current) {
      if (current.request_digest !== wantedRequestDigest)
        throw new Error("private file ranges staging request changed");
      this.readFrames(input.handoff_id);
      return this.binding(current);
    }
    const stagedRanges: PrivateFileRangesStagingRangeV1[] = [];
    for (const range of ranges) {
      const resolved = readConversationPrivateFileRange({
        repoRoot: this.repoRoot,
        repoRelativePath: range.repo_relative_path,
        startLine: range.start_line,
        endLine: range.end_line,
      });
      const contentBytes = Buffer.byteLength(resolved.content, "utf8");
      if (contentBytes < 1 || contentBytes > PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_CONTENT_BYTES)
        throw new Error("private file ranges content is empty or oversized");
      stagedRanges.push({
        repo_relative_path: range.repo_relative_path,
        start_line: resolved.start_line,
        end_line: resolved.end_line,
        line_count: resolved.end_line - resolved.start_line + 1,
        content: resolved.content,
        content_utf8_sha256: digestV1(PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN.CONTENT, {
          schema_version: "1.0",
          content: resolved.content,
        }),
        content_byte_length: contentBytes,
      });
    }
    const totalLines = stagedRanges.reduce((sum, range) => sum + range.line_count, 0);
    const totalBytes = stagedRanges.reduce((sum, range) => sum + range.content_byte_length, 0);
    if (totalBytes > PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_CONTENT_BYTES)
      throw new Error("private file ranges aggregate content is oversized");
    const withoutDigest = {
      schema_version: "1.0" as const,
      handoff_id: input.handoff_id,
      request_digest: wantedRequestDigest,
      ranges: stagedRanges,
      file_count: new Set(stagedRanges.map((range) => range.repo_relative_path)).size,
      range_count: stagedRanges.length,
      total_line_count: totalLines,
      total_content_byte_length: totalBytes,
      aggregate_digest: aggregateContentDigest(stagedRanges),
      staged_at: input.staged_at,
      expires_at: expiresAt(input.staged_at, input.ttl_ms),
    };
    const record: PrivateFileRangesStagingRecordV1 = {
      ...withoutDigest,
      record_digest: digestV1(PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN.RECORD, withoutDigest),
    };
    assertPrivateFileRangesStagingRecordV1(record);
    return this.withLock(`private-file-ranges-stage:${input.handoff_id}`, (lock) => {
      const raced = this.readRecord(input.handoff_id);
      if (raced) {
        if (raced.request_digest !== wantedRequestDigest)
          throw new Error("private file ranges staging request changed");
        this.readFrames(input.handoff_id);
        return this.binding(raced);
      }
      createOrVerifyPrivateFile(
        join(this.records, `${input.handoff_id}.json`),
        canonicalJsonBytes(record),
        { lock, maxBytes: PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_RECORD_BYTES },
      );
      this.appendFrame(record, [], lock);
      return this.binding(record);
    });
  }
  private binding(record: PrivateFileRangesStagingRecordV1): PrivateFileRangesHandoffBindingV1 {
    const binding = {
      schema_version: "1.0" as const,
      handoff_id: record.handoff_id,
      handoff_record_digest: record.record_digest,
      file_count: record.file_count,
      range_count: record.range_count,
      total_line_count: record.total_line_count,
      total_content_byte_length: record.total_content_byte_length,
      aggregate_digest: record.aggregate_digest,
      staged_at: record.staged_at,
      expires_at: record.expires_at,
    };
    assertPrivateFileRangesHandoffBindingV1(binding);
    return binding;
  }
  content(bindingValue: PrivateFileRangesHandoffBindingV1): ResolvedPrivateFileRangesV1 {
    const binding = cloneBinding(bindingValue);
    const record = this.readRecord(binding.handoff_id);
    if (
      !record ||
      canonicalJsonBytes(this.binding(record)).compare(canonicalJsonBytes(binding)) !== 0
    )
      throw new Error("private file ranges handoff binding changed");
    const ranges = structuredClone(record.ranges);
    for (const range of ranges) {
      if (
        Buffer.byteLength(range.content, "utf8") !== range.content_byte_length ||
        digestV1(PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN.CONTENT, {
          schema_version: "1.0",
          content: range.content,
        }) !== range.content_utf8_sha256
      )
        throw new Error("private file ranges aggregate content is corrupt");
    }
    this.readFrames(binding.handoff_id);
    if (aggregateContentDigest(ranges) !== record.aggregate_digest)
      throw new Error("private file ranges aggregate content is corrupt");
    return {
      file_count: record.file_count,
      range_count: record.range_count,
      total_line_count: record.total_line_count,
      total_content_byte_length: record.total_content_byte_length,
      aggregate_digest: record.aggregate_digest,
      ranges,
    };
  }
}
