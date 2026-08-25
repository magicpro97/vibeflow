import { validatePackagePin } from "../../actions/package-pin-validation.js";
import { digestV1 } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import type {
  PackageAuthenticityBindingV1,
  PackagePinSourceV1,
  PackagePinV1,
  VerifiedRegistryEnvelopeV1,
} from "./types.js";

export function createPackagePin(input: {
  id: string;
  version: string;
  source: PackagePinSourceV1;
  content_sha256: string;
}): PackagePinV1 {
  const matrix = {
    registry: ["verified", false],
    git: ["source-pinned", false],
    "local-dev": ["dev-unverified", true],
    "legacy-adopt": ["legacy-verified", false],
  } as const;
  const [trust, nonportable] = matrix[input.source.kind];
  const preimage = { ...structuredClone(input), trust, nonportable };
  const pin: PackagePinV1 = {
    ...preimage,
    pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", preimage),
  };
  validatePackagePin(pin, "pin");
  return pin;
}

export function validateImmutablePackagePin(pin: PackagePinV1): PackagePinV1 {
  validatePackagePin(pin, "pin");
  if (pin.source.kind === "registry" && pin.trust !== "verified")
    throw new CapabilityValidationError("registry pin lost verified trust", "pin.trust");
  return structuredClone(pin);
}

export function createAuthenticityBinding(
  pin: PackagePinV1,
  manifestDigest: string,
  registry: VerifiedRegistryEnvelopeV1 | null,
): PackageAuthenticityBindingV1 {
  validateImmutablePackagePin(pin);
  if ((pin.source.kind === "registry") !== (registry !== null))
    throw new CapabilityValidationError(
      "registry authenticity binding nullability mismatch",
      "registry_signature",
    );
  if (registry && registry.status !== "verified")
    throw new CapabilityValidationError(
      "only a current verified registry envelope may create a pin",
      "registry_signature",
    );
  const registry_signature = registry
    ? {
        envelope_digest: registry.envelope_digest,
        key_id: registry.key_id,
        statement_expires_at: registry.statement_expires_at,
      }
    : null;
  if (
    pin.source.kind === "registry" &&
    registry_signature?.envelope_digest !== pin.source.signature_envelope_digest
  )
    throw new CapabilityValidationError(
      "pin and registry envelope digest disagree",
      "registry_signature",
    );
  const draft = {
    schema_version: "1.0" as const,
    pin_digest: pin.pin_digest,
    manifest_digest: manifestDigest,
    registry_signature,
  };
  return {
    ...draft,
    authenticity_digest: digestV1("VF-PACKAGE-AUTHENTICITY-BINDING\0v1\0", draft),
  };
}
