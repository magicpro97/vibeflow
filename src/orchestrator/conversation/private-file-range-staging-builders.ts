import { digestV1 } from "../../durability/index.js";
import {
  PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN,
  PRIVATE_FILE_RANGE_STAGING_LIMIT,
  PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
  PRIVATE_FILE_RANGE_STAGING_STATE,
  type PrivateFileRangeHandoffBindingV1,
  type PrivateFileRangeStagingFrameMutationV1,
  type PrivateFileRangeStagingFrameV1,
  type PrivateFileRangeStagingRecordV1,
  assertPrivateFileRangeHandoffBindingV1,
  assertPrivateFileRangeStagingFrameChain,
  assertPrivateFileRangeStagingRecordV1,
  isPrivateFileRangeLine,
  isPrivateFileRangeRepoRelativePath,
  isPrivateFileRangeTimestamp,
} from "./private-file-range-staging-contract.js";

export interface PrivateFileRangeStageInputV1 {
  handoff_id: string;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  content: string;
  staged_at: string;
  ttl_ms?: number;
}

export function privateFileRangeHandoffBinding(
  record: PrivateFileRangeStagingRecordV1,
): PrivateFileRangeHandoffBindingV1 {
  const output: PrivateFileRangeHandoffBindingV1 = {
    schema_version: PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
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

export function buildPrivateFileRangeStagingFrame(
  record: PrivateFileRangeStagingRecordV1,
  prior: PrivateFileRangeStagingFrameV1 | null,
  input: PrivateFileRangeStagingFrameMutationV1,
): PrivateFileRangeStagingFrameV1 {
  const preimage = {
    schema_version: PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
    handoff_id: record.handoff_id,
    sequence: (prior?.sequence ?? -1) + 1,
    previous_frame_digest: prior?.frame_digest ?? null,
    handoff_record_digest: record.record_digest,
    ...structuredClone(input),
  };
  return {
    ...preimage,
    frame_digest: digestV1(PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN.FRAME, preimage),
  };
}

export function buildPrivateFileRangeStage(input: PrivateFileRangeStageInputV1): {
  record: PrivateFileRangeStagingRecordV1;
  binding: PrivateFileRangeHandoffBindingV1;
} {
  if (!isPrivateFileRangeRepoRelativePath(input.repo_relative_path))
    throw new Error("private file range path is invalid");
  const bytes = Buffer.from(input.content, "utf8");
  if (bytes.length === 0 || bytes.length > PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_CONTENT_BYTES)
    throw new Error("private file range content is empty or oversized");
  if (
    !isPrivateFileRangeLine(input.start_line) ||
    !isPrivateFileRangeLine(input.end_line) ||
    input.end_line < input.start_line
  )
    throw new Error("private file range line bounds are invalid");
  if (!isPrivateFileRangeTimestamp(input.staged_at))
    throw new Error("private file range timestamp is invalid");
  const ttl = input.ttl_ms ?? PRIVATE_FILE_RANGE_STAGING_LIMIT.DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("private file range TTL is invalid");
  const expiresAtMilliseconds = Date.parse(input.staged_at) + ttl;
  if (!Number.isFinite(expiresAtMilliseconds))
    throw new Error("private file range expiry is invalid");
  let expiresAt: string;
  try {
    expiresAt = new Date(expiresAtMilliseconds).toISOString();
  } catch {
    throw new Error("private file range expiry is invalid");
  }
  const withoutDigest = {
    schema_version: PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
    handoff_id: input.handoff_id,
    repo_relative_path: input.repo_relative_path,
    start_line: input.start_line,
    end_line: input.end_line,
    line_count: input.end_line - input.start_line + 1,
    content: input.content,
    content_utf8_sha256: digestV1(PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN.CONTENT, {
      schema_version: PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION,
      content: input.content,
    }),
    content_byte_length: bytes.length,
    staged_at: input.staged_at,
    expires_at: expiresAt,
  };
  const record: PrivateFileRangeStagingRecordV1 = {
    ...withoutDigest,
    record_digest: digestV1(PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN.RECORD, withoutDigest),
  };
  assertPrivateFileRangeStagingRecordV1(record);
  const binding = privateFileRangeHandoffBinding(record);
  assertPrivateFileRangeStagingFrameChain([
    buildPrivateFileRangeStagingFrame(record, null, {
      state: PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE,
      reservation_key: null,
      consumed_by: null,
      recorded_at: input.staged_at,
    }),
  ]);
  return { record, binding };
}
