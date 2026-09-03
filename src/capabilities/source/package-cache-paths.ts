import { join } from "node:path";
import { digestHex } from "../../durability/index.js";
import {
  CapabilityValidationError,
  DIGEST_PATTERN,
  RAW_SHA256_PATTERN,
} from "../wire/primitives.js";

function checkedDigest(value: string, field: string): string {
  if (!DIGEST_PATTERN.test(value))
    throw new CapabilityValidationError("invalid cache digest", field);
  return digestHex(value);
}

export function packageTreeCachePath(privateRoot: string, contentSha256: string): string {
  if (!RAW_SHA256_PATTERN.test(contentSha256))
    throw new CapabilityValidationError("invalid package tree hash", "content_sha256");
  return join(privateRoot, "cache", "v1", "package-trees", contentSha256);
}

export const packageManifestCachePath = (root: string, digest: string): string =>
  join(root, "cache", "v1", "manifests", `${checkedDigest(digest, "manifest_digest")}.json`);

export const packageAuthenticityCachePath = (root: string, digest: string): string =>
  join(
    root,
    "cache",
    "v1",
    "authenticity-bindings",
    `${checkedDigest(digest, "authenticity_digest")}.json`,
  );

export const packageRegistryEnvelopeCachePath = (root: string, digest: string): string =>
  join(
    root,
    "cache",
    "v1",
    "registry-envelopes",
    `${checkedDigest(digest, "envelope_digest")}.json`,
  );

export const packageRecordCachePath = (root: string, digest: string): string =>
  join(root, "cache", "v1", "package-records", `${checkedDigest(digest, "pin_digest")}.json`);

export const legacyInspectionEvidenceCachePath = (root: string, digest: string): string =>
  join(
    root,
    "cache",
    "v1",
    "legacy-adopt-inspection-evidence",
    `${checkedDigest(digest, "inspection_evidence_digest")}.json`,
  );
