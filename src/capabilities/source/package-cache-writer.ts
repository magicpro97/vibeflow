import type { ProcessLock } from "../../durability/index.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  createOrVerifyPrivateFile,
  digestV1,
} from "../../durability/index.js";
import { assertValidatedCapabilityManifest } from "../manifest/validation.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  legacyInspectionEvidenceCachePath,
  packageAuthenticityCachePath,
  packageManifestCachePath,
  packageRecordCachePath,
  packageRegistryEnvelopeCachePath,
  packageTreeCachePath,
} from "./package-cache-paths.js";
import type {
  CapabilityPackageCachePublicationV1,
  CapabilityPackageCacheRecordV1,
} from "./package-cache-types.js";
import {
  capabilityPackageCacheRecordDigest,
  validateCapabilityPackageCacheRecord,
} from "./package-cache-validation.js";
import {
  assertVerifiedLegacyAdoptPackagePin,
  assertVerifiedRegistryPackagePin,
  createAuthenticityBinding,
  validateImmutablePackagePin,
  validateLegacyInspectionEvidence,
} from "./pins.js";
import { registryEnvelopeDigest } from "./registry.js";
import { assertValidatedPackageTree, materializePackageTree } from "./tree.js";

export interface RetainCapabilityPackageCacheOptionsV1 {
  private_root: string;
  scope: "project" | "user";
  scope_identity_digest: string;
  lock: ProcessLock;
}

export function retainCapabilityPackageCache(
  publication: CapabilityPackageCachePublicationV1,
  options: RetainCapabilityPackageCacheOptionsV1,
): CapabilityPackageCacheRecordV1 {
  const pin = validateImmutablePackagePin(publication.pin);
  const tree = assertValidatedPackageTree(publication.tree);
  const manifest = assertValidatedCapabilityManifest(publication.manifest);
  const manifestSource = tree.files.get("capability.json");
  if (
    !manifestSource ||
    !Buffer.from(manifestSource).equals(manifest.source_bytes) ||
    pin.id !== manifest.manifest.id ||
    pin.version !== manifest.manifest.version ||
    pin.content_sha256 !== tree.content_sha256
  )
    throw new CapabilityValidationError(
      "package cache publication identities disagree",
      "package_cache",
      "integrity_failure",
    );

  let verified = null;
  if (pin.source.kind === "registry") {
    verified = assertVerifiedRegistryPackagePin(publication.pin);
    if (
      !publication.registry_envelope ||
      registryEnvelopeDigest(publication.registry_envelope) !== verified.envelope_digest
    )
      throw new CapabilityValidationError(
        "registry cache publication lacks the exact verified envelope",
        "package_cache.registry_envelope",
        "integrity_failure",
      );
  } else if (publication.registry_envelope !== null) {
    throw new CapabilityValidationError(
      "non-registry cache publication carries a registry envelope",
      "package_cache.registry_envelope",
    );
  }
  const expectedAuthenticity = createAuthenticityBinding(
    publication.pin,
    manifest.manifest_digest,
    verified,
  );
  if (canonicalJson(expectedAuthenticity) !== canonicalJson(publication.authenticity))
    throw new CapabilityValidationError(
      "cache authenticity is not derived from the retained pin and manifest",
      "package_cache.authenticity",
      "integrity_failure",
    );

  let legacyDigest: string | null = null;
  if (pin.source.kind === "legacy-adopt") {
    if (publication.legacy_inspection_evidence === null)
      throw new CapabilityValidationError(
        "legacy cache publication lacks validated inspection evidence",
        "package_cache.legacy_evidence",
        "integrity_failure",
      );
    const evidence = validateLegacyInspectionEvidence(
      publication.legacy_inspection_evidence as import("./types.js").LegacyInspectionEvidenceV1,
    );
    const authority = assertVerifiedLegacyAdoptPackagePin(publication.pin);
    if (
      authority.mode !== "inspector-issued" ||
      authority.manifest_digest !== manifest.manifest_digest ||
      authority.content_sha256 !== tree.content_sha256 ||
      canonicalJson(authority.evidence) !== canonicalJson(evidence)
    )
      throw new CapabilityValidationError(
        "legacy cache publication differs from validated migration closure",
        "package_cache.legacy_evidence",
        "integrity_failure",
      );
    legacyDigest = evidence.evidence_digest;
  } else if (publication.legacy_inspection_evidence !== null) {
    throw new CapabilityValidationError(
      "non-legacy cache publication carries legacy inspection evidence",
      "package_cache.legacy_evidence",
      "integrity_failure",
    );
  }
  materializePackageTree(
    packageTreeCachePath(options.private_root, tree.content_sha256),
    tree,
    options.lock,
  );
  createOrVerifyPrivateFile(
    packageManifestCachePath(options.private_root, manifest.manifest_digest),
    manifest.canonical_bytes,
    { lock: options.lock, maxBytes: 512 * 1024 },
  );
  createOrVerifyPrivateFile(
    packageAuthenticityCachePath(options.private_root, expectedAuthenticity.authenticity_digest),
    canonicalJsonBytes(expectedAuthenticity),
    { lock: options.lock, maxBytes: 512 * 1024 },
  );
  if (publication.registry_envelope)
    createOrVerifyPrivateFile(
      packageRegistryEnvelopeCachePath(options.private_root, verified?.envelope_digest as string),
      canonicalJsonBytes(publication.registry_envelope),
      { lock: options.lock, maxBytes: 512 * 1024 },
    );
  if (legacyDigest)
    createOrVerifyPrivateFile(
      legacyInspectionEvidenceCachePath(options.private_root, legacyDigest),
      canonicalJsonBytes(publication.legacy_inspection_evidence),
      { lock: options.lock, maxBytes: 2 * 1024 * 1024 },
    );

  const draft = {
    schema_version: "1.0" as const,
    scope: options.scope,
    scope_identity_digest: options.scope_identity_digest,
    package_pin: publication.pin,
    manifest_digest: manifest.manifest_digest,
    authenticity_digest: expectedAuthenticity.authenticity_digest,
    tree_entry_count: tree.entry_count,
    tree_expanded_byte_length: tree.expanded_byte_length,
    registry_envelope_digest: verified?.envelope_digest ?? null,
    legacy_inspection_evidence_digest: legacyDigest,
  };
  const record = validateCapabilityPackageCacheRecord({
    ...draft,
    record_digest: capabilityPackageCacheRecordDigest(draft),
  });
  createOrVerifyPrivateFile(
    packageRecordCachePath(options.private_root, pin.pin_digest),
    canonicalJsonBytes(record),
    { lock: options.lock, maxBytes: 2 * 1024 * 1024 },
  );
  return record;
}
