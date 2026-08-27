import { canonicalJsonBytes } from "../durability/index.js";
import { ACTOR_KIND, CREDENTIAL_CLASS } from "./public-action-contract.js";
import { ActionValidationError, boundedString, exactObject, safeInteger } from "./strict-json.js";
import type { PublicActor } from "./types.js";

export const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const RAW_SHA256 = /^[a-f0-9]{64}$/;
export const DERIVED_ID = /^vf-[a-z][a-z0-9-]*-[a-f0-9]{64}$/;
export const PACKAGE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

export function assertDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new ActionValidationError("expected canonical sha256 digest", path);
  return value;
}

export function assertRawSha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !RAW_SHA256.test(value))
    throw new ActionValidationError("expected lowercase raw sha256", path);
  return value;
}

export function assertDerivedId(value: unknown, kind: string, path: string): string {
  const pattern = new RegExp(`^vf-${kind}-[a-f0-9]{64}$`);
  if (typeof value !== "string" || !pattern.test(value))
    throw new ActionValidationError(`expected derived ${kind} ID`, path);
  return value;
}

export function assertOpaqueId(value: unknown, path: string, max = 512): string {
  const result = boundedString(value, path, { max });
  if (!/^[\x21-\x7e]+$/.test(result))
    throw new ActionValidationError("opaque ID must be printable ASCII", path);
  return result;
}

export function assertPackageId(value: unknown, path: string): string {
  const result = boundedString(value, path, { max: 128 });
  if (!PACKAGE_ID.test(result)) throw new ActionValidationError("invalid package ID", path);
  return result;
}

export function assertTimestamp(value: unknown, path: string): number {
  const text = boundedString(value, path, { max: 32 });
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== text)
    throw new ActionValidationError("expected millisecond RFC-3339 timestamp", path);
  return epoch;
}

export function assertActor(value: unknown, path: string): PublicActor {
  const row = exactObject(value, ["kind", "public_actor_id", "credential_class"], [], path);
  if (!Object.values(ACTOR_KIND).some((candidate) => candidate === row.kind))
    throw new ActionValidationError("invalid actor kind", `${path}.kind`);
  if (!Object.values(CREDENTIAL_CLASS).some((candidate) => candidate === row.credential_class))
    throw new ActionValidationError("invalid credential class", `${path}.credential_class`);
  assertOpaqueId(row.public_actor_id, `${path}.public_actor_id`, 256);
  return value as PublicActor;
}

export function assertStringArray(
  value: unknown,
  path: string,
  options: { max?: number; min?: number; sorted?: boolean; digest?: boolean } = {},
): string[] {
  if (
    !Array.isArray(value) ||
    value.length < (options.min ?? 0) ||
    value.length > (options.max ?? 256)
  )
    throw new ActionValidationError("invalid bounded array", path);
  const output = value.map((item, index) =>
    options.digest
      ? assertDigest(item, `${path}[${index}]`)
      : assertOpaqueId(item, `${path}[${index}]`),
  );
  if (new Set(output).size !== output.length)
    throw new ActionValidationError("duplicate array identity", path);
  if (options.sorted && output.some((item, index) => item !== [...output].sort(bytewise)[index]))
    throw new ActionValidationError("array is not bytewise sorted", path);
  return output;
}

export function assertSafeInteger(value: unknown, path: string): number {
  return safeInteger(value, path);
}

export function bytewise(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function assertCanonicalSize(value: unknown, maxBytes: number, label: string): void {
  if (canonicalJsonBytes(value, { maxBytes }).length > maxBytes)
    throw new ActionValidationError(`${label} exceeds byte limit`);
}
