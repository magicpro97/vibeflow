import { digestV1 } from "../../durability/index.js";
import { CONVERSATION_MESSAGE_QUEUE_LIMITS } from "./conversation-message-queue-contract.js";
import { CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS } from "./conversation-private-context-broker-contract.js";
import {
  PRIVATE_FILE_RANGE_STAGING_LIMIT,
  PRIVATE_FILE_RANGE_STAGING_STATE,
  PRIVATE_FILE_RANGE_STAGING_STATES,
  type PrivateFileRangeStagingStateV1,
} from "./private-file-range-staging-contract.js";
import {
  type PrivateFileRangesStagingFrameValidationConfig,
  assertPrivateFileRangesStagingFrameChain as assertFrameChainValidator,
  assertPrivateFileRangesStagingFrameV1 as assertFrameValidator,
} from "./private-file-ranges-staging-frame-validators.js";

export const PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION = "1.0" as const;
export const PRIVATE_FILE_RANGES_STAGING_IDENTIFIER_PREFIX = "vf-file-ranges" as const;
export const PRIVATE_FILE_RANGES_STAGING_STATE = PRIVATE_FILE_RANGE_STAGING_STATE;
export const PRIVATE_FILE_RANGES_STAGING_STATES = PRIVATE_FILE_RANGE_STAGING_STATES;
export type PrivateFileRangesStagingStateV1 = PrivateFileRangeStagingStateV1;

export const PRIVATE_FILE_RANGES_STAGING_LIMIT = Object.freeze({
  MAX_RECORD_BYTES: CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRecordBytes,
  MAX_CONTENT_BYTES: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxContentBytes,
  MAX_REPO_RELATIVE_PATH_BYTES: CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRepoRelativePathBytes,
  MAX_REFERENCE_BYTES: 4 * 1_024,
  MAX_FRAMES: 8,
  DEFAULT_TTL_MS: 10 * 60_000,
} as const);

export const PRIVATE_FILE_RANGES_STAGING_STORAGE = Object.freeze({
  DOMAIN: "private-file-range-staging",
  RECORDS_DIRECTORY: "private-file-ranges-records",
  FRAMES_DIRECTORY: "private-file-ranges-staging",
  WRITER_LOCK_FILE: "private-file-ranges-staging.writer.lock",
} as const);

export const PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN = Object.freeze({
  CONTENT: "VF-PRIVATE-FILE-RANGES-CONTENT\0v1\0",
  REQUEST: "VF-PRIVATE-FILE-RANGES-STAGING-REQUEST\0v1\0",
  AGGREGATE: "VF-PRIVATE-FILE-RANGES-STAGING-AGGREGATE\0v1\0",
  RECORD: "VF-PRIVATE-FILE-RANGES-STAGING-RECORD\0v1\0",
  FRAME: "VF-PRIVATE-FILE-RANGES-STAGING-FRAME\0v1\0",
} as const);

export const PRIVATE_FILE_RANGES_STAGING_PATTERN = Object.freeze({
  HANDOFF_ID: Object.freeze(
    new RegExp(`^${PRIVATE_FILE_RANGES_STAGING_IDENTIFIER_PREFIX}-[0-9a-f]{64}$`, "u"),
  ),
  DIGEST: Object.freeze(/^sha256:[0-9a-f]{64}$/u),
});

export const PRIVATE_FILE_RANGES_STAGING_RECORD_FIELDS = Object.freeze([
  "schema_version",
  "handoff_id",
  "request_digest",
  "ranges",
  "file_count",
  "range_count",
  "total_line_count",
  "total_content_byte_length",
  "aggregate_digest",
  "staged_at",
  "expires_at",
  "record_digest",
] as const);
export const PRIVATE_FILE_RANGES_STAGING_RANGE_FIELDS = Object.freeze([
  "repo_relative_path",
  "start_line",
  "end_line",
  "line_count",
  "content",
  "content_utf8_sha256",
  "content_byte_length",
] as const);
export const PRIVATE_FILE_RANGES_HANDOFF_BINDING_FIELDS = Object.freeze([
  "schema_version",
  "handoff_id",
  "handoff_record_digest",
  "file_count",
  "range_count",
  "total_line_count",
  "total_content_byte_length",
  "aggregate_digest",
  "staged_at",
  "expires_at",
] as const);
export const PRIVATE_FILE_RANGES_STAGING_FRAME_FIELDS = Object.freeze([
  "schema_version",
  "handoff_id",
  "sequence",
  "previous_frame_digest",
  "handoff_record_digest",
  "state",
  "reservation_key",
  "consumed_by",
  "recorded_at",
  "frame_digest",
] as const);

