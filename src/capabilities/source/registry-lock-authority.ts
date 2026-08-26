import { parseStrictJson } from "../../actions/strict-json.js";
import {
  canonicalJson,
  canonicalJsonBytes,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import { parseCapabilityManifest } from "../manifest/validation.js";
import type { CapabilityLockEntryV1, CapabilityLockV1 } from "../wire/lock.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import type { DurableAuthorityTransitionResolverV1 } from "./durable-authority-transition-resolver.js";
import { readDurableRegistryTrustSnapshot } from "./durable-registry-authority.js";
import { validateLockInputsAgainstManifest } from "./lock-manifest-authority.js";
import {
  legacyInspectionEvidenceCachePath,
  packageAuthenticityCachePath,
  packageManifestCachePath,
  packageRecordCachePath,
  packageRegistryEnvelopeCachePath,
  packageTreeCachePath,
} from "./package-cache-paths.js";
import type { CapabilityPackageCacheRecordV1 } from "./package-cache-types.js";
import { validateCapabilityPackageCacheRecord } from "./package-cache-validation.js";
import {
  createAuthenticityBinding,
  revalidateCachedLegacyAdoptPackagePin,
  revalidateCachedRegistryPackagePin,
} from "./pins.js";
import { registryEnvelopeDigest, verifyRegistryEnvelope } from "./registry.js";
import { readPackageTree } from "./tree.js";
import type {
  LegacyInspectionEvidenceV1,
  PackageAuthenticityBindingV1,
  RegistrySignatureEnvelopeV1,
  RegistryTrustSnapshotV1,
  VerifiedRegistryEnvelopeV1,
} from "./types.js";

function readCanonicalJson<T>(path: string, maxBytes: number, label: string): T {
  const bytes = privateFileBytes(path, maxBytes);
  if (!bytes)
    throw new CapabilityValidationError(`${label} is missing`, label, "integrity_failure");
  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError(`${label} is corrupt`, label, "integrity_failure");
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(parsed, { maxBytes })))
    throw new CapabilityValidationError(`${label} is not canonical`, label, "integrity_failure");
  return parsed as T;
}

export function validateRetainedRegistryEnvelope(
  entry: CapabilityLockEntryV1 & {
    pin: CapabilityLockEntryV1["pin"] & {
      source: Extract<CapabilityLockEntryV1["pin"]["source"], { kind: "registry" }>;
    };
  },
  record: CapabilityPackageCacheRecordV1,
  input: {
    private_root: string;
    at: string;
    trust_snapshot: RegistryTrustSnapshotV1;
  },
): VerifiedRegistryEnvelopeV1 {
  const envelopeDigest = record.registry_envelope_digest as string;
  const envelope = readCanonicalJson<RegistrySignatureEnvelopeV1>(
    packageRegistryEnvelopeCachePath(input.private_root, envelopeDigest),
    512 * 1024,
    "registry cached envelope",
  );
  if (registryEnvelopeDigest(envelope) !== envelopeDigest)
    throw new CapabilityValidationError(
      "registry cached envelope fixed-path digest mismatch",
      "registry_cache.envelope",
      "integrity_failure",
    );
  const verified = verifyRegistryEnvelope(envelope, {
    trust_snapshot: input.trust_snapshot,
    at: input.at,
    mode: "locked",
    expected: {
      registry_origin: entry.pin.source.registry_origin,
      package_id: entry.pin.id,
      version: entry.pin.version,
      content_sha256: entry.pin.content_sha256,
    },
  });
  if (verified.status === "blocked")
    throw new CapabilityValidationError(
      "registry package signature is revoked",
      "registry_cache.envelope",
      "integrity_failure",
    );
  revalidateCachedRegistryPackagePin(record.package_pin, verified);
  return verified;
}

