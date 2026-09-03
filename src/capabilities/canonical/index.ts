export {
  canonicalJson,
  canonicalJsonBytes,
  digestHex,
  digestV1,
  sha256Digest,
} from "../../durability/index.js";
export type { CanonicalJsonOptions, JsonPrimitive, JsonValue } from "../../durability/index.js";

import { digestV1 } from "../../durability/index.js";
import { CapabilityValidationError, DIGEST_PATTERN } from "../wire/primitives.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const SOURCE_PERMISSION_TAGS = new Set(["n", "cw", "lr", "rc", "gh", "gs"]);
const SOURCE_CREDENTIAL_TAGS = new Set(["sr", "sg"]);

export function base32lowerNoPad(bytes: Uint8Array): string {
  let accumulator = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += BASE32[(accumulator << (5 - bits)) & 31];
  return output;
}

export function rawSha256Bytes(value: string): Buffer {
  if (!DIGEST_PATTERN.test(value))
    throw new CapabilityValidationError("invalid SHA-256 digest", "digest");
  return Buffer.from(value.slice(7), "hex");
}

export function sourcePermissionId(tag: string, permissionScopeDigest: string): string {
  if (!SOURCE_PERMISSION_TAGS.has(tag))
    throw new CapabilityValidationError("invalid source permission tag", "tag");
  return `vf.source/${tag}-${base32lowerNoPad(rawSha256Bytes(permissionScopeDigest))}`;
}

export function sourceCredentialInputId(tag: string, credentialBindingDigest: string): string {
  if (!SOURCE_CREDENTIAL_TAGS.has(tag))
    throw new CapabilityValidationError("invalid source credential tag", "tag");
  return `${tag}-${base32lowerNoPad(rawSha256Bytes(credentialBindingDigest))}`;
}

export function digestWithout<T extends Record<string, unknown>>(
  domain: string,
  value: T,
  omitted: keyof T,
): string {
  const copy = { ...value };
  delete copy[omitted];
  return digestV1(domain, copy);
}
