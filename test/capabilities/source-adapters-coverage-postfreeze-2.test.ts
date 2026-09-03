import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ActionAuthorityStore,
  createDurableActionAuthorityReaderV1,
} from "../../src/actions/index.js";
import { FilesystemCapabilityEffectBrokerV1 } from "../../src/capabilities/adapters/filesystem-broker.js";
import {
  mutateFilesystemPayload,
  observeFilesystemPayload,
} from "../../src/capabilities/adapters/filesystem-effects.js";
import {
  compareAndSwapProjectionFile,
  compareAndSwapTomlOwnedBlock,
  parseProjectionJson,
  projectionStateBytes,
  readJsonSlice,
  replaceTomlOwnedBlock,
  tomlOwnedBlock,
  writeJsonSlice,
} from "../../src/capabilities/adapters/filesystem-io.js";
import { assertPayloadPreimageBytes } from "../../src/capabilities/adapters/filesystem-preimage.js";
import { reconcileFilesystemPayload } from "../../src/capabilities/adapters/filesystem-reconcile.js";
import { buildFilesystemRemoval } from "../../src/capabilities/adapters/filesystem-removal.js";
import {
  assertPersistedPrivateEffectPayload,
  bindResourcePreimage,
  hydratePrivateEffectPayload,
  persistedPrivateEffectPayload,
  privateEffectPreimageBytes,
} from "../../src/capabilities/adapters/payload-preimage-authority.js";
import {
  bindPrivateEffectOwnerPreimage,
  privateEffectBinding,
  privateEffectDescriptor,
  privateEffectOwnerPreimageBinding,
  privateEffectPayloadDigest,
  restorePrivateEffectOwnerBinding,
  validateAdapterPrivateDescriptor,
  validatePrivateEffectBinding,
  validatePrivateEffectOwnerPreimageBinding,
  validatePrivateEffectPayload,
} from "../../src/capabilities/adapters/private-descriptors.js";
import { assertPrivateEffectPayloadShape } from "../../src/capabilities/adapters/private-payload-shape.js";
import {
  finalizePayload,
  markerPath,
  privatePreimageBytes,
  projectionName,
  projectionOwnershipKey,
  projectionResource,
  readMarker,
} from "../../src/capabilities/adapters/projection-builder-shared.js";
import { buildFilesystemProjection } from "../../src/capabilities/adapters/projection-builders.js";
import {
  CAPABILITY_ADAPTER_REGISTRY_V1,
  resolveCapabilityAdapter,
  resolveLegacyAdoptionAdapter,
  validateCapabilityAdapterRegistry,
} from "../../src/capabilities/adapters/registry.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityEffectDescriptorV1,
  CapabilityEffectPreparationRequestV1,
  CapabilityOwnedResourceV1,
  CapabilityPrivateEffectBindingV1,
  CapabilityPrivateEffectPayloadV1,
} from "../../src/capabilities/adapters/types.js";
import {
  authorityEpochHeadDigest,
  authorityScopeIdentityDigest,
  grantStateDigest,
  secretRevocationStateDigest,
} from "../../src/capabilities/authority/index.js";
import type {
  AuthorityEpochHeadV1,
  AuthorityScopeIdentityRecordV1,
} from "../../src/capabilities/authority/index.js";
import { FilesystemLegacyMarkerReaderV1 } from "../../src/capabilities/legacy/filesystem-reader.js";
import type {
  CapabilityComponentV1,
  CapabilityManifestV1,
} from "../../src/capabilities/manifest/types.js";
import { parseCapabilityManifest } from "../../src/capabilities/manifest/validation.js";
import {
  activationDependentFiles,
  findUniqueInitialAuthorityCheckpoint,
  materializeActivationReceipt,
  parseCanonicalActivation,
  validateActivationReceipt,
} from "../../src/capabilities/source/authority-activation-records.js";
import {
  assertDurableAuthorityState,
  readDurableAuthorityState,
} from "../../src/capabilities/source/durable-authority-state.js";
import { createDurableAuthorityTransitionResolver } from "../../src/capabilities/source/durable-authority-transition-resolver.js";
import {
  assertDurableRegistryTrustSnapshot,
  readDurableRegistryTrustSnapshot,
} from "../../src/capabilities/source/durable-registry-authority.js";
import {
  assertFinalAuthorityJournalState,
  readDurableSettingsPolicyState,
} from "../../src/capabilities/source/durable-registry-policy.js";
import {
  issueLegacyInspectionEvidence,
  validateLegacyAdoptClosure,
  validateLegacyInspectionEvidence,
} from "../../src/capabilities/source/legacy-adopt-closure.js";
import {
  legacyInspectionEvidenceCachePath,
  packageAuthenticityCachePath,
  packageManifestCachePath,
  packageRecordCachePath,
} from "../../src/capabilities/source/package-cache-paths.js";
import type { CapabilityPackageCacheRecordV1 } from "../../src/capabilities/source/package-cache-types.js";
import { capabilityPackageCacheRecordDigest } from "../../src/capabilities/source/package-cache-validation.js";
import { retainCapabilityPackageCache } from "../../src/capabilities/source/package-cache-writer.js";
import {
  assertVerifiedLegacyAdoptPackagePin,
  assertVerifiedRegistryPackagePin,
  createAuthenticityBinding,
  createLegacyAdoptPackagePin,
  createPackagePin,
  createVerifiedRegistryPackagePin,
  revalidateCachedLegacyAdoptPackagePin,
  revalidateCachedRegistryPackagePin,
  validateImmutablePackagePin,
} from "../../src/capabilities/source/pins.js";
import { validateRegistryLockAuthorityFromDurableState } from "../../src/capabilities/source/registry-lock-authority.js";
import {
  registryStatementSigningBytes,
  verifyRegistryEnvelope,
} from "../../src/capabilities/source/registry.js";
import {
  assertValidatedResolutionCandidate,
  createResolutionCandidate,
  createResolutionCompatibilityRecord,
} from "../../src/capabilities/source/resolution-records.js";
import {
  compareSemver,
  parseSemver,
  validateVersionRange,
  versionSatisfiesRange,
} from "../../src/capabilities/source/semver.js";
import {
  assertValidatedPackageTree,
  computePackageTree,
  materializePackageTree,
} from "../../src/capabilities/source/tree.js";
import type {
  LegacyInspectionEvidenceV1,
  PackagePinV1,
  RegistryPackageStatementV1,
  RegistrySignatureEnvelopeV1,
  VerifiedRegistryEnvelopeV1,
} from "../../src/capabilities/source/types.js";
import { projectCapabilityPaths } from "../../src/capabilities/storage/paths.js";
import type { CapabilityLockEntryV1, CapabilityLockV1 } from "../../src/capabilities/wire/lock.js";
import {
  acquireProcessLock,
  canonicalJsonBytes,
  digestV1,
  sha256Digest,
} from "../../src/durability/index.js";
import { roleManifest } from "./fixtures.js";
import { durableRegistryTrustFixture } from "./registry-authority-fixture.js";
import { resolvedRolePackage, runtimeDigest } from "./runtime-fixtures.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoots() {
  const project = mkdtempSync(join(tmpdir(), "vf-cap-source-adapters-project-"));
  const user = mkdtempSync(join(tmpdir(), "vf-cap-source-adapters-user-"));
  roots.push(project, user);
  return { project, user };
}

function write(root: string, relative: string, bytes: string | Uint8Array): void {
  const path = join(root, ...relative.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
}

function writeAbsolute(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}

function canonical(value: unknown): Buffer {
  return canonicalJsonBytes(value);
}

function cacheLockEntry(input: {
  pin: PackagePinV1;
  manifestDigest: string;
  authenticity: CapabilityLockEntryV1["authenticity_binding"];
}): CapabilityLockEntryV1 {
  return {
    package_id: input.pin.id,
    pin: input.pin,
    manifest_digest: input.manifestDigest,
    authenticity_binding: input.authenticity,
    lock_entry_digest: runtimeDigest(`cache-entry:${input.pin.pin_digest}`),
    dependencies: [],
    public_inputs: [],
    secret_input_ids: [],
    portable_input_digest: runtimeDigest(`cache-inputs:${input.pin.pin_digest}`),
    targets: [],
    ownership_keys: [],
  };
}

function cacheLock(...entries: CapabilityLockEntryV1[]): CapabilityLockV1 {
  return {
    schema_version: "1.0",
    fabric_active: true,
    scope: "project",
    generation_id: `vf-generation-${"1".repeat(64)}`,
    generation_ordinal: 0,
    parent_generation_digests: [],
    packages: entries,
    policy_digest: runtimeDigest("cache-lock-policy"),
    permission_digest: runtimeDigest("cache-lock-permission"),
    created_at: "2026-08-26T00:00:00.000Z",
    content_digest: runtimeDigest("cache-lock"),
  };
}

function cacheRecordWith(
  record: CapabilityPackageCacheRecordV1,
  overrides: Partial<Omit<CapabilityPackageCacheRecordV1, "record_digest">>,
): CapabilityPackageCacheRecordV1 {
  const { record_digest: _, ...preimage } = { ...record, ...overrides };
  return {
    ...preimage,
    record_digest: capabilityPackageCacheRecordDigest(preimage),
  };
}

function localCacheAuthorityFixture() {
  const pkg = resolvedRolePackage();
  const tree = computePackageTree([...pkg.files].map(([path, bytes]) => ({ path, bytes })));
  const manifest = parseCapabilityManifest(
    tree.files.get("capability.json") as Uint8Array,
    tree.files,
  );
  const root = mkdtempSync(join(tmpdir(), "vf-cap-lock-cache-"));
  roots.push(root);
  const privateRoot = join(root, "private");
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const scopeIdentityDigest = runtimeDigest(`cache-owner:${root}`);
  const processLock = acquireProcessLock(join(privateRoot, "writer.lock"), {
    operation: "registry-lock-authority-coverage",
  });
  let record: CapabilityPackageCacheRecordV1;
  try {
    record = retainCapabilityPackageCache(
      {
        pin: pkg.pin,
        tree,
        manifest,
        authenticity: pkg.authenticity_binding,
        registry_envelope: null,
        legacy_inspection_evidence: null,
      },
      {
        private_root: privateRoot,
        scope: "project",
        scope_identity_digest: scopeIdentityDigest,
        lock: processLock,
      },
    );
  } finally {
    processLock.release();
  }
  const entry = cacheLockEntry({
    pin: pkg.pin,
    manifestDigest: manifest.manifest_digest,
    authenticity: pkg.authenticity_binding,
  });
  return {
    authenticity: pkg.authenticity_binding,
    entry,
    input: {
      private_root: privateRoot,
      identity_path: join(root, "unused-identity.json"),
      scope: "project" as const,
      scope_identity_digest: scopeIdentityDigest,
      at: "2026-08-26T00:00:00.000Z",
    },
    lock: cacheLock(entry),
    manifest,
    privateRoot,
    record,
    tree,
  };
}

function resource(
  ownershipKey = "vf:project:codex:global:skill:acme.coverage:main",
): CapabilityOwnedResourceV1 {
  return {
    ownership_key: ownershipKey,
    kind: "file",
    public_target: "target.txt",
    expected_preimage_sha256: null,
    expected_postimage_sha256: null,
    private_preimage_digest: null,
    private_preimage_ref: null,
  };
}

function payload<T extends Omit<CapabilityPrivateEffectPayloadV1, "payload_digest">>(
  value: T,
): CapabilityPrivateEffectPayloadV1 {
  return finalizePayload(value);
}

function ownedFile(
  overrides: Partial<
    Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "owned-file" }>
  > = {},
): Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "owned-file" }> {
  return payload({
    schema_version: "1.0",
    payload_kind: "owned-file",
    ownership_key: "vf:project:codex:global:skill:acme.coverage:file",
    expected_preimage_sha256: null,
    expected_postimage_sha256: null,
    preimage_owner_binding: null,
    root: "project",
    canonical_relative_path: "target.txt",
    marker_relative_path: ".vf/marker.json",
    file_mode: 0o644,
    preimage_base64: null,
    postimage_base64: null,
    preimage_marker_base64: null,
    postimage_marker_base64: null,
    ...overrides,
  }) as Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "owned-file" }>;
}