function validateEntryCache(
  entry: CapabilityLockEntryV1,
  input: {
    private_root: string;
    identity_path: string;
    scope: "project" | "user";
    scope_identity_digest: string;
    at: string;
    trust_snapshot: ReturnType<typeof readDurableRegistryTrustSnapshot> | null;
  },
): void {
  const record = validateCapabilityPackageCacheRecord(
    readCanonicalJson<CapabilityPackageCacheRecordV1>(
      packageRecordCachePath(input.private_root, entry.pin.pin_digest),
      2 * 1024 * 1024,
      "package cache record",
    ),
  );
  if (
    record.scope !== input.scope ||
    record.scope_identity_digest !== input.scope_identity_digest ||
    canonicalJson(record.package_pin) !== canonicalJson(entry.pin) ||
    record.manifest_digest !== entry.manifest_digest ||
    record.authenticity_digest !== entry.authenticity_binding.authenticity_digest ||
    record.registry_envelope_digest !==
      (entry.pin.source.kind === "registry" ? entry.pin.source.signature_envelope_digest : null)
  )
    throw new CapabilityValidationError(
      "package cache record does not bind the lock entry owner",
      "package_cache",
      "integrity_failure",
    );
  const tree = readPackageTree(packageTreeCachePath(input.private_root, entry.pin.content_sha256));
  if (
    tree.content_sha256 !== entry.pin.content_sha256 ||
    tree.entry_count !== record.tree_entry_count ||
    tree.expanded_byte_length !== record.tree_expanded_byte_length
  )
    throw new CapabilityValidationError(
      "package tree does not bind the cache record",
      "package_cache.tree",
      "integrity_failure",
    );
  const manifestSource = tree.files.get("capability.json");
  if (!manifestSource)
    throw new CapabilityValidationError(
      "package tree has no manifest",
      "package_cache.manifest",
      "integrity_failure",
    );
  const manifest = parseCapabilityManifest(manifestSource, tree.files);
  const storedManifest = readCanonicalJson<unknown>(
    packageManifestCachePath(input.private_root, record.manifest_digest),
    2 * 1024 * 1024,
    "cached manifest",
  );
  if (
    manifest.manifest_digest !== record.manifest_digest ||
    manifest.manifest.id !== entry.pin.id ||
    manifest.manifest.version !== entry.pin.version ||
    canonicalJson(storedManifest) !== canonicalJson(manifest.manifest)
  )
    throw new CapabilityValidationError(
      "cached manifest does not bind the package tree",
      "package_cache.manifest",
      "integrity_failure",
    );
  validateLockInputsAgainstManifest(entry, manifest.manifest);
  let verified = null;
  if (entry.pin.source.kind === "registry") {
    verified = validateRetainedRegistryEnvelope(
      entry as Parameters<typeof validateRetainedRegistryEnvelope>[0],
      record,
      {
        private_root: input.private_root,
        at: input.at,
        trust_snapshot: input.trust_snapshot as RegistryTrustSnapshotV1,
      },
    );
  } else if (entry.pin.source.kind === "legacy-adopt") {
    const evidence = readCanonicalJson<LegacyInspectionEvidenceV1>(
      legacyInspectionEvidenceCachePath(
        input.private_root,
        record.legacy_inspection_evidence_digest as string,
      ),
      2 * 1024 * 1024,
      "legacy inspection evidence",
    );
    if (evidence.evidence_digest !== record.legacy_inspection_evidence_digest)
      throw new CapabilityValidationError(
        "legacy inspection evidence digest mismatch",
        "package_cache.legacy_evidence",
        "integrity_failure",
      );
    revalidateCachedLegacyAdoptPackagePin(record.package_pin, {
      manifest,
      tree,
      evidence,
    });
  }
  const expectedAuthenticity = createAuthenticityBinding(
    record.package_pin,
    record.manifest_digest,
    verified,
  );
  const storedAuthenticity = readCanonicalJson<PackageAuthenticityBindingV1>(
    packageAuthenticityCachePath(input.private_root, record.authenticity_digest),
    512 * 1024,
    "cached authenticity",
  );
  if (
    canonicalJson(storedAuthenticity) !== canonicalJson(expectedAuthenticity) ||
    canonicalJson(entry.authenticity_binding) !== canonicalJson(expectedAuthenticity)
  )
    throw new CapabilityValidationError(
      "package authenticity is not derived from retained source authority",
      "package_cache.authenticity",
      "integrity_failure",
    );
}

export function validateRegistryLockAuthorityFromDurableState(
  locks: readonly CapabilityLockV1[],
  input: {
    private_root: string;
    identity_path: string;
    scope: "project" | "user";
    scope_identity_digest: string;
    at: string;
    authority_transition_resolver?: DurableAuthorityTransitionResolverV1;
  },
): void {
  const entries = new Map<string, CapabilityLockEntryV1>();
  let hasRegistry = false;
  for (const lock of locks) {
    for (const entry of lock.packages) {
      const prior = entries.get(entry.pin.pin_digest);
      const immutableIdentity = (value: CapabilityLockEntryV1) => ({
        package_id: value.package_id,
        pin: value.pin,
        manifest_digest: value.manifest_digest,
        authenticity_binding: value.authenticity_binding,
      });
      if (
        prior &&
        canonicalJson(immutableIdentity(prior)) !== canonicalJson(immutableIdentity(entry))
      )
        throw new CapabilityValidationError(
          "one package pin has conflicting immutable source authority history",
          "package_cache",
          "integrity_failure",
        );
      entries.set(entry.pin.pin_digest, entry);
      hasRegistry ||= entry.pin.source.kind === "registry";
    }
  }
  if (entries.size === 0) return;
  if (hasRegistry && !input.authority_transition_resolver)
    throw new CapabilityValidationError(
      "durable action authority resolver is unavailable",
      "authority.transition",
      "integrity_failure",
    );
  const trustSnapshot = hasRegistry
    ? readDurableRegistryTrustSnapshot({
        ...input,
        authority_transition_resolver:
          input.authority_transition_resolver as DurableAuthorityTransitionResolverV1,
      })
    : null;
  for (const entry of entries.values())
    validateEntryCache(entry, { ...input, trust_snapshot: trustSnapshot });
}
