import { join } from "node:path";
import { parseStrictJson } from "../../actions/strict-json.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestHex,
  privateFileBytes,
} from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";

const JSON_LIMIT = 2 * 1024 * 1024;

function fail(message: string, path = "authority.transition"): never {
  throw new CapabilityValidationError(message, path, "integrity_failure");
}

export function readCanonicalAuthorityRecord<T>(path: string, label: string): T {
  const bytes = privateFileBytes(path, JSON_LIMIT);
  if (!bytes) return fail(`${label} is missing`, label);
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(`${label} is corrupt`, label);
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(value, { maxBytes: JSON_LIMIT })))
    return fail(`${label} is not canonical`, label);
  return value as T;
}

export function readActionAuthorityObject<T>(root: string, objectDigest: string, label: string): T {
  return readCanonicalAuthorityRecord<T>(
    join(root, "actions", "v1", "objects", `${digestHex(objectDigest)}.json`),
    label,
  );
}

export function canonicalJsonMatches(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