export const isPrivateFileRangeRepoRelativePath = (value: unknown): value is string =>
  typeof value === "string" &&
  value.normalize("NFC") === value &&
  bytes(value) > 0 &&
  bytes(value) <= PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_REPO_RELATIVE_PATH_BYTES &&
  !Array.from(value).some(
    (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
  ) &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.startsWith("/") &&
  !value.startsWith("~") &&
  value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

export interface PrivateFileRangesStagingRangeV1 {
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  content: string;
  content_utf8_sha256: string;
  content_byte_length: number;
}

export interface PrivateFileRangesStagingRecordV1 {
  schema_version: typeof PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION;
  handoff_id: string;
  request_digest: string;
  ranges: readonly PrivateFileRangesStagingRangeV1[];
  file_count: number;
  range_count: number;
  total_line_count: number;
  total_content_byte_length: number;
  aggregate_digest: string;
  staged_at: string;
  expires_at: string;
  record_digest: string;
}

export interface PrivateFileRangesHandoffBindingV1 {
  schema_version: typeof PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION;
  handoff_id: string;
  handoff_record_digest: string;
  file_count: number;
  range_count: number;
  total_line_count: number;
  total_content_byte_length: number;
  aggregate_digest: string;
  staged_at: string;
  expires_at: string;
}

export interface PrivateFileRangesStagingFrameV1 {
  schema_version: typeof PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION;
  handoff_id: string;
  sequence: number;
  previous_frame_digest: string | null;
  handoff_record_digest: string;
  state: PrivateFileRangesStagingStateV1;
  reservation_key: string | null;
  consumed_by: string | null;
  recorded_at: string;
  frame_digest: string;
}

export type PrivateFileRangesStagingFrameMutationV1 = Pick<
  PrivateFileRangesStagingFrameV1,
  "state" | "reservation_key" | "consumed_by" | "recorded_at"
>;

export interface ResolvedPrivateFileRangesV1 {
  file_count: number;
  range_count: number;
  total_line_count: number;
  total_content_byte_length: number;
  aggregate_digest: string;
  ranges: readonly PrivateFileRangesStagingRangeV1[];
}

export interface PrivateFileRangesStageInputV1 {
  handoff_id: string;
  ranges: readonly {
    repo_relative_path: string;
    start_line: number;
    end_line: number;
  }[];
  staged_at: string;
  ttl_ms?: number;
}

const objectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Object.getOwnPropertySymbols(value).length === 0;
const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
};
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const digest = (value: unknown): value is string =>
  typeof value === "string" && PRIVATE_FILE_RANGES_STAGING_PATTERN.DIGEST.test(value);
const validLine = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;
const validTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const boundedInteger = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const reference = (value: unknown): value is string =>
  typeof value === "string" &&
  bytes(value) > 0 &&
  bytes(value) <= PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_REFERENCE_BYTES &&
  !/\p{Cc}/u.test(value);

function assertRange(value: unknown): asserts value is PrivateFileRangesStagingRangeV1 {
  if (
    !objectRecord(value) ||
    !exact(value, PRIVATE_FILE_RANGES_STAGING_RANGE_FIELDS) ||
    !isPrivateFileRangeRepoRelativePath(value.repo_relative_path) ||
    !validLine(value.start_line) ||
    !validLine(value.end_line) ||
    value.end_line < value.start_line ||
    value.end_line - value.start_line + 1 >
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFileRangeLines ||
    value.line_count !== value.end_line - value.start_line + 1 ||
    typeof value.content !== "string" ||
    bytes(value.content) < 1 ||
    bytes(value.content) > PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_CONTENT_BYTES ||
    !digest(value.content_utf8_sha256) ||
    value.content_byte_length !== bytes(value.content)
  )
    throw new Error("invalid private file ranges staging range");
}

export function assertPrivateFileRangesHandoffBindingV1(
  value: unknown,
): asserts value is PrivateFileRangesHandoffBindingV1 {
  if (
    !objectRecord(value) ||
    !exact(value, PRIVATE_FILE_RANGES_HANDOFF_BINDING_FIELDS) ||
    value.schema_version !== PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION ||
    typeof value.handoff_id !== "string" ||
    !PRIVATE_FILE_RANGES_STAGING_PATTERN.HANDOFF_ID.test(value.handoff_id) ||
    !digest(value.handoff_record_digest) ||
    !boundedInteger(value.file_count, 1, CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFiles) ||
    !boundedInteger(value.range_count, 1, CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRanges) ||
    !boundedInteger(
      value.total_line_count,
      1,
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxTotalLines,
    ) ||
    !boundedInteger(
      value.total_content_byte_length,
      1,
      PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_CONTENT_BYTES,
    ) ||
    !digest(value.aggregate_digest) ||
    !validTimestamp(value.staged_at) ||
    !validTimestamp(value.expires_at) ||
    Date.parse(value.expires_at) <= Date.parse(value.staged_at)
  )
    throw new Error("invalid private file ranges handoff binding");
}

