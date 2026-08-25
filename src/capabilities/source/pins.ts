import { validatePackagePin } from "../../actions/package-pin-validation.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import type { ValidatedCapabilityManifestV1 } from "../manifest/types.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  validateLegacyAdoptClosure,
  validateLegacyInspectionEvidence,
} from "./legacy-adopt-closure.js";
import { assertSignatureVerifiedRegistryEnvelope } from "./registry.js";
import type { PackageTreeV1 } from "./tree.js";
import type {
  LegacyInspectionEvidenceV1,
  PackageAuthenticityBindingV1,
  PackagePinSourceV1,
  PackagePinV1,
  ValidatedLegacyInspectionEvidenceV1,
  VerifiedRegistryEnvelopeV1,
} from "./types.js";

export { validateLegacyInspectionEvidence } from "./legacy-adopt-closure.js";

type NonRegistryPackagePinSourceV1 = Exclude<PackagePinSourceV1, { kind: "registry" }>;

const VERIFIED_REGISTRY_PINS = new WeakMap<object, VerifiedRegistryEnvelopeV1>();
const VERIFIED_LEGACY_PINS = new WeakMap<
  object,
  {
    mode: "inspector-issued" | "durable-cache";
    evidence: ValidatedLegacyInspectionEvidenceV1;
    manifest_digest: string;
    content_sha256: string;
  }
>();

