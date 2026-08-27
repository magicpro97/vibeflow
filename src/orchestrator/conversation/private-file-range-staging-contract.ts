export const PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION = "1.0" as const;
export const PRIVATE_FILE_RANGE_STAGING_IDENTIFIER_PREFIX = "vf-file-range" as const;

export const PRIVATE_FILE_RANGE_STAGING_STATE = Object.freeze({
  AVAILABLE: "available",
  RESERVED: "reserved",
  CONSUMED: "consumed",
} as const);

export type PrivateFileRangeStagingStateV1 =
  (typeof PRIVATE_FILE_RANGE_STAGING_STATE)[keyof typeof PRIVATE_FILE_RANGE_STAGING_STATE];

export const PRIVATE_FILE_RANGE_STAGING_STATES = Object.freeze(
  Object.values(PRIVATE_FILE_RANGE_STAGING_STATE),
);

export const PRIVATE_FILE_RANGE_STAGING_LIMIT = Object.freeze({
  MAX_RECORD_BYTES: 256 * 1_024,
  MAX_CONTENT_BYTES: 64 * 1_024,
  MAX_FRAMES: 8,
  MAX_REPO_RELATIVE_PATH_BYTES: 4 * 1_024,
  MAX_REFERENCE_BYTES: 4 * 1_024,
  DEFAULT_TTL_MS: 10 * 60_000,
} as const);

export const PRIVATE_FILE_RANGE_MAX_FRAMES = PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_FRAMES;

export const PRIVATE_FILE_RANGE_STAGING_STORAGE = Object.freeze({
  DOMAIN: "private-file-range-staging",
  RECORDS_DIRECTORY: "private-file-range-records",
  FRAMES_DIRECTORY: "private-file-range-staging",
  WRITER_LOCK_FILE: "private-file-range-staging.writer.lock",
} as const);

export const PRIVATE_FILE_RANGE_STAGING_DIGEST_DOMAIN = Object.freeze({
  CONTENT: "VF-PRIVATE-FILE-RANGE-CONTENT\0v1\0",
  RECORD: "VF-PRIVATE-FILE-RANGE-STAGING-RECORD\0v1\0",
  FRAME: "VF-PRIVATE-FILE-RANGE-STAGING-FRAME\0v1\0",
} as const);

export const PRIVATE_FILE_RANGE_STAGING_PATTERN = Object.freeze({
  HANDOFF_ID: Object.freeze(
    new RegExp(`^${PRIVATE_FILE_RANGE_STAGING_IDENTIFIER_PREFIX}-[0-9a-f]{64}$`, "u"),
  ),
  DIGEST: Object.freeze(/^sha256:[0-9a-f]{64}$/u),
} as const);

export const PRIVATE_FILE_RANGE_STAGING_FRAME_FIELD = Object.freeze({
  SCHEMA_VERSION: "schema_version",
  HANDOFF_ID: "handoff_id",
  SEQUENCE: "sequence",
  PREVIOUS_FRAME_DIGEST: "previous_frame_digest",
  HANDOFF_RECORD_DIGEST: "handoff_record_digest",
  STATE: "state",
  RESERVATION_KEY: "reservation_key",
  CONSUMED_BY: "consumed_by",
  RECORDED_AT: "recorded_at",
  FRAME_DIGEST: "frame_digest",
} as const);

export const PRIVATE_FILE_RANGE_STAGING_FRAME_FIELDS = Object.freeze(
  Object.values(PRIVATE_FILE_RANGE_STAGING_FRAME_FIELD),
);

export const PRIVATE_FILE_RANGE_STAGING_RECORD_FIELD = Object.freeze({
  SCHEMA_VERSION: "schema_version",
  HANDOFF_ID: "handoff_id",
  REPO_RELATIVE_PATH: "repo_relative_path",
  START_LINE: "start_line",
  END_LINE: "end_line",
  LINE_COUNT: "line_count",
  CONTENT: "content",
  CONTENT_UTF8_SHA256: "content_utf8_sha256",
  CONTENT_BYTE_LENGTH: "content_byte_length",
  STAGED_AT: "staged_at",
  EXPIRES_AT: "expires_at",
  RECORD_DIGEST: "record_digest",
} as const);

export const PRIVATE_FILE_RANGE_STAGING_RECORD_FIELDS = Object.freeze(
  Object.values(PRIVATE_FILE_RANGE_STAGING_RECORD_FIELD),
);

export const PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELD = Object.freeze({
  SCHEMA_VERSION: "schema_version",
  HANDOFF_ID: "handoff_id",
  HANDOFF_RECORD_DIGEST: "handoff_record_digest",
  REPO_RELATIVE_PATH: "repo_relative_path",
  START_LINE: "start_line",
  END_LINE: "end_line",
  LINE_COUNT: "line_count",
  STAGED_AT: "staged_at",
  EXPIRES_AT: "expires_at",
} as const);

