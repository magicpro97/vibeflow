import { canonicalJsonBytes } from "../../durability/index.js";

export class CapabilityValidationError extends Error {
  readonly code:
    | "invalid_capability"
    | "unsupported_schema_version"
    | "bounds"
    | "integrity_failure";
  readonly path: string;

  constructor(
    message: string,
    path = "$",
    code: CapabilityValidationError["code"] = "invalid_capability",
  ) {
    super(`${path}: ${message}`);
    this.name = "CapabilityValidationError";
    this.path = path;
    this.code = code;
  }
}

export const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const RAW_SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
export const LOCAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
export const DERIVED_ID_PATTERN = /^vf-[a-z][a-z0-9-]*-[a-f0-9]{64}$/;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CapabilityValidationError("expected object", path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new CapabilityValidationError("non-plain object is forbidden", path);
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): Record<string, unknown> {
  const row = record(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(row)) {
    if (["__proto__", "constructor", "prototype"].includes(key) || !allowed.has(key))
      throw new CapabilityValidationError(
        `unknown or forbidden field ${JSON.stringify(key)}`,
        path,
      );
  }
  for (const key of required) {
    if (!Object.hasOwn(row, key))
      throw new CapabilityValidationError(`missing field ${JSON.stringify(key)}`, path);
  }
  return row;
}

export function text(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; ascii?: boolean; controls?: boolean; nfc?: boolean } = {},
): string {
  if (typeof value !== "string") throw new CapabilityValidationError("expected string", path);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < (options.min ?? 0) || bytes > (options.max ?? 512))
    throw new CapabilityValidationError("string byte length is out of bounds", path, "bounds");
  if (options.ascii && !/^[\x20-\x7e]*$/.test(value))
    throw new CapabilityValidationError("expected printable ASCII", path);
  if (options.controls !== true && /\p{Cc}/u.test(value))
    throw new CapabilityValidationError("control characters are forbidden", path);
  if (options.nfc !== false && value.normalize("NFC") !== value)
    throw new CapabilityValidationError("text must already be NFC", path);
  return value;
}

export function enumeration<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new CapabilityValidationError("invalid enum value", path);
  return value as T;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new CapabilityValidationError("expected boolean", path);
  return value;
}

export function integer(
  value: unknown,
  path: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new CapabilityValidationError("expected bounded safe integer", path, "bounds");
  return value as number;
}

export function digest(value: unknown, path: string): string {
  const result = text(value, path, { min: 71, max: 71, ascii: true });
  if (!DIGEST_PATTERN.test(result))
    throw new CapabilityValidationError("expected canonical SHA-256 digest", path);
  return result;
}

export function rawSha256(value: unknown, path: string): string {
  const result = text(value, path, { min: 64, max: 64, ascii: true });
  if (!RAW_SHA256_PATTERN.test(result))
    throw new CapabilityValidationError("expected lowercase raw SHA-256", path);
  return result;
}

export function packageId(value: unknown, path: string): string {
  const result = text(value, path, { min: 1, max: 128, ascii: true });
  if (!PACKAGE_ID_PATTERN.test(result) || result === "vf.source")
    throw new CapabilityValidationError("invalid or reserved package ID", path);
  return result;
}

export function localId(value: unknown, path: string): string {
  const result = text(value, path, { min: 1, max: 64, ascii: true });
  if (!LOCAL_ID_PATTERN.test(result)) throw new CapabilityValidationError("invalid local ID", path);
  return result;
}

export function timestamp(value: unknown, path: string): number {
  const result = text(value, path, { min: 24, max: 24, ascii: true });
  const epoch = Date.parse(result);
  if (
    !TIMESTAMP_PATTERN.test(result) ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString() !== result
  )
    throw new CapabilityValidationError("expected UTC RFC-3339 milliseconds", path);
  return epoch;
}

export function assertCanonicalSize(value: unknown, maxBytes: number, path = "$"): void {
  if (canonicalJsonBytes(value, { maxBytes }).length > maxBytes)
    throw new CapabilityValidationError("canonical object exceeds byte limit", path, "bounds");
}

export function bytewise(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

export function assertSortedUnique<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
  path: string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compare(values[index - 1] as T, values[index] as T) >= 0)
      throw new CapabilityValidationError("array must be strictly sorted and unique", path);
  }
}
