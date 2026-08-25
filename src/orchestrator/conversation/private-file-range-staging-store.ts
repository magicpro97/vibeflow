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

const MAX_RECORD = 256 * 1024;
const MAX_CONTENT = 64 * 1024;
const MAX_FRAMES = 8;
const STAGING = /^vf-file-range-[0-9a-f]{64}$/;
const PATH_LIMIT = 4 * 1024;

export interface PrivateFileRangeHandoffBindingV1 {
  schema_version: "1.0";
  handoff_id: string;
  handoff_record_digest: string;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  staged_at: string;
  expires_at: string;
}

// biome-ignore format: production file ceiling
const validLine = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
// biome-ignore format: production file ceiling
const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && value.endsWith("Z") && value.includes("T");
// biome-ignore format: production file ceiling
const hasControlCharacter = (value: string): boolean => Array.from(value).some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
// biome-ignore format: production file ceiling
const validRepoRelativePath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= PATH_LIMIT && !hasControlCharacter(value) && !value.includes("\\") && !value.startsWith("/") && !value.startsWith("~") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

export function assertPrivateFileRangeHandoffBindingV1(
  value: unknown,
): asserts value is PrivateFileRangeHandoffBindingV1 {
  const bindingValue = value as Partial<PrivateFileRangeHandoffBindingV1> | null;
  if (
    !bindingValue ||
    bindingValue.schema_version !== "1.0" ||
    typeof bindingValue.handoff_id !== "string" ||
    !STAGING.test(bindingValue.handoff_id) ||
    typeof bindingValue.handoff_record_digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(bindingValue.handoff_record_digest) ||
    !validRepoRelativePath(bindingValue.repo_relative_path) ||
    !validLine(bindingValue.start_line) ||
    !validLine(bindingValue.end_line) ||
    bindingValue.end_line < bindingValue.start_line ||
    !Number.isSafeInteger(bindingValue.line_count) ||
    (bindingValue.line_count ?? 0) !== bindingValue.end_line - bindingValue.start_line + 1 ||
    !validTimestamp(bindingValue.staged_at) ||
    !validTimestamp(bindingValue.expires_at) ||
    Date.parse(bindingValue.expires_at) <= Date.parse(bindingValue.staged_at)
  ) {
    throw new Error("invalid private file range handoff binding");
  }
}

function cloneBinding(value: PrivateFileRangeHandoffBindingV1): PrivateFileRangeHandoffBindingV1 {
  assertPrivateFileRangeHandoffBindingV1(value);
  return structuredClone(value);
}

interface PrivateFileRangeStagingRecordV1 {
  schema_version: "1.0";
  handoff_id: string;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  content: string;
  content_utf8_sha256: string;
  content_byte_length: number;
  staged_at: string;
  expires_at: string;
  record_digest: string;
}

interface PrivateFileRangeStagingFrameV1 {
  schema_version: "1.0";
  handoff_id: string;
  sequence: number;
  previous_frame_digest: string | null;
  handoff_record_digest: string;
  state: "available" | "reserved" | "consumed";
  reservation_key: string | null;
  consumed_by: string | null;
  recorded_at: string;
  frame_digest: string;
}

export interface ResolvedPrivateFileRangeV1 {
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  content: string;
}

// biome-ignore format: production file ceiling
function frame(record: PrivateFileRangeStagingRecordV1, prior: PrivateFileRangeStagingFrameV1 | null, input: Pick<PrivateFileRangeStagingFrameV1, "state" | "reservation_key" | "consumed_by" | "recorded_at">): PrivateFileRangeStagingFrameV1 {
  const preimage = {
    schema_version: "1.0" as const,
    handoff_id: record.handoff_id,
    sequence: (prior?.sequence ?? -1) + 1,
    previous_frame_digest: prior?.frame_digest ?? null,
    handoff_record_digest: record.record_digest,
    ...structuredClone(input),
  };
  return {
    ...preimage,
    frame_digest: digestV1("VF-PRIVATE-FILE-RANGE-STAGING-FRAME\0v1\0", preimage),
  };
}

function binding(record: PrivateFileRangeStagingRecordV1): PrivateFileRangeHandoffBindingV1 {
  const output: PrivateFileRangeHandoffBindingV1 = {
    schema_version: "1.0",
    handoff_id: record.handoff_id,
    handoff_record_digest: record.record_digest,
    repo_relative_path: record.repo_relative_path,
    start_line: record.start_line,
    end_line: record.end_line,
    line_count: record.line_count,
    staged_at: record.staged_at,
    expires_at: record.expires_at,
  };
  assertPrivateFileRangeHandoffBindingV1(output);
  return output;
}

export function createPrivateFileRangeHandoffId(): string {
  return `vf-file-range-${randomBytes(32).toString("hex")}`;
}