function materializePackagePin(input: {
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

function registryPackagePin(verification: VerifiedRegistryEnvelopeV1): PackagePinV1 {
  const statement = assertSignatureVerifiedRegistryEnvelope(verification).statement;
  return materializePackagePin({
    id: statement.package_id,
    version: statement.version,
    source: {
      kind: "registry",
      registry_origin: statement.registry_origin,
      source_url: statement.provenance.source_url,
      commit_oid: statement.provenance.commit_oid,
      signature_envelope_digest: verification.envelope_digest,
    },
    content_sha256: statement.content_sha256,
  });
}

export function createPackagePin(input: {
  id: string;
  version: string;
  source: NonRegistryPackagePinSourceV1;
  content_sha256: string;
}): PackagePinV1 {
  if ((input.source as PackagePinSourceV1).kind === "registry")
    throw new CapabilityValidationError(
      "registry pins require signature-verified resolution authority",
      "pin.source",
    );
  if (input.source.kind === "legacy-adopt")
    throw new CapabilityValidationError(
      "legacy adoption pins require validated migration inspection closure",
      "pin.source",
      "integrity_failure",
    );
  return materializePackagePin(input);
}

export function createLegacyAdoptPackagePin(input: {
  manifest: ValidatedCapabilityManifestV1;
  tree: PackageTreeV1;
  evidence: LegacyInspectionEvidenceV1;
}): PackagePinV1 {
  const closure = validateLegacyAdoptClosure(input, { requireIssuedEvidence: true });
  const pin = Object.freeze(
    materializePackagePin({
      id: closure.manifest.manifest.id,
      version: closure.manifest.manifest.version,
      source: {
        kind: "legacy-adopt",
        legacy_source: closure.evidence.legacy_source,
        inspection_evidence_digest: closure.evidence.evidence_digest,
      },
      content_sha256: closure.tree.content_sha256,
    }),
  );
  VERIFIED_LEGACY_PINS.set(pin, {
    mode: "inspector-issued",
    evidence: closure.evidence,
    manifest_digest: closure.manifest.manifest_digest,
    content_sha256: closure.tree.content_sha256,
  });
  return pin;
}

export function revalidateCachedLegacyAdoptPackagePin(
  pin: PackagePinV1,
  input: {
    manifest: ValidatedCapabilityManifestV1;
    tree: PackageTreeV1;
    evidence: LegacyInspectionEvidenceV1;
  },
): PackagePinV1 {
  const closure = validateLegacyAdoptClosure(input, { requireIssuedEvidence: false });
  const expected = materializePackagePin({
    id: closure.manifest.manifest.id,
    version: closure.manifest.manifest.version,
    source: {
      kind: "legacy-adopt",
      legacy_source: closure.evidence.legacy_source,
      inspection_evidence_digest: closure.evidence.evidence_digest,
    },
    content_sha256: closure.tree.content_sha256,
  });
  validatePackagePin(pin, "pin");
  if (canonicalJson(pin) !== canonicalJson(expected))
    throw new CapabilityValidationError(
      "cached legacy pin does not equal its validated inspection closure",
      "pin",
      "integrity_failure",
    );
  VERIFIED_LEGACY_PINS.set(pin, {
    mode: "durable-cache",
    evidence: closure.evidence,
    manifest_digest: closure.manifest.manifest_digest,
    content_sha256: closure.tree.content_sha256,
  });
  return pin;
}

export function assertVerifiedLegacyAdoptPackagePin(pin: PackagePinV1) {
  const authority = VERIFIED_LEGACY_PINS.get(pin);
  if (!authority)
    throw new CapabilityValidationError(
      "legacy pin is not derived from validated migration inspection closure",
      "pin",
      "integrity_failure",
    );
  return authority;
}

export function createVerifiedRegistryPackagePin(
  verification: VerifiedRegistryEnvelopeV1,
): PackagePinV1 {
  const authority = assertSignatureVerifiedRegistryEnvelope(verification);
  if (authority.mode !== "resolution" || verification.status !== "verified")
    throw new CapabilityValidationError(
      "new registry pins require current resolution authority",
      "registry_signature",
    );
  const pin = Object.freeze(registryPackagePin(verification));
  VERIFIED_REGISTRY_PINS.set(pin, verification);
  return pin;
}

export function revalidateCachedRegistryPackagePin(
  pin: PackagePinV1,
  verification: VerifiedRegistryEnvelopeV1,
): PackagePinV1 {
  const authority = assertSignatureVerifiedRegistryEnvelope(verification);
  if (authority.mode !== "locked" && authority.mode !== "resolution")
    throw new CapabilityValidationError("invalid registry verification mode", "registry_signature");
  const expected = registryPackagePin(verification);
  validateImmutablePackagePin(pin);
  if (canonicalJson(pin) !== canonicalJson(expected))
    throw new CapabilityValidationError(
      "cached registry pin does not equal the signature-verified statement",
      "pin",
      "integrity_failure",
    );
  VERIFIED_REGISTRY_PINS.set(pin, verification);
  return pin;
}

export function validateImmutablePackagePin(pin: PackagePinV1): PackagePinV1 {
  validatePackagePin(pin, "pin");
  if (pin.source.kind === "registry" && pin.trust !== "verified")
    throw new CapabilityValidationError("registry pin lost verified trust", "pin.trust");
  const clone = structuredClone(pin);
  const verification = VERIFIED_REGISTRY_PINS.get(pin);
  if (verification) VERIFIED_REGISTRY_PINS.set(clone, verification);
  const legacy = VERIFIED_LEGACY_PINS.get(pin);
  if (legacy) VERIFIED_LEGACY_PINS.set(clone, legacy);
  return clone;
}

export function assertVerifiedRegistryPackagePin(pin: PackagePinV1): VerifiedRegistryEnvelopeV1 {
  const verification = VERIFIED_REGISTRY_PINS.get(pin);
  if (!verification)
    throw new CapabilityValidationError(
      "registry pin is not derived from signature-verified resolution",
      "pin",
      "integrity_failure",
    );
  assertSignatureVerifiedRegistryEnvelope(verification);
  return verification;
}

export function createAuthenticityBinding(
  pin: PackagePinV1,
  manifestDigest: string,
  registry: VerifiedRegistryEnvelopeV1 | null,
): PackageAuthenticityBindingV1 {
  validateImmutablePackagePin(pin);
  if (pin.source.kind === "legacy-adopt") {
    const authority = assertVerifiedLegacyAdoptPackagePin(pin);
    if (authority.manifest_digest !== manifestDigest)
      throw new CapabilityValidationError(
        "legacy authenticity manifest differs from validated migration closure",
        "manifest_digest",
        "integrity_failure",
      );
  }
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
  if (registry) {
    const authority = assertSignatureVerifiedRegistryEnvelope(registry);
    const pinAuthority = assertVerifiedRegistryPackagePin(pin);
    if (
      pinAuthority !== registry ||
      authority.statement.package_id !== pin.id ||
      authority.statement.version !== pin.version ||
      authority.statement.content_sha256 !== pin.content_sha256
    )
      throw new CapabilityValidationError(
        "registry verification authority does not bind this package pin",
        "registry_signature",
        "integrity_failure",
      );
  }
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
