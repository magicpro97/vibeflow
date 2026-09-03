import { CAPABILITY_SOURCE_KIND } from "../../actions/capability-security-contract.js";
import { digestV1 } from "../../durability/index.js";
import type { CapabilityLockEntryV1 } from "../wire/lock.js";
import { CapabilityValidationError, digest, exactKeys, timestamp } from "../wire/primitives.js";

export function validateLockEntryAuthenticity(entry: CapabilityLockEntryV1): void {
  const binding = entry.authenticity_binding;
  const path = `${entry.package_id}.authenticity_binding`;
  exactKeys(
    binding,
    [
      "schema_version",
      "pin_digest",
      "manifest_digest",
      "registry_signature",
      "authenticity_digest",
    ],
    [],
    path,
  );
  if (binding.schema_version !== "1.0")
    throw new CapabilityValidationError(
      "unsupported authenticity binding schema",
      `${path}.schema_version`,
      "unsupported_schema_version",
    );
  digest(binding.pin_digest, `${path}.pin_digest`);
  digest(binding.manifest_digest, `${path}.manifest_digest`);
  digest(binding.authenticity_digest, `${path}.authenticity_digest`);
  if (binding.registry_signature !== null) {
    exactKeys(
      binding.registry_signature,
      ["envelope_digest", "key_id", "statement_expires_at"],
      [],
      `${path}.registry_signature`,
    );
    digest(
      binding.registry_signature.envelope_digest,
      `${path}.registry_signature.envelope_digest`,
    );
    digest(binding.registry_signature.key_id, `${path}.registry_signature.key_id`);
    timestamp(
      binding.registry_signature.statement_expires_at,
      `${path}.registry_signature.statement_expires_at`,
    );
  }
  const { authenticity_digest: _, ...preimage } = binding;
  if (binding.authenticity_digest !== digestV1("VF-PACKAGE-AUTHENTICITY-BINDING\0v1\0", preimage))
    throw new CapabilityValidationError(
      "authenticity binding digest mismatch",
      path,
      "integrity_failure",
    );
  if (
    binding.pin_digest !== entry.pin.pin_digest ||
    binding.manifest_digest !== entry.manifest_digest
  )
    throw new CapabilityValidationError("authenticity binding does not match lock entry", path);
  if (
    (entry.pin.source.kind === CAPABILITY_SOURCE_KIND.REGISTRY) !==
    (binding.registry_signature !== null)
  )
    throw new CapabilityValidationError("registry signature nullability mismatch", path);
  if (
    entry.pin.source.kind === CAPABILITY_SOURCE_KIND.REGISTRY &&
    binding.registry_signature?.envelope_digest !== entry.pin.source.signature_envelope_digest
  )
    throw new CapabilityValidationError("registry envelope digest differs from pin", path);
}