function jsonSlice(
  overrides: Partial<
    Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "json-key-slice" }>
  > = {},
): Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "json-key-slice" }> {
  return payload({
    schema_version: "1.0",
    payload_kind: "json-key-slice",
    ownership_key: "vf:project:claude:global:mcp:acme.coverage:json",
    expected_preimage_sha256: null,
    expected_postimage_sha256: null,
    preimage_owner_binding: null,
    root: "project",
    canonical_relative_path: "config.json",
    marker_relative_path: ".vf/json-marker.json",
    key_path: ["tools", "owned"],
    preimage: null,
    preimage_present: false,
    postimage: null,
    postimage_present: false,
    preimage_marker: null,
    postimage_marker: null,
    auxiliary_files: [],
    ...overrides,
  }) as Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "json-key-slice" }>;
}

function hookSlice(
  overrides: Partial<
    Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "hook-config-slice" }>
  > = {},
): Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "hook-config-slice" }> {
  return payload({
    schema_version: "1.0",
    payload_kind: "hook-config-slice",
    ownership_key: "vf:user:codex:global:hook:acme.coverage:hook",
    expected_preimage_sha256: null,
    expected_postimage_sha256: null,
    preimage_owner_binding: null,
    root: "user",
    canonical_relative_path: ".codex/hooks.json",
    marker_relative_path: ".vf/hook-marker.json",
    key_path: ["hooks", "PreToolUse"],
    preimage: null,
    preimage_present: false,
    postimage: null,
    postimage_present: false,
    preimage_marker: null,
    postimage_marker: null,
    codex_feature: null,
    ...overrides,
  }) as Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "hook-config-slice" }>;
}

function tomlBlock(
  overrides: Partial<
    Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "toml-owned-block" }>
  > = {},
): Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "toml-owned-block" }> {
  return payload({
    schema_version: "1.0",
    payload_kind: "toml-owned-block",
    ownership_key: "vf:project:codex:global:mcp:acme.coverage:toml",
    expected_preimage_sha256: null,
    expected_postimage_sha256: null,
    preimage_owner_binding: null,
    root: "project",
    canonical_relative_path: ".codex/config.toml",
    marker_relative_path: ".vf/toml-marker.json",
    block_id: "coverage-block",
    preimage_block: null,
    postimage_block: null,
    preimage_marker: null,
    postimage_marker: null,
    ...overrides,
  }) as Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "toml-owned-block" }>;
}

function memoryPayload(): CapabilityPrivateEffectPayloadV1 {
  return payload({
    schema_version: "1.0",
    payload_kind: "memory-test-only",
    ownership_key: "legacy:memory:test",
    expected_preimage_sha256: null,
    expected_postimage_sha256: null,
  });
}

function legacyPayload(
  projection:
    | { kind: "file"; canonical_relative_path: string; preimage_base64: string }
    | {
        kind: "json-key-slice";
        canonical_relative_path: string;
        key_path: string[];
        preimage: import("../../src/capabilities/adapters/types.js").CapabilityPrivateJsonV1;
      },
  overrides: Partial<
    Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "legacy-claim" }>
  > = {},
): Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "legacy-claim" }> {
  return payload({
    schema_version: "1.0",
    payload_kind: "legacy-claim",
    ownership_key: "legacy:coverage:claim",
    expected_preimage_sha256: null,
    expected_postimage_sha256: null,
    preimage_owner_binding: null,
    root: "project",
    legacy_source: "tool-managed-evidence",
    inspection_evidence_digest: runtimeDigest("inspection"),
    evidence_record_digest: runtimeDigest("record"),
    projection,
    ...overrides,
  }) as Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "legacy-claim" }>;
}

function binding(): CapabilityPrivateEffectBindingV1 {
  const locator = {
    kind: "capability" as const,
    scope: "project" as const,
    scope_identity_digest: runtimeDigest("coverage-scope"),
  };
  const descriptorDigest = runtimeDigest("coverage-descriptor");
  return {
    schema_version: "1.0",
    descriptor_schema_id: "vf.adapter-owned-projection/1",
    action_root_locator: locator,
    action_root_binding_digest: digestV1("VF-CAPABILITY-PRIVATE-ACTION-ROOT\0v1\0", locator),
    descriptor_digest: descriptorDigest,
    private_descriptor_ref: `actions/v1/objects/${descriptorDigest.slice("sha256:".length)}.json`,
  };
}

function descriptor(
  privatePayload: CapabilityPrivateEffectPayloadV1 = memoryPayload(),
  adapterId = "vf.skill.codex",
): CapabilityAdapterPrivateDescriptorV1 {
  return privateEffectDescriptor("intent", {
    operation: "ensure",
    adapter: {
      adapter_id: adapterId,
      adapter_version: "1.0.0",
      fingerprint: runtimeDigest("adapter"),
    },
    package_pin_digest: runtimeDigest("package-pin"),
    component_id: "main",
    target_id: "target",
    resource: resource(privatePayload.ownership_key),
    projection_digest: runtimeDigest("projection"),
    private_payload: privatePayload,
  });
}

function effectRequest(
  component: CapabilityComponentV1,
  engine: CapabilityEffectPreparationRequestV1["target"]["engine"],
  scope: "project" | "user" = "project",
): CapabilityEffectPreparationRequestV1 {
  const pkg = resolvedRolePackage();
  return {
    schema_version: "1.0",
    request: {} as CapabilityEffectPreparationRequestV1["request"],
    package: {
      ...pkg,
      manifest: { ...pkg.manifest, components: [component] },
      files: new Map(pkg.files),
    },
    component,
    target: {
      target_id: `target-${engine}`,
      scope,
      engine,
      participant_id: null,
    },
    operation: "ensure",
  };
}

function authorityFixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-cap-source-authority-"));
  roots.push(root);
  const paths = projectCapabilityPaths(root);
  mkdirSync(join(root, ".vibeflow"), { recursive: true, mode: 0o700 });
  const settings = { schema_version: "1.0", authority: { registry: "deny" } };
  writeAbsolute(join(root, ".vibeflow", "SETTINGS.json"), canonical(settings));
  const identityDraft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    identity_id: `vf-project-${"7".repeat(64)}`,
    created_at: "2026-01-01T00:00:00.000Z",
    content_digest: "",
  };
  const identity: AuthorityScopeIdentityRecordV1 = {
    ...identityDraft,
    content_digest: authorityScopeIdentityDigest(identityDraft),
  };
  writeAbsolute(paths.identity, canonical(identity));
  const policyDigest = digestV1("VF-POLICY-STATE\0v1\0", {
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: identity.content_digest,
    settings_schema_version: settings.schema_version,
    authority_subtree: settings.authority,
  });
  const headDraft = {
    schema_version: "1.0" as const,
    scope: "project" as const,
    scope_identity_digest: identity.content_digest,
    authority_epoch: 0,
    event_head_digest: null,
    grant_head_digest: null,
    grant_digest: grantStateDigest("project", identity.content_digest, null, new Map()),
    policy_head_digest: null,
    policy_digest: policyDigest,
    secret_revocation_digest: secretRevocationStateDigest("project", identity.content_digest, null),
    trust_head_digest: null,
    trust_epoch: 0,
    updated_by_operation_id: null,
    updated_at: identity.created_at,
    content_digest: "",
  };
  const head: AuthorityEpochHeadV1 = {
    ...headDraft,
    content_digest: authorityEpochHeadDigest(headDraft),
  };
  writeAbsolute(
    join(
      paths.privateRoot,
      "recovery",
      "v1",
      "checkpoints",
      `${head.content_digest.slice(7)}.json`,
    ),
    canonical(head),
  );
  writeAbsolute(join(paths.privateRoot, "authority", "v1", "epoch-head.json"), canonical(head));
  const reader = createDurableActionAuthorityReaderV1(new ActionAuthorityStore(paths.privateRoot));
  const resolver = createDurableAuthorityTransitionResolver({ resolve: () => reader });
  return { head, identity, paths, resolver, root, settings };
}

function signedRegistryVerification(input: {
  contentSha256: string;
  packageId?: string;
  version?: string;
  mode?: "resolution" | "locked";
  state?: "active" | "deprecated" | "revoked";
}): {
  envelope: RegistrySignatureEnvelopeV1;
  snapshot: ReturnType<typeof durableRegistryTrustFixture>;
  verification: VerifiedRegistryEnvelopeV1;
} {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" });
  const keyId = `sha256:${createHash("sha256").update(publicKey).digest("hex")}`;
  const statement: RegistryPackageStatementV1 = {
    schema_version: "1.0",
    registry_origin: "https://registry.example",
    package_id: input.packageId ?? "acme.registry-package",
    version: input.version ?? "1.0.0",
    content_sha256: input.contentSha256,
    provenance: {
      source_url: "https://github.com/acme/registry-package",
      commit_oid: "a".repeat(40),
    },
    publisher_id: "acme",
    issued_at: "2026-01-01T00:00:00.000Z",
    expires_at: "2027-01-01T00:00:00.000Z",
  };
  const envelope: RegistrySignatureEnvelopeV1 = {
    schema_version: "1.0",
    statement,
    signature: {
      algorithm: "Ed25519",
      key_id: keyId,
      value_base64url: sign(
        null,
        registryStatementSigningBytes(statement),
        pair.privateKey,
      ).toString("base64url"),
    },
  };
  const snapshot = durableRegistryTrustFixture({
    public_key_spki: publicKey,
    state: input.state ?? "active",
  });
  return {
    envelope,
    snapshot,
    verification: verifyRegistryEnvelope(envelope, {
      trust_snapshot: snapshot,
      at: "2026-08-26T00:00:00.000Z",
      mode: input.mode ?? "resolution",
    }),
  };
}

function materializeLegacyEvidence(
  marker: ReturnType<FilesystemLegacyMarkerReaderV1["scan"]>[number],
  overrides: Partial<LegacyInspectionEvidenceV1> = {},
): LegacyInspectionEvidenceV1 {
  const proof = marker.ownership_proof;
  if (!proof) throw new Error("legacy marker proof is absent");
  const recordDraft = {
    record_kind: "sentinel",
    logical_id: proof.logical_id,
    content_sha256: proof.content_sha256,
  };
  const draft = {
    schema_version: "1.0" as const,
    legacy_source: marker.source,
    raw_identifier_nfc: marker.raw_identifier.normalize("NFC"),
    adapter_fingerprint: digestV1("VF-LEGACY-ADAPTER-FINGERPRINT\0v1\0", marker.source),
    source_records: [
      {
        ...recordDraft,
        record_digest: digestV1("VF-LEGACY-INSPECTION-SOURCE-RECORD\0v1\0", recordDraft),
      },
    ],
    owned_resources: marker.owned_resources.map(
      ({ ownership_key, public_target, expected_preimage_sha256 }) => ({
        ownership_key,
        public_target,
        expected_preimage_sha256,
      }),
    ),
    ...overrides,
  };
  return {
    ...draft,
    evidence_digest: digestV1("VF-LEGACY-INSPECTION-EVIDENCE\0v1\0", draft),
  } as LegacyInspectionEvidenceV1;
}

function legacyClosureFixture() {
  const fsRoots = fixtureRoots();
  write(
    fsRoots.project,
    ".opencode/plugins/vf-guard.ts",
    "// # vibeflow-guardrail\nexport default {};\n",
  );
  const reader = new FilesystemLegacyMarkerReaderV1(fsRoots);
  const marker = reader.scan({
    schema_version: "1.0",
    scope: "project",
    scope_identity_digest: runtimeDigest("legacy-scope"),
    sources: ["hook-sentinel"],
  })[0];
  if (!marker) throw new Error("legacy hook marker was not discovered");
  const evidence = issueLegacyInspectionEvidence(marker, materializeLegacyEvidence(marker));
  const base = roleManifest();
  const manifest = structuredClone(base.manifest);
  manifest.id = "legacy.hook.vf-guardrail";
  manifest.permissions = [];
  const withoutVersion = (() => {
    const { version: _, ...rest } = manifest;
    return rest;
  })();
  manifest.version = `0.0.0-legacy.${digestV1("VF-LEGACY-ADOPT-VERSION\0v1\0", {
    legacy_source: evidence.legacy_source,
    synthetic_manifest_without_version: withoutVersion,
    owned_resources: evidence.owned_resources,
    inspection_evidence_digest: evidence.evidence_digest,
  }).slice(7, 19)}`;
  const evidenceBytes = canonical({
    schema_version: "1.0",
    legacy_source: evidence.legacy_source,
    owned_resources: evidence.owned_resources,
    inspection_evidence_digest: evidence.evidence_digest,
  });
  const manifestBytes = canonical(manifest);
  const files = new Map(base.files);
  files.set("capability.json", manifestBytes);
  files.set("legacy-adopt-evidence.json", evidenceBytes);
  const tree = computePackageTree([...files].map(([path, bytes]) => ({ path, bytes })));
  const parsed = parseCapabilityManifest(manifestBytes, tree.files);
  return { evidence, manifest: parsed, marker, tree };
}