export class PrivateFileRangeStagingStoreV1 {
  private readonly records: string;
  private readonly frames: string;
  private readonly lockPath: string;

  constructor(artifactRoot: string) {
    const root = ensurePrivateDirectory(join(resolve(artifactRoot), "actions", "v1"));
    this.records = ensurePrivateDirectory(join(root, "private-file-range-records"));
    this.frames = ensurePrivateDirectory(join(root, "private-file-range-staging"));
    this.lockPath = join(root, "private-file-range-staging.writer.lock");
  }

  // biome-ignore format: production file ceiling
  private assertId(id: string): void { if (!STAGING.test(id)) throw new Error("invalid private file range handoff id"); }

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
      domain: "private-file-range-staging" as const,
      maxFrames: MAX_FRAMES,
      maxPayloadBytes: MAX_RECORD,
      maxAggregateBytes: MAX_RECORD * MAX_FRAMES,
      validatePayload: (payload: Record<string, unknown>) => {
        const value = payload as unknown as PrivateFileRangeStagingFrameV1;
        const { frame_digest: _digest, ...preimage } = value;
        if (
          value.handoff_id !== id ||
          digestV1("VF-PRIVATE-FILE-RANGE-STAGING-FRAME\0v1\0", preimage) !== value.frame_digest
        )
          throw new Error("invalid private file range staging frame");
      },
      computePayloadDigest: (payload: Record<string, unknown>) =>
        (payload as unknown as PrivateFileRangeStagingFrameV1).frame_digest,
      validateJournalIdentity: (payload: Record<string, unknown>) => payload.handoff_id === id,
    };
  }

  stage(input: {
    handoff_id: string;
    repo_relative_path: string;
    start_line: number;
    end_line: number;
    content: string;
    staged_at: string;
    ttl_ms?: number;
  }): PrivateFileRangeHandoffBindingV1 {
    this.assertId(input.handoff_id);
    if (!validRepoRelativePath(input.repo_relative_path))
      throw new Error("private file range path is invalid");
    const content = input.content;
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length === 0 || bytes.length > MAX_CONTENT)
      throw new Error("private file range content is empty or oversized");
    // biome-ignore format: production file ceiling
    if (!validLine(input.start_line) || !validLine(input.end_line) || input.end_line < input.start_line)
      throw new Error("private file range line bounds are invalid");
    // biome-ignore format: production file ceiling
    if (!validTimestamp(input.staged_at)) throw new Error("private file range timestamp is invalid");
    const lineCount = input.end_line - input.start_line + 1;
    const withoutDigest = {
      schema_version: "1.0" as const,
      handoff_id: input.handoff_id,
      repo_relative_path: input.repo_relative_path,
      start_line: input.start_line,
      end_line: input.end_line,
      line_count: lineCount,
      content,
      content_utf8_sha256: digestV1("VF-PRIVATE-FILE-RANGE-CONTENT\0v1\0", {
        schema_version: "1.0",
        content,
      }),
      content_byte_length: bytes.length,
      staged_at: input.staged_at,
      expires_at: new Date(
        Date.parse(input.staged_at) + (input.ttl_ms ?? 10 * 60_000),
      ).toISOString(),
    };
    const record: PrivateFileRangeStagingRecordV1 = {
      ...withoutDigest,
      record_digest: digestV1("VF-PRIVATE-FILE-RANGE-STAGING-RECORD\0v1\0", withoutDigest),
    };
    this.withLock(`private-file-range-stage:${input.handoff_id}`, (lock) => {
      createOrVerifyPrivateFile(
        join(this.records, `${input.handoff_id}.json`),
        canonicalJsonBytes(record),
        { lock, maxBytes: MAX_RECORD },
      );
      if (this.readFrames(input.handoff_id).length === 0)
        appendVffrFrame(
          join(this.frames, `${input.handoff_id}.frames`),
          "private-file-range-staging",
          frame(record, null, {
            state: "available",
            reservation_key: null,
            consumed_by: null,
            recorded_at: input.staged_at,
          }) as unknown as JsonValue,
          { ...this.codec(input.handoff_id), lock },
        );
    });
    return binding(record);
  }

  readRecord(id: string): PrivateFileRangeStagingRecordV1 | null {
    this.assertId(id);
    const bytes = privateFileBytes(join(this.records, `${id}.json`), MAX_RECORD);
    if (!bytes) return null;
    // biome-ignore format: production file ceiling
    const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as PrivateFileRangeStagingRecordV1;
    const { record_digest: _digest, ...preimage } = record;
    if (
      !canonicalJsonBytes(record).equals(bytes) ||
      digestV1("VF-PRIVATE-FILE-RANGE-STAGING-RECORD\0v1\0", preimage) !== record.record_digest
    )
      throw new Error("private file range staging record is corrupt");
    assertPrivateFileRangeHandoffBindingV1(binding(record));
    return structuredClone(record);
  }

  readFrames(id: string): PrivateFileRangeStagingFrameV1[] {
    this.assertId(id);
    const path = join(this.frames, `${id}.frames`);
    if (privateFileBytes(path, MAX_RECORD * MAX_FRAMES) === null) return [];
    return readVffrFile(path, this.codec(id)).map((item) =>
      structuredClone(item.payload as unknown as PrivateFileRangeStagingFrameV1),
    );
  }

  // biome-ignore format: production file ceiling
  reserve(bindingValue: PrivateFileRangeHandoffBindingV1, reservationKey: string, at: string): void {
    const requested = cloneBinding(bindingValue);
    this.withLock(`private-file-range-reserve:${bindingValue.handoff_id}`, (lock) => {
      const record = this.readRecord(requested.handoff_id);
      const current = this.readFrames(requested.handoff_id).at(-1);
      // biome-ignore format: production file ceiling
      if (!record || canonicalJsonBytes(binding(record)).compare(canonicalJsonBytes(requested)) !== 0)
        throw new Error("private file range handoff binding changed");
      if (Date.parse(at) >= Date.parse(record.expires_at))
        throw new Error("private file range handoff expired");
      if (current?.state === "reserved" && current.reservation_key === reservationKey) return;
      if (current?.state !== "available")
        throw new Error("private file range handoff is not available");
      appendVffrFrame(
        join(this.frames, `${record.handoff_id}.frames`),
        "private-file-range-staging",
        frame(record, current, {
          state: "reserved",
          reservation_key: reservationKey,
          consumed_by: null,
          recorded_at: at,
        }) as unknown as JsonValue,
        { ...this.codec(record.handoff_id), lock },
      );
    });
  }

  // biome-ignore format: production file ceiling
  release(bindingValue: PrivateFileRangeHandoffBindingV1, reservationKey: string, at: string): void {
    const requested = cloneBinding(bindingValue);
    this.withLock(`private-file-range-release:${bindingValue.handoff_id}`, (lock) => {
      const record = this.readRecord(requested.handoff_id);
      const current = this.readFrames(requested.handoff_id).at(-1);
      // biome-ignore format: production file ceiling
      if (!record || canonicalJsonBytes(binding(record)).compare(canonicalJsonBytes(requested)) !== 0)
        throw new Error("private file range handoff binding changed");
      if (!current || current.state === "available") return;
      if (current.state !== "reserved" || current.reservation_key !== reservationKey)
        throw new Error("private file range handoff reservation changed");
      appendVffrFrame(
        join(this.frames, `${record.handoff_id}.frames`),
        "private-file-range-staging",
        frame(record, current, {
          state: "available",
          reservation_key: null,
          consumed_by: null,
          recorded_at: at,
        }) as unknown as JsonValue,
        { ...this.codec(record.handoff_id), lock },
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
      const current = this.readFrames(requested.handoff_id).at(-1);
      // biome-ignore format: production file ceiling
      if (!record || canonicalJsonBytes(binding(record)).compare(canonicalJsonBytes(requested)) !== 0)
        throw new Error("private file range handoff binding changed");
      if (current?.state === "consumed") {
        if (current.reservation_key !== reservationKey || current.consumed_by !== consumedBy)
          throw new Error("private file range handoff consumption conflict");
        return;
      }
      if (current?.state !== "reserved" || current.reservation_key !== reservationKey)
        throw new Error("private file range handoff reservation changed");
      appendVffrFrame(
        join(this.frames, `${record.handoff_id}.frames`),
        "private-file-range-staging",
        frame(record, current, {
          state: "consumed",
          reservation_key: reservationKey,
          consumed_by: consumedBy,
          recorded_at: at,
        }) as unknown as JsonValue,
        { ...this.codec(record.handoff_id), lock },
      );
    });
  }

  content(bindingValue: PrivateFileRangeHandoffBindingV1): ResolvedPrivateFileRangeV1 {
    const requested = cloneBinding(bindingValue);
    const record = this.readRecord(requested.handoff_id);
    if (!record || canonicalJsonBytes(binding(record)).compare(canonicalJsonBytes(requested)) !== 0)
      throw new Error("private file range handoff binding changed");
    const bytes = Buffer.from(record.content, "utf8");
    if (
      bytes.length !== record.content_byte_length ||
      digestV1("VF-PRIVATE-FILE-RANGE-CONTENT\0v1\0", {
        schema_version: "1.0",
        content: record.content,
      }) !== record.content_utf8_sha256
    )
      throw new Error("private file range handoff content is corrupt");
    // biome-ignore format: production file ceiling
    return { repo_relative_path: record.repo_relative_path, start_line: record.start_line, end_line: record.end_line, line_count: record.line_count, content: record.content };
  }
}