export function assertPrivateFileRangesStagingRecordV1(
  value: unknown,
): asserts value is PrivateFileRangesStagingRecordV1 {
  if (
    !objectRecord(value) ||
    !exact(value, PRIVATE_FILE_RANGES_STAGING_RECORD_FIELDS) ||
    value.schema_version !== PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION ||
    typeof value.handoff_id !== "string" ||
    !PRIVATE_FILE_RANGES_STAGING_PATTERN.HANDOFF_ID.test(value.handoff_id) ||
    !digest(value.request_digest) ||
    !Array.isArray(value.ranges) ||
    value.ranges.length < 1 ||
    value.ranges.length > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRanges ||
    !boundedInteger(value.file_count, 1, CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxFiles) ||
    !boundedInteger(value.range_count, 1, CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRanges) ||
    value.range_count !== value.ranges.length ||
    !boundedInteger(
      value.total_line_count,
      1,
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxTotalLines,
    ) ||
    !boundedInteger(
      value.total_content_byte_length,
      1,
      PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_CONTENT_BYTES,
    ) ||
    !digest(value.aggregate_digest) ||
    !validTimestamp(value.staged_at) ||
    !validTimestamp(value.expires_at) ||
    Date.parse(value.expires_at) <= Date.parse(value.staged_at) ||
    !digest(value.record_digest)
  )
    throw new Error("invalid private file ranges staging record");

  let fileCount = 0;
  let totalLines = 0;
  let totalBytes = 0;
  let priorPath = "";
  let priorEnd = 0;
  for (const range of value.ranges) {
    assertRange(range);
    if (
      priorPath &&
      (Buffer.compare(Buffer.from(priorPath), Buffer.from(range.repo_relative_path)) > 0 ||
        (priorPath === range.repo_relative_path && range.start_line <= priorEnd + 1))
    )
      throw new Error("private file ranges staging order changed");
    if (range.repo_relative_path !== priorPath) fileCount += 1;
    priorPath = range.repo_relative_path;
    priorEnd = range.end_line;
    totalLines += range.line_count;
    totalBytes += range.content_byte_length;
  }
  if (
    value.file_count !== fileCount ||
    value.total_line_count !== totalLines ||
    value.total_content_byte_length !== totalBytes
  )
    throw new Error("invalid private file ranges staging aggregate");
}

const frameValidationConfig: PrivateFileRangesStagingFrameValidationConfig = {
  objectRecord,
  exact,
  schemaVersion: PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION,
  handoffPattern: PRIVATE_FILE_RANGES_STAGING_PATTERN.HANDOFF_ID,
  boundedInteger,
  digest,
  states: PRIVATE_FILE_RANGES_STAGING_STATES,
  validTimestamp,
  reference,
  fields: PRIVATE_FILE_RANGES_STAGING_FRAME_FIELDS,
  maxFrames: PRIVATE_FILE_RANGES_STAGING_LIMIT.MAX_FRAMES,
  availableState: PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE,
  reservedState: PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED,
  consumedState: PRIVATE_FILE_RANGE_STAGING_STATE.CONSUMED,
};

export function assertPrivateFileRangesStagingFrameV1(
  value: unknown,
): asserts value is PrivateFileRangesStagingFrameV1 {
  assertFrameValidator(value, frameValidationConfig);
}

export function assertPrivateFileRangesStagingFrameChain(
  frames: readonly PrivateFileRangesStagingFrameV1[],
): void {
  assertFrameChainValidator(frames, frameValidationConfig, assertFrameValidator);
}

export function aggregateContentDigest(ranges: readonly PrivateFileRangesStagingRangeV1[]): string {
  return digestV1(PRIVATE_FILE_RANGES_STAGING_DIGEST_DOMAIN.AGGREGATE, {
    schema_version: PRIVATE_FILE_RANGES_STAGING_SCHEMA_VERSION,
    ranges: ranges.map(({ content: _content, ...range }) => range),
  });
}
