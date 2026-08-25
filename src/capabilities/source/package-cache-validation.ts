import { digestV1 } from "../../durability/index.js";
import { CapabilityValidationError, digest, exactKeys, integer } from "../wire/primitives.js";
import type { CapabilityPackageCacheRecordV1 } from "./package-cache-types.js";
import { validateImmutablePackagePin } from "./pins.js";

export function capabilityPackageCacheRecordDigest(
  value: Omit<CapabilityPackageCacheRecordV1, "record_digest">,
): string {
  return digestV1("VF-CAPABILITY-PACKAGE-CACHE-RECORD\0v1\0", value);
}

export function validateCapabilityPackageCacheRecord(
  value: CapabilityPackageCacheRecordV1,
): CapabilityPackageCacheRecordV1 {
  exactKeys(
    value,
    [
      "schema_version",
      "scope",
      "scope_identity_digest",
      "package_pin",
      "manifest_digest",
      "authenticity_digest",
      "tree_entry_count",
      "tree_expanded_byte_length",
      "registry_envelope_digest",
      "legacy_inspection_evidence_digest",
      "record_digest",
    ],
    [],
    "package_cache_record",
  );
  if (value.schema_version !== "1.0" || !["project", "user"].includes(value.scope))
    throw new CapabilityValidationError(
      "invalid package cache record schema/scope",
      "package_cache_record",
    );
  digest(value.scope_identity_digest, "package_cache_record.scope_identity_digest");
  validateImmutablePackagePin(value.package_pin);
  for (const field of ["manifest_digest", "authenticity_digest", "record_digest"] as const)
    digest(value[field], `package_cache_record.${field}`);
  for (const field of ["registry_envelope_digest", "legacy_inspection_evidence_digest"] as const)
    if (value[field] !== null) digest(value[field], `package_cache_record.${field}`);
  integer(value.tree_entry_count, "package_cache_record.tree_entry_count", 1, 10_000);
  integer(
    value.tree_expanded_byte_length,
    "package_cache_record.tree_expanded_byte_length",
    1,
    64 * 1024 * 1024,
  );
  const registry = value.package_pin.source.kind === "registry";
  const legacy = value.package_pin.source.kind === "legacy-adopt";
  if (
    registry !== (value.registry_envelope_digest !== null) ||
    legacy !== (value.legacy_inspection_evidence_digest !== null)
  )
    throw new CapabilityValidationError(
      "package cache source evidence nullability mismatch",
      "package_cache_record",
    );
  const { record_digest: observed, ...preimage } = value;
  if (observed !== capabilityPackageCacheRecordDigest(preimage))
    throw new CapabilityValidationError(
      "package cache record digest mismatch",
      "package_cache_record",
      "integrity_failure",
    );
  return structuredClone(value);
}