describe("post-freeze source and adapter behavioral coverage", () => {
  test("SemVer ordering and ranges cover prerelease and all comparator outcomes", () => {
    expect(() => parseSemver("1.0.0-01")).toThrow(/leading zeros/);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBeLessThan(0);
    expect(compareSemver("1.0.0-beta", "1.0.0-alpha")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.1")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(() => validateVersionRange(">=1.0.0")).toThrow(/outside/);
    expect(versionSatisfiesRange("1.2.3-beta", "*")).toBe(false);
    expect(versionSatisfiesRange("1.2.3-beta", ">=1.2.3-beta <2.0.0")).toBe(true);
    expect(versionSatisfiesRange("1.2.3-beta", ">=1.2.3 <2.0.0")).toBe(false);
    expect(versionSatisfiesRange("1.0.0", ">1.0.0 <2.0.0")).toBe(false);
    expect(versionSatisfiesRange("1.0.0", ">=1.0.0 <=1.0.0")).toBe(true);
    expect(versionSatisfiesRange("1.0.0", "=1.0.0 <2.0.0")).toBe(true);
    expect(versionSatisfiesRange("0.0.3", "^0.0.2")).toBe(false);
    expect(versionSatisfiesRange("0.2.9", "^0.2.1")).toBe(true);
    expect(versionSatisfiesRange("2.0.0", "~1.9.0")).toBe(false);
  });

  test("package tree validators reject every bounded identity drift", () => {
    expect(() => computePackageTree([])).toThrow(/entry count/);
    expect(() =>
      computePackageTree([{ path: `${"x/".repeat(64)}file`, bytes: Buffer.from("x") }]),
    ).toThrow(/nesting/);
    expect(() =>
      computePackageTree([{ path: "huge", bytes: Buffer.alloc(16 * 1024 * 1024 + 1) }]),
    ).toThrow(/byte limit/);
    expect(() =>
      computePackageTree([
        { path: "parent", bytes: Buffer.from("a") },
        { path: "parent/child", bytes: Buffer.from("b") },
      ]),
    ).toThrow(/ancestor/);

    const tree = computePackageTree([{ path: "one", bytes: Buffer.from("1") }]);
    tree.entry_count = 2;
    expect(() => assertValidatedPackageTree(tree)).toThrow(/mutated/);
    tree.entry_count = 1;
    const mutableFiles = tree.files as Map<string, Uint8Array>;
    mutableFiles.clear();
    expect(() => assertValidatedPackageTree(tree)).toThrow(/incomplete/);
    mutableFiles.set("one", Buffer.from("wrong"));
    expect(() => assertValidatedPackageTree(tree)).toThrow(/differs/);

    const materialized = computePackageTree([{ path: "one", bytes: Buffer.from("1") }]);
    const materializeRoot = mkdtempSync(join(tmpdir(), "vf-cap-tree-materialize-"));
    roots.push(materializeRoot);
    const processLock = acquireProcessLock(join(materializeRoot, "writer.lock"), {
      operation: "tree-materialization-coverage",
    });
    try {
      expect(() =>
        materializePackageTree(
          join(materializeRoot, "cache", "bad-digest"),
          { ...materialized, content_sha256: "b".repeat(64) },
          processLock,
        ),
      ).toThrow(/tree digest mismatch/);
      const destination = join(materializeRoot, "cache", "package");
      writeAbsolute(
        join(materializeRoot, "cache", `.package.${materialized.content_sha256}.materializing`),
        "not-a-directory",
      );
      expect(() => materializePackageTree(destination, materialized, processLock)).toThrow(
        /staging path is not a real directory/,
      );
    } finally {
      processLock.release();
    }
  });

  test("resolution compatibility reports invalid platform, engine set and incompatibility", () => {
    const pkg = resolvedRolePackage();
    const bytes = canonicalJsonBytes(pkg.manifest);
    const tree = computePackageTree([
      { path: "capability.json", bytes },
      { path: "roles/reviewer.md", bytes: pkg.files.get("roles/reviewer.md") as Uint8Array },
    ]);
    const parsed = parseCapabilityManifest(bytes, tree.files);
    const context = {
      vf_version: "0.15.0",
      engines: [{ engine: "codex" as const, version: "1.5.0" }],
      platform: { os: "linux" as const, arch: "x64" as const, libc: "glibc" as const },
    };
    expect(() => createResolutionCompatibilityRecord(parsed, { ...context, engines: [] })).toThrow(
      /engine set/,
    );
    expect(() =>
      createResolutionCompatibilityRecord(parsed, {
        ...context,
        platform: { ...context.platform, libc: "other" as "glibc" },
      }),
    ).toThrow(/Linux libc/);
    expect(() =>
      createResolutionCompatibilityRecord(parsed, {
        ...context,
        platform: { os: "darwin", arch: "x64", libc: "glibc" },
      }),
    ).toThrow(/only legal/);
    expect(() =>
      createResolutionCompatibilityRecord(parsed, { ...context, vf_version: "1.0.0" }),
    ).toThrow(/VF version/);

    const incompatibleManifest = structuredClone(pkg.manifest) as CapabilityManifestV1;
    incompatibleManifest.compatibility.platforms = [{ os: "darwin", arch: "arm64", libc: null }];
    const incompatibleBytes = canonicalJsonBytes(incompatibleManifest);
    const incompatibleTree = computePackageTree([
      { path: "capability.json", bytes: incompatibleBytes },
      { path: "roles/reviewer.md", bytes: pkg.files.get("roles/reviewer.md") as Uint8Array },
    ]);
    const incompatible = parseCapabilityManifest(incompatibleBytes, incompatibleTree.files);
    expect(() => createResolutionCompatibilityRecord(incompatible, context)).toThrow(/platform/);

    const compatibility = createResolutionCompatibilityRecord(parsed, context);
    const pin = createPackagePin({
      id: parsed.manifest.id,
      version: parsed.manifest.version,
      source: { kind: "local-dev", repo_relative_alias: ".vibeflow/packages/reviewer" },
      content_sha256: tree.content_sha256,
    });
    const candidate = createResolutionCandidate({
      pin,
      manifest_record: parsed,
      package_tree: tree,
      compatibility,
    });
    expect(assertValidatedResolutionCandidate(candidate)).toBe(candidate);
    expect(() =>
      createResolutionCandidate({
        pin,
        manifest_record: parsed,
        package_tree: tree,
        compatibility: { ...compatibility } as typeof compatibility,
      }),
    ).toThrow(/validator-derived/);
    const foreignTree = computePackageTree([{ path: "capability.json", bytes: Buffer.from("{}") }]);
    expect(() =>
      createResolutionCandidate({
        pin,
        manifest_record: parsed,
        package_tree: foreignTree,
        compatibility,
      }),
    ).toThrow(/source bytes/);
    const wrongContentPin = createPackagePin({
      id: parsed.manifest.id,
      version: parsed.manifest.version,
      source: { kind: "local-dev", repo_relative_alias: ".vibeflow/packages/reviewer" },
      content_sha256: "a".repeat(64),
    });
    expect(() =>
      createResolutionCandidate({
        pin: wrongContentPin,
        manifest_record: parsed,
        package_tree: tree,
        compatibility,
      }),
    ).toThrow(/identities disagree/);
  });

  test("pin construction rejects authority-only sources and mutable pin drift", () => {
    expect(() =>
      createPackagePin({
        id: "acme.coverage",
        version: "1.0.0",
        source: {
          kind: "legacy-adopt",
          legacy_source: "role-marker",
          inspection_evidence_digest: runtimeDigest("evidence"),
        },
        content_sha256: "a".repeat(64),
      } as Parameters<typeof createPackagePin>[0]),
    ).toThrow(/legacy adoption/);
    const pin = createPackagePin({
      id: "acme.coverage",
      version: "1.0.0",
      source: { kind: "local-dev", repo_relative_alias: ".vibeflow/packages/coverage" },
      content_sha256: "a".repeat(64),
    });
    pin.id = "acme.changed";
    expect(() => validateImmutablePackagePin(pin)).toThrow(/digest/);
    const good = createPackagePin({
      id: "acme.coverage",
      version: "1.0.0",
      source: { kind: "local-dev", repo_relative_alias: ".vibeflow/packages/coverage" },
      content_sha256: "a".repeat(64),
    });
    expect(() => createAuthenticityBinding(good, runtimeDigest("manifest"), {} as never)).toThrow(
      /nullability/,
    );
  });

  test("package cache writer rejects identity, envelope, authenticity and legacy-evidence drift", () => {
    const pkg = resolvedRolePackage();
    const tree = computePackageTree([...pkg.files].map(([path, bytes]) => ({ path, bytes })));
    const manifest = parseCapabilityManifest(
      tree.files.get("capability.json") as Uint8Array,
      tree.files,
    );
    const options = {
      private_root: "/unused-before-write",
      scope: "project" as const,
      scope_identity_digest: runtimeDigest("cache-scope"),
      lock: null as never,
    };
    const publication = {
      pin: pkg.pin,
      tree,
      manifest,
      authenticity: pkg.authenticity_binding,
      registry_envelope: null,
      legacy_inspection_evidence: null,
    };
    const wrongPin = createPackagePin({
      id: pkg.pin.id,
      version: pkg.pin.version,
      source: { kind: "local-dev", repo_relative_alias: ".vibeflow/packages/wrong" },
      content_sha256: "0".repeat(64),
    });
    expect(() => retainCapabilityPackageCache({ ...publication, pin: wrongPin }, options)).toThrow(
      /identities disagree/,
    );
    expect(() =>
      retainCapabilityPackageCache(
        { ...publication, registry_envelope: {} as RegistrySignatureEnvelopeV1 },
        options,
      ),
    ).toThrow(/non-registry.*registry envelope/);
    expect(() =>
      retainCapabilityPackageCache(
        {
          ...publication,
          authenticity: {
            ...pkg.authenticity_binding,
            authenticity_digest: runtimeDigest("wrong-authenticity"),
          },
        },
        options,
      ),
    ).toThrow(/authenticity is not derived/);
    expect(() =>
      retainCapabilityPackageCache(
        { ...publication, legacy_inspection_evidence: {} as never },
        options,
      ),
    ).toThrow(/non-legacy.*legacy inspection evidence/);
  });

  test("signed registry pins retain exact package cache authority and reject mode drift", () => {
    const pkg = resolvedRolePackage();
    const tree = computePackageTree([...pkg.files].map(([path, bytes]) => ({ path, bytes })));
    const manifest = parseCapabilityManifest(
      tree.files.get("capability.json") as Uint8Array,
      tree.files,
    );
    const signed = signedRegistryVerification({
      contentSha256: tree.content_sha256,
      packageId: manifest.manifest.id,
      version: manifest.manifest.version,
    });
    const pin = createVerifiedRegistryPackagePin(signed.verification);
    expect(assertVerifiedRegistryPackagePin(pin)).toBe(signed.verification);
    const compatibility = createResolutionCompatibilityRecord(manifest, {
      vf_version: "0.15.0",
      engines: [{ engine: "codex", version: "1.5.0" }],
      platform: { os: "linux", arch: "x64", libc: "glibc" },
    });
    expect(
      assertValidatedResolutionCandidate(
        createResolutionCandidate({
          pin,
          manifest_record: manifest,
          package_tree: tree,
          compatibility,
        }),
      ).source_identity,
    ).toBe("registry:https://registry.example");
    const authenticity = createAuthenticityBinding(
      pin,
      manifest.manifest_digest,
      signed.verification,
    );
    const wrongEnvelope = structuredClone(signed.envelope);
    wrongEnvelope.signature.value_base64url = Buffer.from("wrong-signature").toString("base64url");
    expect(() =>
      retainCapabilityPackageCache(
        {
          pin,
          tree,
          manifest,
          authenticity,
          registry_envelope: wrongEnvelope,
          legacy_inspection_evidence: null,
        },
        {
          private_root: "/unused-before-write",
          scope: "project",
          scope_identity_digest: runtimeDigest("cache-owner"),
          lock: null as never,
        },
      ),
    ).toThrow(/exact verified envelope/);
    const cacheRoot = mkdtempSync(join(tmpdir(), "vf-cap-registry-cache-"));
    roots.push(cacheRoot);
    const privateRoot = join(cacheRoot, "private");
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const lock = acquireProcessLock(join(privateRoot, "writer.lock"), {
      operation: "registry-cache-coverage",
    });
    try {
      const record = retainCapabilityPackageCache(
        {
          pin,
          tree,
          manifest,
          authenticity,
          registry_envelope: signed.envelope,
          legacy_inspection_evidence: null,
        },
        {
          private_root: privateRoot,
          scope: "project",
          scope_identity_digest: runtimeDigest("cache-owner"),
          lock,
        },
      );
      expect(record.registry_envelope_digest).toBe(signed.verification.envelope_digest);
    } finally {
      lock.release();
    }

    const locked = verifyRegistryEnvelope(signed.envelope, {
      trust_snapshot: signed.snapshot,
      at: "2026-08-26T00:00:00.000Z",
      mode: "locked",
    });
    expect(() => createVerifiedRegistryPackagePin(locked)).toThrow(/current resolution/);
    expect(revalidateCachedRegistryPackagePin(pin, locked).pin_digest).toBe(pin.pin_digest);
    const local = createPackagePin({
      id: manifest.manifest.id,
      version: manifest.manifest.version,
      source: { kind: "local-dev", repo_relative_alias: ".vibeflow/packages/local" },
      content_sha256: tree.content_sha256,
    });
    expect(() => revalidateCachedRegistryPackagePin(local, locked)).toThrow(/does not equal/);
    expect(() => assertVerifiedRegistryPackagePin(local as PackagePinV1)).toThrow(/not derived/);
    expect(() => assertVerifiedLegacyAdoptPackagePin(local)).toThrow(/not derived/);

    const second = signedRegistryVerification({
      contentSha256: tree.content_sha256,
      packageId: manifest.manifest.id,
      version: manifest.manifest.version,
    });
    expect(() =>
      createAuthenticityBinding(pin, manifest.manifest_digest, second.verification),
    ).toThrow(/does not bind/);
    const revoked = signedRegistryVerification({
      contentSha256: tree.content_sha256,
      packageId: manifest.manifest.id,
      version: manifest.manifest.version,
      mode: "locked",
      state: "revoked",
    });
    expect(revoked.verification.status).toBe("blocked");
    expect(() =>
      createAuthenticityBinding(pin, manifest.manifest_digest, revoked.verification),
    ).toThrow(/only a current verified/);
  });

  test("legacy inspection evidence validates canonical identifiers, records and resources", () => {
    const fx = legacyClosureFixture();
    expect(validateLegacyInspectionEvidence(fx.evidence).evidence_digest).toBe(
      fx.evidence.evidence_digest,
    );
    expect(() =>
      validateLegacyInspectionEvidence(
        materializeLegacyEvidence(fx.marker, { raw_identifier_nfc: "e\u0301" }),
      ),
    ).toThrow(/NFC/);
    expect(() =>
      validateLegacyInspectionEvidence(
        materializeLegacyEvidence(fx.marker, {
          adapter_fingerprint: runtimeDigest("wrong-adapter"),
        }),
      ),
    ).toThrow(/adapter fingerprint/);
    const firstRecord = fx.evidence.source_records[0];
    if (!firstRecord) throw new Error("legacy source record missing");
    const badKind = structuredClone(fx.evidence);
    badKind.source_records[0] = { ...firstRecord, record_kind: "unknown" as never };
    expect(() => validateLegacyInspectionEvidence(badKind)).toThrow(/source record kind/);
    const badRecordDigest = structuredClone(fx.evidence);
    badRecordDigest.source_records[0] = {
      ...firstRecord,
      record_digest: runtimeDigest("wrong-record"),
    };
    expect(() => validateLegacyInspectionEvidence(badRecordDigest)).toThrow(/record digest/);
    const badEvidenceDigest = structuredClone(fx.evidence);
    badEvidenceDigest.evidence_digest = runtimeDigest("wrong-evidence");
    expect(() => validateLegacyInspectionEvidence(badEvidenceDigest)).toThrow(/evidence digest/);

    const proof = fx.marker.ownership_proof;
    if (!proof) throw new Error("legacy proof missing");
    const extraRecordDraft = {
      record_kind: "sentinel",
      logical_id: `${proof.logical_id}-z`,
      content_sha256: proof.content_sha256,
    };
    const extraResource = {
      ownership_key: `${fx.evidence.owned_resources[0]?.ownership_key}-z`,
      public_target: `${fx.evidence.owned_resources[0]?.public_target}-z`,
      expected_preimage_sha256: proof.content_sha256,
    };
    const multiDraft = {
      ...fx.evidence,
      source_records: [
        ...fx.evidence.source_records,
        {
          ...extraRecordDraft,
          record_digest: digestV1("VF-LEGACY-INSPECTION-SOURCE-RECORD\0v1\0", extraRecordDraft),
        },
      ],
      owned_resources: [...fx.evidence.owned_resources, extraResource],
      evidence_digest: "",
    };
    const { evidence_digest: _, ...multiPreimage } = multiDraft;
    const multi = {
      ...multiPreimage,
      evidence_digest: digestV1("VF-LEGACY-INSPECTION-EVIDENCE\0v1\0", multiPreimage),
    } as LegacyInspectionEvidenceV1;
    expect(validateLegacyInspectionEvidence(multi).source_records).toHaveLength(2);
    expect(() =>
      issueLegacyInspectionEvidence(
        fx.marker,
        materializeLegacyEvidence(fx.marker, { source_records: [] }),
      ),
    ).toThrow(/differs from concrete observed ownership bytes/);
  });

  test("legacy synthetic closure issues, pins, revalidates and retains exact cache evidence", () => {
    const fx = legacyClosureFixture();
    const closure = validateLegacyAdoptClosure(
      { manifest: fx.manifest, tree: fx.tree, evidence: fx.evidence },
      { requireIssuedEvidence: true },
    );
    expect(closure.tree.content_sha256).toBe(fx.tree.content_sha256);
    const unissued = structuredClone(fx.evidence);
    expect(() =>
      validateLegacyAdoptClosure(
        { manifest: fx.manifest, tree: fx.tree, evidence: unissued },
        { requireIssuedEvidence: true },
      ),
    ).toThrow(/not issued/);

    const withoutEvidenceTree = computePackageTree(
      fx.tree.entries.filter((entry) => entry.path !== "legacy-adopt-evidence.json"),
    );
    const withoutEvidenceManifest = parseCapabilityManifest(
      withoutEvidenceTree.files.get("capability.json") as Uint8Array,
      withoutEvidenceTree.files,
    );
    expect(() =>
      validateLegacyAdoptClosure(
        { manifest: withoutEvidenceManifest, tree: withoutEvidenceTree, evidence: fx.evidence },
        { requireIssuedEvidence: false },
      ),
    ).toThrow(/exact manifest\/evidence closure/);

    const wrongVersionValue = structuredClone(fx.manifest.manifest);
    wrongVersionValue.version = "0.0.0-legacy.aaaaaaaaaaaa";
    const wrongVersionTree = computePackageTree(
      fx.tree.entries.map((entry) =>
        entry.path === "capability.json"
          ? { path: entry.path, bytes: canonical(wrongVersionValue) }
          : entry,
      ),
    );
    const wrongVersionManifest = parseCapabilityManifest(
      wrongVersionTree.files.get("capability.json") as Uint8Array,
      wrongVersionTree.files,
    );
    expect(() =>
      validateLegacyAdoptClosure(
        { manifest: wrongVersionManifest, tree: wrongVersionTree, evidence: fx.evidence },
        { requireIssuedEvidence: false },
      ),
    ).toThrow(/version does not bind/);

    const pin = createLegacyAdoptPackagePin({
      manifest: fx.manifest,
      tree: fx.tree,
      evidence: fx.evidence,
    });
    expect(assertVerifiedLegacyAdoptPackagePin(pin).mode).toBe("inspector-issued");
    const authenticity = createAuthenticityBinding(pin, fx.manifest.manifest_digest, null);
    expect(() => createAuthenticityBinding(pin, runtimeDigest("wrong-manifest"), null)).toThrow(
      /legacy authenticity manifest differs/,
    );
    const cachedPin = structuredClone(pin);
    expect(
      revalidateCachedLegacyAdoptPackagePin(cachedPin, {
        manifest: fx.manifest,
        tree: fx.tree,
        evidence: fx.evidence,
      }).pin_digest,
    ).toBe(pin.pin_digest);
    const wrongSourceDraft = {
      ...pin,
      source: { ...pin.source, inspection_evidence_digest: runtimeDigest("wrong-inspection") },
      pin_digest: "",
    } as PackagePinV1;
    const { pin_digest: _pinDigest, ...wrongPreimage } = wrongSourceDraft;
    const wrongPin = {
      ...wrongPreimage,
      pin_digest: digestV1("VF-PACKAGE-PIN\0v1\0", wrongPreimage),
    } as PackagePinV1;
    expect(() =>
      revalidateCachedLegacyAdoptPackagePin(wrongPin, {
        manifest: fx.manifest,
        tree: fx.tree,
        evidence: fx.evidence,
      }),
    ).toThrow(/does not equal/);

    const cacheRoot = mkdtempSync(join(tmpdir(), "vf-cap-legacy-cache-"));
    roots.push(cacheRoot);
    const privateRoot = join(cacheRoot, "private");
    mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
    const legacyCacheOwner = runtimeDigest("legacy-cache-owner");
    const lock = acquireProcessLock(join(privateRoot, "writer.lock"), {
      operation: "legacy-cache-coverage",
    });
    let retainedRecord: CapabilityPackageCacheRecordV1;
    try {
      retainedRecord = retainCapabilityPackageCache(
        {
          pin,
          tree: fx.tree,
          manifest: fx.manifest,
          authenticity,
          registry_envelope: null,
          legacy_inspection_evidence: fx.evidence,
        },
        {
          private_root: privateRoot,
          scope: "project",
          scope_identity_digest: legacyCacheOwner,
          lock,
        },
      );
      expect(retainedRecord.legacy_inspection_evidence_digest).toBe(fx.evidence.evidence_digest);
    } finally {
      lock.release();
    }
    const retainedEntry = cacheLockEntry({
      pin,
      manifestDigest: fx.manifest.manifest_digest,
      authenticity,
    });
    const retainedInput = {
      private_root: privateRoot,
      identity_path: join(cacheRoot, "unused-identity.json"),
      scope: "project" as const,
      scope_identity_digest: legacyCacheOwner,
      at: "2026-08-26T00:00:00.000Z",
    };
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([cacheLock(retainedEntry)], retainedInput),
    ).not.toThrow();
    writeAbsolute(
      legacyInspectionEvidenceCachePath(privateRoot, fx.evidence.evidence_digest),
      canonical({ ...fx.evidence, evidence_digest: runtimeDigest("wrong-retained-evidence") }),
    );
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([cacheLock(retainedEntry)], retainedInput),
    ).toThrow(/legacy inspection evidence digest mismatch/);
    expect(() =>
      retainCapabilityPackageCache(
        {
          pin,
          tree: fx.tree,
          manifest: fx.manifest,
          authenticity,
          registry_envelope: null,
          legacy_inspection_evidence: null,
        },
        {
          private_root: "/unused-before-write",
          scope: "project",
          scope_identity_digest: runtimeDigest("legacy-cache-owner"),
          lock: null as never,
        },
      ),
    ).toThrow(/lacks validated inspection evidence/);
  });

  test("filesystem removal captures exact state for every production payload kind", () => {
    const fsRoots = fixtureRoots();
    const marker = { schema_version: "1.0", ownership_key: "vf:marker" };
    write(fsRoots.project, "target.txt", "prior-file");
    write(fsRoots.project, ".vf/marker.json", canonical(marker));
    const fileBuilt = buildFilesystemRemoval(resource(), ownedFile(), fsRoots);
    expect(fileBuilt.private_payload.payload_kind).toBe("owned-file");
    expect(fileBuilt.private_preimage_bytes).not.toBeNull();
    expect(fileBuilt.resource.expected_postimage_sha256).toBeNull();

    write(fsRoots.project, "config.json", canonical({ tools: { owned: { enabled: true } } }));
    write(fsRoots.project, ".vf/json-marker.json", canonical(marker));
    write(fsRoots.project, "bin/tool", "binary");
    const jsonBuilt = buildFilesystemRemoval(
      resource("vf:json"),
      jsonSlice({
        auxiliary_files: [
          {
            canonical_relative_path: "bin/tool",
            file_mode: 0o755,
            preimage_base64: null,
            postimage_base64: Buffer.from("binary").toString("base64"),
          },
        ],
      }),
      fsRoots,
    );
    expect(jsonBuilt.private_payload.payload_kind).toBe("json-key-slice");
    expect(
      (
        jsonBuilt.private_payload as Extract<
          CapabilityPrivateEffectPayloadV1,
          { payload_kind: "json-key-slice" }
        >
      ).preimage_present,
    ).toBe(true);

    const feature =
      "# vf-capability:codex-hooks-feature:start\ncodex_hooks = true\n# vf-capability:codex-hooks-feature:end";
    write(
      fsRoots.user,
      ".codex/hooks.json",
      canonical({ hooks: { PreToolUse: [{ command: "vf" }] } }),
    );
    write(fsRoots.user, ".vf/hook-marker.json", canonical(marker));
    write(fsRoots.user, ".codex/config.toml", `[features]\n${feature}\n`);
    const hookBuilt = buildFilesystemRemoval(
      resource("vf:hook"),
      hookSlice({
        codex_feature: {
          canonical_relative_path: ".codex/config.toml",
          block_id: "codex-hooks-feature",
          placement: "after-features-header",
          preimage_block: null,
          postimage_block: feature,
        },
      }),
      fsRoots,
    );
    expect(hookBuilt.private_payload.payload_kind).toBe("hook-config-slice");

    const block =
      "# vf-capability:coverage-block:start\nvalue = true\n# vf-capability:coverage-block:end";
    write(fsRoots.project, ".codex/config.toml", `${block}\n`);
    write(fsRoots.project, ".vf/toml-marker.json", canonical(marker));
    const tomlBuilt = buildFilesystemRemoval(resource("vf:toml"), tomlBlock(), fsRoots);
    expect(tomlBuilt.private_payload.payload_kind).toBe("toml-owned-block");
    expect(
      (
        tomlBuilt.private_payload as Extract<
          CapabilityPrivateEffectPayloadV1,
          { payload_kind: "toml-owned-block" }
        >
      ).preimage_block,
    ).toBe(block);

    expect(() => buildFilesystemRemoval(resource(), memoryPayload(), fsRoots)).toThrow(
      /cannot be removed/,
    );
  });

  test("filesystem broker publishes an owner, prepares removal and rolls back exact bytes", () => {
    const fsRoots = fixtureRoots();
    const projectState = join(fsRoots.project, ".vibeflow", "private", "capabilities");
    const userState = join(fsRoots.user, ".vibeflow", "capabilities");
    const broker = new FilesystemCapabilityEffectBrokerV1({
      projectRoot: fsRoots.project,
      userRoot: fsRoots.user,
      projectStateRoot: projectState,
      userStateRoot: userState,
      now: () => "2026-08-26T00:00:00.000Z",
    });
    const component = resolvedRolePackage().manifest.components[0] as CapabilityComponentV1;
    const request = effectRequest(component, "codex");
    const locator = {
      kind: "capability" as const,
      scope: "project" as const,
      scope_identity_digest: runtimeDigest("broker-scope"),
    };
    request.request = {
      scope: "project",
      scope_identity_digest: locator.scope_identity_digest,
      action_root_locator: locator,
    } as CapabilityEffectPreparationRequestV1["request"];
    const prepared = broker.prepare(request, "durable");
    const adapter = resolveCapabilityAdapter("role", "codex").adapter;
    if (!adapter) throw new Error("expected host role adapter");
    const privateDescriptor = privateEffectDescriptor("intent", {
      operation: "ensure",
      adapter,
      package_pin_digest: request.package.pin.pin_digest,
      component_id: component.component_id,
      target_id: request.target.target_id,
      resource: prepared.resource,
      projection_digest: runtimeDigest("broker-projection"),
      private_payload: prepared.private_payload,
    });
    const privateBinding = broker.retainPrivateDescriptor(privateDescriptor, "durable", locator);
    const effectDescriptor: CapabilityEffectDescriptorV1 = {
      schema_version: "1.0",
      descriptor_kind: "intent",
      descriptor_schema_id: "vf.adapter-owned-projection/1",
      operation: "ensure",
      adapter,
      package_pin_digest: request.package.pin.pin_digest,
      component_id: component.component_id,
      target_id: request.target.target_id,
      resource: prepared.resource,
      private_payload_binding: privateBinding,
      owner_binding: privateBinding,
      projection_digest: runtimeDigest("broker-projection"),
      descriptor_digest: privateDescriptor.descriptor_digest,
    };
    const applied = broker.apply(effectDescriptor, prepared.private_payload);
    expect(applied.state).toBe("present");
    expect(broker.payloads.ownerBinding(prepared.resource.ownership_key)).toEqual(privateBinding);
    expect(() => broker.prepareRemoval(prepared.resource)).toThrow(/action root is absent/);
    const removal = broker.prepareRemoval(prepared.resource, "transient", locator);
    expect(removal.private_payload.expected_postimage_sha256).toBeNull();
    const rolledBack = broker.rollback(effectDescriptor, prepared.private_payload);
    expect(rolledBack.state).toBe("absent");
    expect(() =>
      broker.prepareRemoval(
        resource("vf:project:codex:global:skill:missing:main"),
        "transient",
        locator,
      ),
    ).toThrow(/no private descriptor/);
  });

  test("private preimage authority persists, binds and hydrates each payload representation", () => {
    const markerBase64 = canonical({ owned: true }).toString("base64");
    const fileBytes = projectionStateBytes("cHJpb3I=", { owned: true }, [], true) as Buffer;
    const file = ownedFile({
      expected_preimage_sha256: sha256Digest(fileBytes).slice("sha256:".length),
      preimage_base64: "cHJpb3I=",
      preimage_marker_base64: markerBase64,
    });
    expect(
      Buffer.compare(
        Buffer.from(privateEffectPreimageBytes(file) as Uint8Array),
        Buffer.from(fileBytes),
      ),
    ).toBe(0);
    const persistedFile = persistedPrivateEffectPayload(file);
    assertPersistedPrivateEffectPayload(persistedFile);
    expect(hydratePrivateEffectPayload(persistedFile, fileBytes)).toEqual(file);

    const jsonBytes = projectionStateBytes(
      { before: true },
      { owned: true },
      ["YXV4"],
      true,
    ) as Buffer;
    const json = jsonSlice({
      expected_preimage_sha256: sha256Digest(jsonBytes).slice("sha256:".length),
      preimage: { before: true },
      preimage_present: true,
      preimage_marker: { owned: true },
      auxiliary_files: [
        {
          canonical_relative_path: "bin/tool",
          file_mode: 0o755,
          preimage_base64: "YXV4",
          postimage_base64: null,
        },
      ],
    });
    expect(hydratePrivateEffectPayload(persistedPrivateEffectPayload(json), jsonBytes)).toEqual(
      json,
    );

    const hookBytes = projectionStateBytes("before", null, ["old-block"], true) as Buffer;
    const hook = hookSlice({
      expected_preimage_sha256: sha256Digest(hookBytes).slice("sha256:".length),
      preimage: "before",
      preimage_present: true,
      codex_feature: {
        canonical_relative_path: ".codex/config.toml",
        block_id: "codex-hooks-feature",
        placement: "append",
        preimage_block: "old-block",
        postimage_block: null,
      },
    });
    expect(hydratePrivateEffectPayload(persistedPrivateEffectPayload(hook), hookBytes)).toEqual(
      hook,
    );

    const tomlBytes = projectionStateBytes("old", null, [], true) as Buffer;
    const toml = tomlBlock({
      expected_preimage_sha256: sha256Digest(tomlBytes).slice("sha256:".length),
      preimage_block: "old",
    });
    expect(hydratePrivateEffectPayload(persistedPrivateEffectPayload(toml), tomlBytes)).toEqual(
      toml,
    );

    const bound = bindResourcePreimage(
      { ...resource(), expected_preimage_sha256: sha256Digest(fileBytes).slice("sha256:".length) },
      fileBytes,
    );
    expect(bound.private_preimage_ref).toMatch(/^actions\/v1\/blobs\/[a-f0-9]{64}\.bin$/);
    expect(() =>
      bindResourcePreimage({ ...resource(), expected_preimage_sha256: "0".repeat(64) }, fileBytes),
    ).toThrow(/differs/);
    expect(() =>
      bindResourcePreimage({ ...resource(), expected_preimage_sha256: "0".repeat(64) }, null),
    ).toThrow(/lacks/);
    expect(bindResourcePreimage(resource(), null).private_preimage_ref).toBeNull();
  });

  test("private preimage hydration rejects corrupt, noncanonical and unbound records", () => {
    const expected = "0".repeat(64);
    const persisted = ownedFile({ expected_preimage_sha256: expected });
    expect(() => hydratePrivateEffectPayload(persisted, null)).toThrow(/absent/);
    expect(() => hydratePrivateEffectPayload(persisted, Buffer.from([0xff]))).toThrow(/corrupt/);
    expect(() =>
      hydratePrivateEffectPayload(persisted, Buffer.from('{"value":1, "schema_version":"1.0"}')),
    ).toThrow(/not canonical|not bound/);
    const invalidRecords = [
      { schema_version: "2.0", value_present: false, value: null, marker: null, auxiliary: [] },
      { schema_version: "1.0", value_present: false, value: "x", marker: null, auxiliary: [] },
      {
        schema_version: "1.0",
        value_present: false,
        value: null,
        marker: null,
        auxiliary: [],
        extra: true,
      },
    ];
    for (const record of invalidRecords) {
      const bytes = canonical(record);
      const candidate = ownedFile({
        expected_preimage_sha256: sha256Digest(bytes).slice("sha256:".length),
      });
      expect(() => hydratePrivateEffectPayload(candidate, bytes)).toThrow(/not bound/);
    }
    expect(() => privateEffectPreimageBytes(ownedFile({ preimage_base64: "%%%" }))).toThrow(
      /raw preimage differs/,
    );
  });

  test("private preimage decoding rejects every malformed variant and auxiliary mismatch", () => {
    const inlineBytes = projectionStateBytes("cHJpb3I=", null, [], true) as Buffer;
    const inline = ownedFile({
      expected_preimage_sha256: sha256Digest(inlineBytes).slice("sha256:".length),
      preimage_base64: "cHJpb3I=",
    });
    expect(() => assertPersistedPrivateEffectPayload(inline)).toThrow(/inline preimage authority/);

    expect(() =>
      privateEffectPreimageBytes(
        legacyPayload(
          { kind: "file", canonical_relative_path: "legacy.txt", preimage_base64: "%%%" },
          { expected_preimage_sha256: "0".repeat(64) },
        ),
      ),
    ).toThrow(/canonical base64/);
    expect(() =>
      privateEffectPreimageBytes(
        ownedFile({
          expected_preimage_sha256: "0".repeat(64),
          preimage_base64: "cHJpb3I=",
          preimage_marker_base64: Buffer.from([0xff]).toString("base64"),
        }),
      ),
    ).toThrow(/marker is corrupt/);
    expect(() =>
      privateEffectPreimageBytes(
        ownedFile({
          expected_preimage_sha256: "0".repeat(64),
          preimage_base64: "cHJpb3I=",
          preimage_marker_base64: Buffer.from('{"b":1, "a":2}').toString("base64"),
        }),
      ),
    ).toThrow(/not canonical JSON/);

    const cases: Array<{
      persisted: CapabilityPrivateEffectPayloadV1;
      record: Record<string, unknown>;
      message: RegExp;
    }> = [
      {
        persisted: ownedFile(),
        record: {
          schema_version: "1.0",
          value_present: true,
          value: null,
          marker: null,
          auxiliary: [],
        },
        message: /presence is invalid/,
      },
      {
        persisted: ownedFile(),
        record: {
          schema_version: "1.0",
          value_present: true,
          value: "cHJpb3I=",
          marker: null,
          auxiliary: [null],
        },
        message: /extra auxiliary/,
      },
      {
        persisted: jsonSlice({
          auxiliary_files: [
            {
              canonical_relative_path: "bin/tool",
              file_mode: 0o755,
              preimage_base64: null,
              postimage_base64: null,
            },
          ],
        }),
        record: {
          schema_version: "1.0",
          value_present: false,
          value: null,
          marker: null,
          auxiliary: [],
        },
        message: /auxiliary preimage count/,
      },
      {
        persisted: hookSlice({
          codex_feature: {
            canonical_relative_path: ".codex/config.toml",
            block_id: "codex-hooks-feature",
            placement: "append",
            preimage_block: null,
            postimage_block: null,
          },
        }),
        record: {
          schema_version: "1.0",
          value_present: false,
          value: null,
          marker: null,
          auxiliary: [],
        },
        message: /auxiliary preimage count/,
      },
      {
        persisted: hookSlice({
          codex_feature: {
            canonical_relative_path: ".codex/config.toml",
            block_id: "codex-hooks-feature",
            placement: "append",
            preimage_block: null,
            postimage_block: null,
          },
        }),
        record: {
          schema_version: "1.0",
          value_present: false,
          value: null,
          marker: null,
          auxiliary: [42],
        },
        message: /Codex hook preimage block/,
      },
      {
        persisted: tomlBlock(),
        record: {
          schema_version: "1.0",
          value_present: true,
          value: 42,
          marker: null,
          auxiliary: [],
        },
        message: /TOML owned block preimage/,
      },
      {
        persisted: tomlBlock(),
        record: {
          schema_version: "1.0",
          value_present: true,
          value: "old",
          marker: null,
          auxiliary: [null],
        },
        message: /extra auxiliary/,
      },
    ];
    for (const row of cases) {
      const bytes = canonical(row.record);
      const persisted = payload({
        ...row.persisted,
        expected_preimage_sha256: sha256Digest(bytes).slice("sha256:".length),
      } as Omit<CapabilityPrivateEffectPayloadV1, "payload_digest">);
      expect(() => hydratePrivateEffectPayload(persisted, bytes)).toThrow(row.message);
    }
  });

  test("legacy payload hydration binds exact file and JSON bytes", () => {
    const fileBytes = Buffer.from("legacy-file");
    const file = legacyPayload(
      { kind: "file", canonical_relative_path: "legacy.txt", preimage_base64: "" },
      { expected_preimage_sha256: sha256Digest(fileBytes).slice("sha256:".length) },
    );
    const hydratedFile = hydratePrivateEffectPayload(file, fileBytes);
    expect(
      (hydratedFile as Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "legacy-claim" }>)
        .projection,
    ).toEqual({
      kind: "file",
      canonical_relative_path: "legacy.txt",
      preimage_base64: fileBytes.toString("base64"),
    });

    const jsonBytes = canonical({ exact: true });
    const json = legacyPayload(
      {
        kind: "json-key-slice",
        canonical_relative_path: "legacy.json",
        key_path: ["tool"],
        preimage: null,
      },
      { expected_preimage_sha256: sha256Digest(jsonBytes).slice("sha256:".length) },
    );
    const hydratedJson = hydratePrivateEffectPayload(json, jsonBytes);
    expect(
      (hydratedJson as Extract<CapabilityPrivateEffectPayloadV1, { payload_kind: "legacy-claim" }>)
        .projection,
    ).toEqual({
      kind: "json-key-slice",
      canonical_relative_path: "legacy.json",
      key_path: ["tool"],
      preimage: { exact: true },
    });
    expect(() => hydratePrivateEffectPayload(json, Buffer.from([0xff]))).toThrow(
      /raw preimage differs/,
    );
    const corrupt = Buffer.from([0xff]);
    const corruptPayload = legacyPayload(
      {
        kind: "json-key-slice",
        canonical_relative_path: "legacy.json",
        key_path: ["tool"],
        preimage: null,
      },
      { expected_preimage_sha256: sha256Digest(corrupt).slice("sha256:".length) },
    );
    expect(() => hydratePrivateEffectPayload(corruptPayload, corrupt)).toThrow(
      /JSON projection preimage is corrupt/,
    );
    const noncanonical = Buffer.from('{"exact": true}');
    const noncanonicalPayload = legacyPayload(
      {
        kind: "json-key-slice",
        canonical_relative_path: "legacy.json",
        key_path: ["tool"],
        preimage: null,
      },
      { expected_preimage_sha256: sha256Digest(noncanonical).slice("sha256:".length) },
    );
    expect(() => hydratePrivateEffectPayload(noncanonicalPayload, noncanonical)).toThrow(
      /not canonical/,
    );
  });

  test("private descriptor bindings round-trip and reject forged closure", () => {
    const privateDescriptor = descriptor();
    expect(validateAdapterPrivateDescriptor(privateDescriptor)).toEqual(privateDescriptor);
    const locator = {
      kind: "capability" as const,
      scope: "project" as const,
      scope_identity_digest: runtimeDigest("descriptor-scope"),
    };
    const effectBinding = privateEffectBinding(privateDescriptor, locator);
    expect(validatePrivateEffectBinding(effectBinding)).toEqual(effectBinding);
    const owner = privateEffectOwnerPreimageBinding(effectBinding);
    expect(validatePrivateEffectOwnerPreimageBinding(owner)).toEqual(owner);
    expect(restorePrivateEffectOwnerBinding(owner)).toEqual(effectBinding);
    const rebound = bindPrivateEffectOwnerPreimage(ownedFile(), effectBinding);
    expect(rebound.preimage_owner_binding).toEqual(owner);
    expect(validatePrivateEffectPayload(rebound)).toEqual(rebound);

    expect(() =>
      validatePrivateEffectBinding({ ...effectBinding, private_descriptor_ref: "wrong" }),
    ).toThrow(/binding is invalid/);
    expect(() =>
      validatePrivateEffectOwnerPreimageBinding({
        ...owner,
        action_root_binding_digest: runtimeDigest("wrong"),
      }),
    ).toThrow(/binding is invalid/);
    expect(() =>
      validateAdapterPrivateDescriptor({
        ...privateDescriptor,
        descriptor_digest: runtimeDigest("wrong"),
      }),
    ).toThrow(/identity mismatch/);
    expect(() =>
      validateAdapterPrivateDescriptor(descriptor(hookSlice(), "vf.hook.codex")),
    ).toThrow(/Codex hook feature/);
  });

  test("private payload shape validation rejects extension, owner, path and variant drift", () => {
    expect(() =>
      assertPrivateEffectPayloadShape({ payload_kind: "memory-test-only" } as never),
    ).toThrow(/keys are not exact/);
    expect(() =>
      assertPrivateEffectPayloadShape({ ...memoryPayload(), extra: true } as never),
    ).toThrow(/keys are not exact/);
    expect(() =>
      assertPrivateEffectPayloadShape({
        ...ownedFile(),
        preimage_owner_binding: undefined,
      } as never),
    ).toThrow();
    expect(() =>
      validatePrivateEffectPayload(ownedFile({ canonical_relative_path: "../escape" })),
    ).toThrow(/path is not canonical/);
    expect(() => validatePrivateEffectPayload(jsonSlice({ key_path: [] }))).toThrow(/key path/);
    expect(() => validatePrivateEffectPayload(tomlBlock({ block_id: "Bad ID" }))).toThrow(
      /block ID/,
    );
    expect(() =>
      validatePrivateEffectPayload(
        hookSlice({
          root: "project",
          codex_feature: {
            canonical_relative_path: ".codex/config.toml",
            block_id: "codex-hooks-feature",
            placement: "append",
            preimage_block: null,
            postimage_block: null,
          },
        }),
      ),
    ).toThrow(/user adapter/);
    expect(() =>
      validatePrivateEffectPayload(
        hookSlice({
          codex_feature: {
            canonical_relative_path: ".codex/config.toml",
            block_id: "codex-hooks-feature",
            placement: "invalid" as "append",
            preimage_block: null,
            postimage_block: null,
          },
        }),
      ),
    ).toThrow(/placement/);
    expect(() =>
      assertPrivateEffectPayloadShape({
        payload_kind: "unknown",
        preimage_owner_binding: null,
      } as never),
    ).toThrow(/kind is unsupported/);
  });

  test("private payload shape covers base, locator, nested record and legacy variants", () => {
    expect(() =>
      assertPrivateEffectPayloadShape({ ...memoryPayload(), schema_version: "2.0" } as never),
    ).toThrow(/base fields/);

    const owner = privateEffectOwnerPreimageBinding(binding());
    const conversationLocator = { kind: "conversation" as const, root_session_id: "root-session" };
    const conversationOwner = {
      ...owner,
      action_root_locator: conversationLocator,
      action_root_binding_digest: digestV1(
        "VF-CAPABILITY-PRIVATE-ACTION-ROOT\0v1\0",
        conversationLocator,
      ),
    };
    expect(() =>
      assertPrivateEffectPayloadShape(ownedFile({ preimage_owner_binding: conversationOwner })),
    ).not.toThrow();
    expect(() =>
      assertPrivateEffectPayloadShape(
        ownedFile({
          preimage_owner_binding: {
            ...owner,
            action_root_locator: { kind: "bad" } as never,
          },
        }),
      ),
    ).toThrow(/action root is invalid/);

    expect(() =>
      assertPrivateEffectPayloadShape({ ...jsonSlice(), key_path: "bad" } as never),
    ).toThrow(/JSON fields/);
    expect(() =>
      assertPrivateEffectPayloadShape(
        jsonSlice({
          auxiliary_files: [
            {
              canonical_relative_path: "bin/tool",
              file_mode: 0o755,
              preimage_base64: null,
              postimage_base64: null,
              extra: true,
            } as never,
          ],
        }),
      ),
    ).toThrow(/keys are not exact/);
    expect(() =>
      assertPrivateEffectPayloadShape({ ...hookSlice(), key_path: "bad" } as never),
    ).toThrow(/key path is invalid/);
    expect(() =>
      assertPrivateEffectPayloadShape(
        hookSlice({
          codex_feature: {
            canonical_relative_path: "wrong.toml",
            block_id: "codex-hooks-feature",
            placement: "append",
            preimage_block: null,
            postimage_block: null,
          },
        }),
      ),
    ).toThrow(/closed canonical path/);

    const legacyFile = legacyPayload(
      { kind: "file", canonical_relative_path: "legacy.txt", preimage_base64: "bGVnYWN5" },
      { expected_preimage_sha256: "0".repeat(64) },
    );
    expect(() => assertPrivateEffectPayloadShape(legacyFile)).not.toThrow();
    const legacyJson = legacyPayload(
      {
        kind: "json-key-slice",
        canonical_relative_path: "legacy.json",
        key_path: ["tool"],
        preimage: true,
      },
      { expected_preimage_sha256: "0".repeat(64) },
    );
    expect(() => assertPrivateEffectPayloadShape(legacyJson)).not.toThrow();
    expect(() =>
      assertPrivateEffectPayloadShape({
        ...legacyJson,
        projection: { ...legacyJson.projection, key_path: "bad" },
      } as never),
    ).toThrow(/legacy private projection/);
  });

  test("private binding and legacy validation reject invalid action roots and claim authority", () => {
    const effectBinding = binding();
    expect(() =>
      validatePrivateEffectBinding({
        ...effectBinding,
        action_root_locator: {
          kind: "recovery-bootstrap",
          bootstrap_identity_digest: runtimeDigest("bootstrap"),
        } as never,
      }),
    ).toThrow(/action root is invalid/);
    expect(() =>
      validatePrivateEffectBinding({
        ...effectBinding,
        action_root_locator: {
          kind: "capability",
          scope: "invalid",
          scope_identity_digest: runtimeDigest("scope"),
        } as never,
      }),
    ).toThrow(/action root is invalid/);
    const owner = privateEffectOwnerPreimageBinding(effectBinding);
    expect(() =>
      validatePrivateEffectOwnerPreimageBinding({
        ...owner,
        action_root_locator: { kind: "conversation", root_session_id: "bad space" },
      }),
    ).toThrow(/owner preimage action root/);

    const legacy = legacyPayload(
      {
        kind: "json-key-slice",
        canonical_relative_path: "legacy.json",
        key_path: ["tool"],
        preimage: true,
      },
      { expected_preimage_sha256: "0".repeat(64) },
    );
    expect(() =>
      validatePrivateEffectPayload(
        payload({ ...legacy, inspection_evidence_digest: "bad" } as never),
      ),
    ).toThrow(/inspection evidence digest/);
    expect(() =>
      validatePrivateEffectPayload(payload({ ...legacy, evidence_record_digest: "bad" } as never)),
    ).toThrow(/source record digest/);
    expect(() =>
      validatePrivateEffectPayload(
        payload({
          ...legacy,
          projection: { ...legacy.projection, key_path: [] },
        } as never),
      ),
    ).toThrow(/legacy claim key path/);
  });

  test("filesystem observers, preimage checks and repair reject unapproved state", () => {
    const fsRoots = fixtureRoots();
    write(fsRoots.project, "legacy.json", canonical({ nested: { key: "value" } }));
    const legacyJson = payload({
      schema_version: "1.0",
      payload_kind: "legacy-claim",
      ownership_key: "legacy:coverage:json",
      expected_preimage_sha256: sha256Digest(canonical("value")).slice("sha256:".length),
      expected_postimage_sha256: sha256Digest(canonical("value")).slice("sha256:".length),
      preimage_owner_binding: null,
      root: "project",
      legacy_source: "tool-managed-evidence",
      inspection_evidence_digest: runtimeDigest("inspection"),
      evidence_record_digest: runtimeDigest("record"),
      projection: {
        kind: "json-key-slice",
        canonical_relative_path: "legacy.json",
        key_path: ["nested", "key"],
        preimage: "value",
      },
    });
    expect(observeFilesystemPayload(legacyJson, fsRoots)).toBe(
      sha256Digest(canonical("value")).slice("sha256:".length),
    );
    expect(
      observeFilesystemPayload(
        legacyPayload({
          kind: "file",
          canonical_relative_path: "missing-legacy-file",
          preimage_base64: "",
        }),
        fsRoots,
      ),
    ).toBeNull();
    assertPayloadPreimageBytes(legacyJson, fsRoots);
    write(fsRoots.project, "legacy.json", canonical({ nested: { key: "changed" } }));
    expect(() => assertPayloadPreimageBytes(legacyJson, fsRoots)).toThrow(/legacy config/);

    expect(() => observeFilesystemPayload(memoryPayload(), fsRoots)).toThrow(/memory payload/);
    expect(() => mutateFilesystemPayload(memoryPayload(), fsRoots, "forward")).toThrow(
      /memory payload/,
    );
    expect(() => reconcileFilesystemPayload(memoryPayload(), fsRoots, "forward")).toThrow(
      /memory payload/,
    );

    write(fsRoots.project, "config.json", canonical({ tools: { owned: "foreign" } }));
    const json = jsonSlice({
      preimage: "before",
      preimage_present: true,
      postimage: "after",
      postimage_present: true,
    });
    expect(() => assertPayloadPreimageBytes(json, fsRoots)).toThrow(/JSON owned slice/);
    expect(() => reconcileFilesystemPayload(json, fsRoots, "forward")).toThrow(/unapproved JSON/);

    write(fsRoots.user, ".codex/hooks.json", canonical({ hooks: { PreToolUse: "foreign" } }));
    const hook = hookSlice({
      preimage: "before",
      preimage_present: true,
      postimage: "after",
      postimage_present: true,
    });
    expect(() => assertPayloadPreimageBytes(hook, fsRoots)).toThrow(/hook config/);

    write(fsRoots.project, ".codex/config.toml", "foreign = true\n");
    const toml = tomlBlock({ preimage_block: "before", postimage_block: "after" });
    expect(() => assertPayloadPreimageBytes(toml, fsRoots)).toThrow(/TOML owned block/);
  });

  test("projection IO cleans failed CAS stages and rejects corrupt JSON/TOML parents", () => {
    const fsRoots = fixtureRoots();
    const target = join(fsRoots.project, "nested", "target.txt");
    expect(() =>
      compareAndSwapProjectionFile(target, null, Buffer.from("new"), 0o600, () => {
        throw new Error("fault-before-commit");
      }),
    ).toThrow(/fault-before-commit/);
    expect(() => readFileSync(target)).toThrow();
    expect(() => parseProjectionJson(Buffer.from([0xff]), "bad.json")).toThrow(/corrupt/);
    expect(() => writeJsonSlice({ parent: 1 }, ["parent", "leaf"], true, "x")).toThrow(
      /parent is not an object/,
    );
    expect(readJsonSlice({ parent: null }, ["parent", "leaf"])).toEqual({
      present: false,
      value: null,
    });

    const tomlPath = join(fsRoots.project, "config.toml");
    writeFileSync(tomlPath, Buffer.from([0xff]));
    expect(() => compareAndSwapTomlOwnedBlock(tomlPath, "block", null, null)).toThrow(/UTF-8/);
    writeFileSync(tomlPath, "[features]\n[features]\n");
    const block = "# vf-capability:block:start\nflag = true\n# vf-capability:block:end";
    expect(() =>
      compareAndSwapTomlOwnedBlock(tomlPath, "block", null, block, 0o600, "after-features-header"),
    ).toThrow(/anchor is not unique/);
    expect(() => tomlOwnedBlock("# vf-capability:x:start\n", "x")).toThrow(/markers are corrupt/);
    expect(replaceTomlOwnedBlock("", "block", block)).toContain("flag = true");
  });

  test("projection helpers cover participant naming, retained preimages and marker errors", () => {
    const request = effectRequest(
      resolvedRolePackage().manifest.components[0] as CapabilityComponentV1,
      "codex",
    );
    request.target.participant_id = "participant-1";
    expect(projectionName(request)).toMatch(/--p-[a-f0-9]{16}$/);
    expect(projectionOwnershipKey(request)).toContain("participant-1");
    expect(markerPath("vf:key")).toMatch(/\.json$/);
    const bytes = privatePreimageBytes("value", null, [], true);
    expect(
      projectionResource("vf:key", "file", "target", "a", "b", bytes).private_preimage_ref,
    ).toMatch(/^actions\/v1\/blobs\//);
    const fsRoots = fixtureRoots();
    write(fsRoots.project, "marker.json", "not-json");
    expect(() => readMarker(fsRoots.project, "marker.json")).toThrow(/corrupt/);
  });

  test("projection builders resolve nested MCP inputs and reject unsupported surfaces", () => {
    const fsRoots = fixtureRoots();
    const mcp: Extract<CapabilityComponentV1, { type: "mcp" }> = {
      type: "mcp",
      component_id: "server",
      targets: ["opencode"],
      required: true,
      transport: "http",
      url: { input_ref: "endpoint" },
    };
    const request = effectRequest(mcp, "opencode");
    request.package.public_inputs = [{ input_id: "endpoint", value: "https://example.com/mcp" }];
    const built = buildFilesystemProjection(request, fsRoots);
    expect(built.private_payload.payload_kind).toBe("json-key-slice");

    const nestedRequest = effectRequest(
      { ...mcp, url: { relay: { input_ref: "endpoint" } } as never },
      "opencode",
    );
    nestedRequest.package.public_inputs = [
      { input_id: "endpoint", value: "https://example.com/nested" },
    ];
    expect(buildFilesystemProjection(nestedRequest, fsRoots).private_payload.payload_kind).toBe(
      "json-key-slice",
    );

    const absent = effectRequest(mcp, "opencode");
    expect(() => buildFilesystemProjection(absent, fsRoots)).toThrow(/input binding is absent/);
    const secret = effectRequest({ ...mcp, secret_slots: ["token"] }, "opencode");
    expect(() => buildFilesystemProjection(secret, fsRoots)).toThrow(/secret slots/);

    const unsupported = effectRequest(
      {
        type: "engine-setting",
        component_id: "native",
        targets: ["codex"],
        required: true,
        setting_id: "coverage-setting",
        value: true,
      },
      "codex",
    );
    expect(() => buildFilesystemProjection(unsupported, fsRoots)).toThrow(/no host-owned/);

    const executable = Buffer.from("#!/usr/bin/env bun\n");
    const stdio: Extract<CapabilityComponentV1, { type: "mcp" }> = {
      type: "mcp",
      component_id: "stdio-server",
      targets: ["codex"],
      required: true,
      transport: "stdio",
      executable: {
        component_id: "stdio-server",
        relative_path: "bin/server.ts",
        sha256: sha256Digest(executable).slice("sha256:".length),
      },
      args: ["--serve"],
      secret_slots: [],
    };
    const stdioRequest = effectRequest(stdio, "codex", "user");
    (stdioRequest.package.files as Map<string, Uint8Array>).set("bin/server.ts", executable);
    const stdioBuilt = buildFilesystemProjection(stdioRequest, fsRoots);
    expect(stdioBuilt.private_payload.payload_kind).toBe("toml-owned-block");
    expect(
      (
        stdioBuilt.private_payload as Extract<
          CapabilityPrivateEffectPayloadV1,
          { payload_kind: "toml-owned-block" }
        >
      ).postimage_block,
    ).toContain("command =");

    const hook: Extract<CapabilityComponentV1, { type: "hook" }> = {
      type: "hook",
      component_id: "guardrail",
      targets: ["claude"],
      required: true,
      event: "pre-tool",
      vf_handler_id: "vf-guardrail",
    };
    expect(() =>
      buildFilesystemProjection(
        effectRequest({ ...hook, vf_handler_id: "unknown-handler" }, "claude"),
        fsRoots,
      ),
    ).toThrow(/handler is not in the checked-in registry/);
    expect(() =>
      buildFilesystemProjection(effectRequest({ ...hook, event: "pre-commit" }, "claude"), fsRoots),
    ).toThrow(/event has no checked-in runtime adapter/);
    expect(() => buildFilesystemProjection(effectRequest(hook, "codex"), fsRoots)).toThrow(
      /user-global/,
    );
    expect(() =>
      buildFilesystemProjection(
        effectRequest({ ...hook, event: "post-tool" }, "opencode"),
        fsRoots,
      ),
    ).toThrow(/no effective post-tool handler/);
    write(fsRoots.user, ".codex/config.toml", "codex_hooks = false\n");
    expect(() => buildFilesystemProjection(effectRequest(hook, "codex", "user"), fsRoots)).toThrow(
      /unmanaged Codex hook feature/,
    );
  });

  test("adapter registry validator detects support, null, identity, legacy and digest drift", () => {
    expect(
      validateCapabilityAdapterRegistry(CAPABILITY_ADAPTER_REGISTRY_V1).entries.length,
    ).toBeGreaterThan(0);
    const variants = [
      (value: typeof CAPABILITY_ADAPTER_REGISTRY_V1) => {
        value.entries[0] = { ...value.entries[0], support: "unsupported", adapter: null } as never;
      },
      (value: typeof CAPABILITY_ADAPTER_REGISTRY_V1) => {
        const unsupportedIndex = value.entries.findIndex((row) => row.adapter === null);
        value.entries[unsupportedIndex] = {
          ...value.entries[unsupportedIndex],
          adapter: { adapter_id: "forged", adapter_version: "1", fingerprint: runtimeDigest("x") },
        } as never;
      },
      (value: typeof CAPABILITY_ADAPTER_REGISTRY_V1) => {
        value.entries[0] = {
          ...value.entries[0],
          adapter: {
            ...(
              value.entries[0] as {
                adapter: NonNullable<(typeof value.entries)[number]["adapter"]>;
              }
            ).adapter,
            fingerprint: runtimeDigest("forged"),
          },
        } as never;
      },
      (value: typeof CAPABILITY_ADAPTER_REGISTRY_V1) => {
        value.legacy_adoption_entries = [];
      },
      (value: typeof CAPABILITY_ADAPTER_REGISTRY_V1) => {
        value.registry_digest = runtimeDigest("forged-registry");
      },
    ];
    for (const mutate of variants) {
      const candidate = structuredClone(CAPABILITY_ADAPTER_REGISTRY_V1);
      mutate(candidate as typeof CAPABILITY_ADAPTER_REGISTRY_V1);
      expect(() => validateCapabilityAdapterRegistry(candidate)).toThrow();
    }
    expect(resolveLegacyAdoptionAdapter("role-marker").support).toBe("host");
    expect(resolveCapabilityAdapter("role", "codex").adapter).not.toBeNull();
  });

  test("retained local cache authority rejects corrupt and cross-bound lock evidence", () => {
    const valid = localCacheAuthorityFixture();
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([valid.lock], valid.input),
    ).not.toThrow();

    const corrupt = localCacheAuthorityFixture();
    writeAbsolute(
      packageRecordCachePath(corrupt.privateRoot, corrupt.entry.pin.pin_digest),
      Buffer.from([0xff]),
    );
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([corrupt.lock], corrupt.input),
    ).toThrow(/package cache record is corrupt/);

    const wrongOwner = localCacheAuthorityFixture();
    writeAbsolute(
      packageRecordCachePath(wrongOwner.privateRoot, wrongOwner.entry.pin.pin_digest),
      canonical(cacheRecordWith(wrongOwner.record, { scope: "user" })),
    );
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([wrongOwner.lock], wrongOwner.input),
    ).toThrow(/does not bind the lock entry owner/);

    const wrongTree = localCacheAuthorityFixture();
    writeAbsolute(
      packageRecordCachePath(wrongTree.privateRoot, wrongTree.entry.pin.pin_digest),
      canonical(
        cacheRecordWith(wrongTree.record, {
          tree_entry_count: wrongTree.record.tree_entry_count + 1,
        }),
      ),
    );
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([wrongTree.lock], wrongTree.input),
    ).toThrow(/package tree does not bind/);

    const wrongManifest = localCacheAuthorityFixture();
    writeAbsolute(
      packageManifestCachePath(wrongManifest.privateRoot, wrongManifest.record.manifest_digest),
      canonical({ ...wrongManifest.manifest.manifest, description: "different retained bytes" }),
    );
    expect(() =>
      validateRegistryLockAuthorityFromDurableState([wrongManifest.lock], wrongManifest.input),
    ).toThrow(/cached manifest does not bind/);

    const wrongAuthenticity = localCacheAuthorityFixture();
    writeAbsolute(
      packageAuthenticityCachePath(
        wrongAuthenticity.privateRoot,
        wrongAuthenticity.record.authenticity_digest,
      ),
      canonical({
        ...wrongAuthenticity.authenticity,
        manifest_digest: runtimeDigest("wrong-retained-manifest"),
      }),
    );
    expect(() =>
      validateRegistryLockAuthorityFromDurableState(
        [wrongAuthenticity.lock],
        wrongAuthenticity.input,
      ),
    ).toThrow(/authenticity is not derived/);

    const conflict = localCacheAuthorityFixture();
    const conflictingEntry = {
      ...conflict.entry,
      manifest_digest: runtimeDigest("conflicting-manifest"),
    };
    expect(() =>
      validateRegistryLockAuthorityFromDurableState(
        [cacheLock(conflict.entry), cacheLock(conflictingEntry)],
        conflict.input,
      ),
    ).toThrow(/conflicting immutable source authority history/);
  });

  test("activation records reject missing, unsafe, corrupt and cross-bound authority state", () => {
    const source = authorityFixture();
    expect(findUniqueInitialAuthorityCheckpoint(source.paths, source.identity).content_digest).toBe(
      source.head.content_digest,
    );

    const missingRoots = fixtureRoots();
    const missingPaths = projectCapabilityPaths(missingRoots.project);
    expect(() => findUniqueInitialAuthorityCheckpoint(missingPaths, source.identity)).toThrow(
      /checkpoint is missing/,
    );

    const emptyRoots = fixtureRoots();
    const emptyPaths = projectCapabilityPaths(emptyRoots.project);
    mkdirSync(join(emptyPaths.privateRoot, "recovery", "v1", "checkpoints"), {
      recursive: true,
      mode: 0o700,
    });
    expect(() => findUniqueInitialAuthorityCheckpoint(emptyPaths, source.identity)).toThrow(
      /cannot uniquely resolve/,
    );

    const invalidNameRoots = fixtureRoots();
    const invalidNamePaths = projectCapabilityPaths(invalidNameRoots.project);
    writeAbsolute(
      join(invalidNamePaths.privateRoot, "recovery", "v1", "checkpoints", "invalid.json"),
      canonical(source.head),
    );
    expect(() => findUniqueInitialAuthorityCheckpoint(invalidNamePaths, source.identity)).toThrow(
      /invalid fixed-path name/,
    );

    const unsafeRoots = fixtureRoots();
    const unsafePaths = projectCapabilityPaths(unsafeRoots.project);
    mkdirSync(
      join(unsafePaths.privateRoot, "recovery", "v1", "checkpoints", `${"a".repeat(64)}.json`),
      { recursive: true, mode: 0o700 },
    );
    expect(() => findUniqueInitialAuthorityCheckpoint(unsafePaths, source.identity)).toThrow(
      /not an immutable regular file/,
    );

    const wrongNameRoots = fixtureRoots();
    const wrongNamePaths = projectCapabilityPaths(wrongNameRoots.project);
    writeAbsolute(
      join(wrongNamePaths.privateRoot, "recovery", "v1", "checkpoints", `${"a".repeat(64)}.json`),
      canonical(source.head),
    );
    expect(() => findUniqueInitialAuthorityCheckpoint(wrongNamePaths, source.identity)).toThrow(
      /filename does not bind/,
    );

    expect(parseCanonicalActivation(null, "optional activation")).toBeNull();
    expect(() => parseCanonicalActivation(Buffer.from([0xff]), "corrupt activation")).toThrow(
      /corrupt/,
    );
    expect(() =>
      parseCanonicalActivation(Buffer.from('{"z":1,"a":2}'), "noncanonical activation"),
    ).toThrow(/not canonical/);

    const receipt = materializeActivationReceipt(source.identity, source.head.content_digest);
    expect(() => validateActivationReceipt(receipt, source.identity)).not.toThrow();
    expect(() =>
      validateActivationReceipt(
        { ...receipt, initial_authority_head_digest: runtimeDigest("other-head") },
        source.identity,
      ),
    ).toThrow(/does not bind the immutable identity/);

    const dependentRoots = fixtureRoots();
    const dependentPaths = projectCapabilityPaths(dependentRoots.project);
    const allowed = join(dependentPaths.privateRoot, "allowed.json");
    const dependent = join(dependentPaths.privateRoot, "nested", "dependent.json");
    writeAbsolute(allowed, canonical({ allowed: true }));
    writeAbsolute(dependent, canonical({ dependent: true }));
    expect(activationDependentFiles(dependentPaths, [allowed])).toEqual([dependent]);
  });

  test("durable epoch-zero authority state folds exact identity, settings and checkpoints", () => {
    const fx = authorityFixture();
    const state = readDurableAuthorityState({
      private_root: fx.paths.privateRoot,
      identity_path: fx.paths.identity,
      scope: "project",
      scope_identity_digest: fx.identity.content_digest,
      initial_authority_head_digest: fx.head.content_digest,
      authority_transition_resolver: fx.resolver,
    });
    expect(state.current.content_digest).toBe(fx.head.content_digest);
    expect(state.events).toEqual([]);
    expect(assertDurableAuthorityState(state)).toBe(state);
    expect(() => assertDurableAuthorityState({} as never)).toThrow(/concrete durable fold/);

    const settings = readDurableSettingsPolicyState({
      private_root: fx.paths.privateRoot,
      identity_path: fx.paths.identity,
      scope: "project",
      scope_identity_digest: fx.identity.content_digest,
    });
    expect(settings.settings_schema_version).toBe("1.0");
    expect(() =>
      assertFinalAuthorityJournalState(
        fx.head,
        { ...fx.head, grant_digest: runtimeDigest("wrong") },
        {
          grants: [],
          policies: [],
          secrets: [],
          trust: [],
        },
        settings,
      ),
    ).toThrow(/journals do not equal/);
  });

  test("durable authority readers reject corrupt settings, identities and fixed-path drift", () => {
    const missingRoot = mkdtempSync(join(tmpdir(), "vf-cap-settings-missing-"));
    roots.push(missingRoot);
    expect(() =>
      readDurableSettingsPolicyState({
        private_root: join(missingRoot, "private"),
        identity_path: join(missingRoot, "PROJECT_ID.json"),
        scope: "project",
        scope_identity_digest: runtimeDigest("scope"),
      }),
    ).toThrow(/settings are missing/);
    writeAbsolute(join(missingRoot, "SETTINGS.json"), Buffer.from([0xff]));
    expect(() =>
      readDurableSettingsPolicyState({
        private_root: join(missingRoot, "private"),
        identity_path: join(missingRoot, "PROJECT_ID.json"),
        scope: "project",
        scope_identity_digest: runtimeDigest("scope"),
      }),
    ).toThrow(/strict JSON/);
    writeAbsolute(join(missingRoot, "SETTINGS.json"), canonical([]));
    expect(() =>
      readDurableSettingsPolicyState({
        private_root: join(missingRoot, "private"),
        identity_path: join(missingRoot, "PROJECT_ID.json"),
        scope: "project",
        scope_identity_digest: runtimeDigest("scope"),
      }),
    ).toThrow(/root must be an object/);

    const corrupt = authorityFixture();
    writeAbsolute(corrupt.paths.identity, Buffer.from([0xff]));
    expect(() =>
      readDurableAuthorityState({
        private_root: corrupt.paths.privateRoot,
        identity_path: corrupt.paths.identity,
        scope: "project",
        scope_identity_digest: corrupt.identity.content_digest,
        initial_authority_head_digest: corrupt.head.content_digest,
        authority_transition_resolver: corrupt.resolver,
      }),
    ).toThrow(/identity is corrupt/);

    const mismatch = authorityFixture();
    expect(() =>
      readDurableAuthorityState({
        private_root: mismatch.paths.privateRoot,
        identity_path: mismatch.paths.identity,
        scope: "project",
        scope_identity_digest: runtimeDigest("other-owner"),
        initial_authority_head_digest: mismatch.head.content_digest,
        authority_transition_resolver: mismatch.resolver,
      }),
    ).toThrow(/selected capability owner/);

    const fixedPath = authorityFixture();
    const wrongDigest = runtimeDigest("wrong-checkpoint-path");
    writeAbsolute(
      join(
        fixedPath.paths.privateRoot,
        "recovery",
        "v1",
        "checkpoints",
        `${wrongDigest.slice(7)}.json`,
      ),
      canonical(fixedPath.head),
    );
    expect(() =>
      readDurableAuthorityState({
        private_root: fixedPath.paths.privateRoot,
        identity_path: fixedPath.paths.identity,
        scope: "project",
        scope_identity_digest: fixedPath.identity.content_digest,
        initial_authority_head_digest: wrongDigest,
        authority_transition_resolver: fixedPath.resolver,
      }),
    ).toThrow(/fixed-path digest mismatch/);
  });

  test("durable registry reader rejects corrupt and mismatched selected identity", () => {
    const corrupt = authorityFixture();
    writeAbsolute(corrupt.paths.identity, Buffer.from([0xff]));
    expect(() =>
      readDurableRegistryTrustSnapshot({
        private_root: corrupt.paths.privateRoot,
        identity_path: corrupt.paths.identity,
        scope: "project",
        scope_identity_digest: corrupt.identity.content_digest,
        authority_transition_resolver: corrupt.resolver,
      }),
    ).toThrow(/identity is corrupt/);
    const mismatch = authorityFixture();
    expect(() =>
      readDurableRegistryTrustSnapshot({
        private_root: mismatch.paths.privateRoot,
        identity_path: mismatch.paths.identity,
        scope: "project",
        scope_identity_digest: runtimeDigest("other-owner"),
        authority_transition_resolver: mismatch.resolver,
      }),
    ).toThrow(/selected capability owner/);
    expect(() => assertDurableRegistryTrustSnapshot({} as never)).toThrow(
      /not durable-authority-derived/,
    );
  });
});