export const PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELDS = Object.freeze(
  Object.values(PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELD),
);

export const PRIVATE_FILE_RANGE_STAGING_FRAME_MUTATION_FIELDS = Object.freeze([
  PRIVATE_FILE_RANGE_STAGING_FRAME_FIELD.STATE,
  PRIVATE_FILE_RANGE_STAGING_FRAME_FIELD.RESERVATION_KEY,
  PRIVATE_FILE_RANGE_STAGING_FRAME_FIELD.CONSUMED_BY,
  PRIVATE_FILE_RANGE_STAGING_FRAME_FIELD.RECORDED_AT,
] as const);

export interface PrivateFileRangeHandoffBindingV1 {
  schema_version: typeof PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION;
  handoff_id: string;
  handoff_record_digest: string;
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  staged_at: string;
  expires_at: string;
}

export interface PrivateFileRangeStagingRecordV1 {
  schema_version: typeof PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION;
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

export interface PrivateFileRangeStagingFrameV1 {
  schema_version: typeof PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION;
  handoff_id: string;
  sequence: number;
  previous_frame_digest: string | null;
  handoff_record_digest: string;
  state: PrivateFileRangeStagingStateV1;
  reservation_key: string | null;
  consumed_by: string | null;
  recorded_at: string;
  frame_digest: string;
}

export type PrivateFileRangeStagingFrameMutationV1 = Pick<
  PrivateFileRangeStagingFrameV1,
  (typeof PRIVATE_FILE_RANGE_STAGING_FRAME_MUTATION_FIELDS)[number]
>;

export interface ResolvedPrivateFileRangeV1 {
  repo_relative_path: string;
  start_line: number;
  end_line: number;
  line_count: number;
  content: string;
}

type SameKeys<Shape, Fields extends readonly PropertyKey[]> = Exclude<
  keyof Shape,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof Shape> extends never
    ? true
    : false
  : false;

export const PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELD_CONTRACT_EXACT: SameKeys<
  PrivateFileRangeHandoffBindingV1,
  typeof PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELDS
> = true;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Object.getOwnPropertySymbols(value).length === 0;

const exactFields = (value: Record<string, unknown>, fields: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

export const isPrivateFileRangeLine = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

export const isPrivateFileRangeTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;

export const isPrivateFileRangeRepoRelativePath = (value: unknown): value is string =>
  typeof value === "string" &&
  utf8Bytes(value) > 0 &&
  utf8Bytes(value) <= PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_REPO_RELATIVE_PATH_BYTES &&
  !Array.from(value).some(
    (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
  ) &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !value.startsWith("~") &&
  value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

const isDigest = (value: unknown): value is string =>
  typeof value === "string" && PRIVATE_FILE_RANGE_STAGING_PATTERN.DIGEST.test(value);

const isReference = (value: unknown): value is string =>
  typeof value === "string" &&
  utf8Bytes(value) > 0 &&
  utf8Bytes(value) <= PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_REFERENCE_BYTES &&
  !/\p{Cc}/u.test(value);

export const isPrivateFileRangeStagingState = (
  value: unknown,
): value is PrivateFileRangeStagingStateV1 =>
  typeof value === "string" &&
  PRIVATE_FILE_RANGE_STAGING_STATES.some((candidate) => candidate === value);

export function assertPrivateFileRangeHandoffBindingV1(
  value: unknown,
): asserts value is PrivateFileRangeHandoffBindingV1 {
  if (
    !record(value) ||
    !exactFields(value, PRIVATE_FILE_RANGE_HANDOFF_BINDING_FIELDS) ||
    value.schema_version !== PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION ||
    typeof value.handoff_id !== "string" ||
    !PRIVATE_FILE_RANGE_STAGING_PATTERN.HANDOFF_ID.test(value.handoff_id) ||
    !isDigest(value.handoff_record_digest) ||
    !isPrivateFileRangeRepoRelativePath(value.repo_relative_path) ||
    !isPrivateFileRangeLine(value.start_line) ||
    !isPrivateFileRangeLine(value.end_line) ||
    value.end_line < value.start_line ||
    !Number.isSafeInteger(value.line_count) ||
    value.line_count !== value.end_line - value.start_line + 1 ||
    !isPrivateFileRangeTimestamp(value.staged_at) ||
    !isPrivateFileRangeTimestamp(value.expires_at) ||
    Date.parse(value.expires_at) <= Date.parse(value.staged_at)
  )
    throw new Error("invalid private file range handoff binding");
}

export function assertPrivateFileRangeStagingRecordV1(
  value: unknown,
): asserts value is PrivateFileRangeStagingRecordV1 {
  if (
    !record(value) ||
    !exactFields(value, PRIVATE_FILE_RANGE_STAGING_RECORD_FIELDS) ||
    value.schema_version !== PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION ||
    typeof value.handoff_id !== "string" ||
    !PRIVATE_FILE_RANGE_STAGING_PATTERN.HANDOFF_ID.test(value.handoff_id) ||
    !isPrivateFileRangeRepoRelativePath(value.repo_relative_path) ||
    !isPrivateFileRangeLine(value.start_line) ||
    !isPrivateFileRangeLine(value.end_line) ||
    value.end_line < value.start_line ||
    !Number.isSafeInteger(value.line_count) ||
    value.line_count !== value.end_line - value.start_line + 1 ||
    typeof value.content !== "string" ||
    utf8Bytes(value.content) === 0 ||
    utf8Bytes(value.content) > PRIVATE_FILE_RANGE_STAGING_LIMIT.MAX_CONTENT_BYTES ||
    !isDigest(value.content_utf8_sha256) ||
    value.content_byte_length !== utf8Bytes(value.content) ||
    !isPrivateFileRangeTimestamp(value.staged_at) ||
    !isPrivateFileRangeTimestamp(value.expires_at) ||
    Date.parse(value.expires_at) <= Date.parse(value.staged_at) ||
    !isDigest(value.record_digest)
  )
    throw new Error("invalid private file range staging record");
}

export function assertPrivateFileRangeStagingFrameV1(
  value: unknown,
): asserts value is PrivateFileRangeStagingFrameV1 {
  if (
    !record(value) ||
    !exactFields(value, PRIVATE_FILE_RANGE_STAGING_FRAME_FIELDS) ||
    value.schema_version !== PRIVATE_FILE_RANGE_STAGING_SCHEMA_VERSION ||
    typeof value.handoff_id !== "string" ||
    !PRIVATE_FILE_RANGE_STAGING_PATTERN.HANDOFF_ID.test(value.handoff_id) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.sequence === 0
      ? value.previous_frame_digest !== null
      : !isDigest(value.previous_frame_digest)) ||
    !isDigest(value.handoff_record_digest) ||
    !isPrivateFileRangeStagingState(value.state) ||
    !isPrivateFileRangeTimestamp(value.recorded_at) ||
    !isDigest(value.frame_digest)
  )
    throw new Error("invalid private file range staging frame");

  const available =
    value.state === PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE &&
    value.reservation_key === null &&
    value.consumed_by === null;
  const reserved =
    value.state === PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED &&
    isReference(value.reservation_key) &&
    value.consumed_by === null;
  const consumed =
    value.state === PRIVATE_FILE_RANGE_STAGING_STATE.CONSUMED &&
    isReference(value.reservation_key) &&
    isReference(value.consumed_by);
  if (!available && !reserved && !consumed)
    throw new Error("invalid private file range staging frame state binding");
}

export function assertPrivateFileRangeStagingFrameChain(
  frames: readonly PrivateFileRangeStagingFrameV1[],
): void {
  if (frames.length === 0) return;
  const first = frames[0] as PrivateFileRangeStagingFrameV1;
  if (
    first.sequence !== 0 ||
    first.state !== PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE ||
    first.previous_frame_digest !== null
  )
    throw new Error("invalid private file range staging genesis");
  for (let index = 0; index < frames.length; index += 1) {
    const current = frames[index] as PrivateFileRangeStagingFrameV1;
    assertPrivateFileRangeStagingFrameV1(current);
    if (
      current.sequence !== index ||
      current.handoff_id !== first.handoff_id ||
      current.handoff_record_digest !== first.handoff_record_digest
    )
      throw new Error("private file range staging frame authority changed");
    if (index === 0) continue;
    const prior = frames[index - 1] as PrivateFileRangeStagingFrameV1;
    if (current.previous_frame_digest !== prior.frame_digest)
      throw new Error("private file range staging frame link changed");
    if (Date.parse(current.recorded_at) < Date.parse(prior.recorded_at))
      throw new Error("private file range staging timestamp regressed");
    const legal =
      (prior.state === PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE &&
        current.state === PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED) ||
      (prior.state === PRIVATE_FILE_RANGE_STAGING_STATE.RESERVED &&
        (current.state === PRIVATE_FILE_RANGE_STAGING_STATE.AVAILABLE ||
          (current.state === PRIVATE_FILE_RANGE_STAGING_STATE.CONSUMED &&
            current.reservation_key === prior.reservation_key)));
    if (!legal) throw new Error("invalid private file range staging transition");
  }
}
