import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CAPABILITY_MANIFEST_INPUT_TYPE,
  CAPABILITY_MANIFEST_PLATFORM_ARCH,
  CAPABILITY_MANIFEST_PLATFORM_LIBC,
  CAPABILITY_MANIFEST_PLATFORM_OS,
  type CapabilityManifestPlatformArch,
  type CapabilityManifestPlatformLibc,
  type CapabilityManifestPlatformOs,
} from "../../actions/capability-manifest-vocabulary-contract.js";
import { CAPABILITY_SOURCE_KIND } from "../../actions/capability-security-contract.js";
import { parseStrictJson } from "../../actions/strict-json.js";
import type { EngineName } from "../../actions/types.js";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../../core/capability-contract.js";
import { canonicalJson, canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import { readProjectionFile } from "../adapters/filesystem-io.js";
import type { ValidatedCapabilityManifestV1 } from "../manifest/types.js";
import { parseCapabilityManifest } from "../manifest/validation.js";
import type {
  CapabilityRuntimeAuthorityV1,
  ResolvedCapabilityPackageV1,
} from "../planning/types.js";
import type { CapabilityPackageReadRequestV1, CapabilityPackageReaderV1 } from "../query/types.js";
import { CapabilityValidationError, DIGEST_PATTERN, bytewise } from "../wire/primitives.js";
import type { DurableAuthorityTransitionResolverV1 } from "./durable-authority-transition-resolver.js";
import { readDurableRegistryTrustSnapshot } from "./durable-registry-authority.js";
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
import { verifyRegistryEnvelope } from "./registry.js";
import {
  type ResolutionCandidateV1,
  createResolutionCandidate,
  createResolutionCompatibilityRecord,
} from "./resolution-records.js";
import { readPackageTree } from "./tree.js";
import type { PackageTreeV1 } from "./tree.js";
import type {
  LegacyInspectionEvidenceV1,
  PackageAuthenticityBindingV1,
  RegistrySignatureEnvelopeV1,
  RegistryTrustSnapshotV1,
} from "./types.js";
function parseJsonFile<T>(path: string, label: string): T {
  const bytes = readProjectionFile(path);
  if (bytes === null)
    throw new CapabilityValidationError(`${label} is missing`, label, "integrity_failure");
  let value: unknown;
  try {
    value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CapabilityValidationError(`${label} is corrupt`, label, "integrity_failure");
  }
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(value, { maxBytes: 2 * 1024 * 1024 })))
    throw new CapabilityValidationError(`${label} is not canonical`, label, "integrity_failure");
  return value as T;
}
export interface FilesystemCapabilityPackageCacheOptionsV1 {
  scope: CapabilityScope;
  scopeIdentityDigest: string;
  privateRoot: string;
  authority: () => CapabilityRuntimeAuthorityV1;
  authorityTransitionResolver?: DurableAuthorityTransitionResolverV1;
  now?: () => string;
  vfVersion?: string;
  engineVersions?: Partial<Record<EngineName, string>>;
  platform?: {
    os: CapabilityManifestPlatformOs;
    arch: CapabilityManifestPlatformArch;
    libc: CapabilityManifestPlatformLibc | null;
  };
}
export interface CachedResolutionCandidateV1 {
  candidate: ResolutionCandidateV1;
  resolved: ResolvedCapabilityPackageV1;
}
export interface CachedPackageExecutionAuthorityV1 {
  record: CapabilityPackageCacheRecordV1;
  resolved: ResolvedCapabilityPackageV1;
  trust: RegistryTrustSnapshotV1;
}
export class FilesystemCapabilityPackageCacheV1 implements CapabilityPackageReaderV1 {
  readonly #now: () => string;
  constructor(readonly options: FilesystemCapabilityPackageCacheOptionsV1) {
    this.#now = options.now ?? (() => new Date().toISOString());
  }
  read(request: CapabilityPackageReadRequestV1): ResolvedCapabilityPackageV1 | null {
    const resolved = this.readByPin(request.package_pin_digest);
    if (!resolved) return null;
    return resolved.pin.id === request.package_id &&
      resolved.pin.version === request.version &&
      resolved.pin.content_sha256 === request.content_sha256
      ? resolved
      : null;
  }
  readByPin(pinDigest: string): ResolvedCapabilityPackageV1 | null {
    if (!DIGEST_PATTERN.test(pinDigest))
      throw new CapabilityValidationError("invalid package pin digest", "pin_digest");
    const path = packageRecordCachePath(this.options.privateRoot, pinDigest);
    if (readProjectionFile(path) === null) return null;
    const record = this.readRecord(pinDigest);
    const tree = readPackageTree(
      packageTreeCachePath(this.options.privateRoot, record.package_pin.content_sha256),
    );
    if (
      tree.content_sha256 !== record.package_pin.content_sha256 ||
      tree.entry_count !== record.tree_entry_count ||
      tree.expanded_byte_length !== record.tree_expanded_byte_length
    )
      throw new CapabilityValidationError(
        "cached package tree differs from its record",
        "package_tree",
        "integrity_failure",
      );
    const parsedManifest = parseCapabilityManifest(
      tree.files.get("capability.json") as Uint8Array,
      tree.files,
    );
    const storedManifest = parseJsonFile<unknown>(
      packageManifestCachePath(this.options.privateRoot, record.manifest_digest),
      "cached manifest",
    );
    if (
      parsedManifest.manifest_digest !== record.manifest_digest ||
      canonicalJson(storedManifest) !== canonicalJson(parsedManifest.manifest)
    )
      throw new CapabilityValidationError(
        "cached manifest/tree identity mismatch",
        "manifest",
        "integrity_failure",
      );
    const authenticity = this.readAuthenticity(record, tree, parsedManifest);
    const authority = this.options.authority();
    if (
      authority.scope !== record.scope ||
      authority.scope_identity_digest !== record.scope_identity_digest
    )
      throw new CapabilityValidationError("cache authority scope changed", "package_cache_record");
    return {
      schema_version: "1.0",
      pin: record.package_pin,
      manifest: parsedManifest.manifest,
      manifest_digest: parsedManifest.manifest_digest,
      authenticity_binding: authenticity,
      files: tree.files,
      dependencies: [],
      public_inputs: parsedManifest.manifest.inputs
        .filter(
          (input) =>
            input.type !== CAPABILITY_MANIFEST_INPUT_TYPE.SECRET_HANDLE &&
            input.default_value !== null,
        )
        .map((input) => ({ input_id: input.input_id, value: input.default_value })),
      secret_input_ids: parsedManifest.manifest.inputs
        .filter((input) => input.type === CAPABILITY_MANIFEST_INPUT_TYPE.SECRET_HANDLE)
        .map((input) => input.input_id),
      private_input_binding_digest: digestV1("VF-CAPABILITY-PRIVATE-INPUT-BINDING-SET\0v1\0", {
        schema_version: "1.0",
        bindings: [],
      }),
      source_authority_binding_digest: this.sourceAuthorityBindingDigest(record, authority),
    };
  }

  candidates(engines: readonly EngineName[]): CachedResolutionCandidateV1[] {
    const root = dirname(
      packageRecordCachePath(this.options.privateRoot, digestV1("VF-CACHE-SCAN\0v1\0", 0)),
    );
    let names: string[];
    try {
      names = readdirSync(root)
        .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
        .sort(bytewise);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (names.length > 10_000)
      throw new CapabilityValidationError(
        "package cache record count exceeds bound",
        "package_records",
        "bounds",
      );
    return names.map((name) => {
      const resolved = this.readByPin(`sha256:${name.slice(0, -5)}`);
      if (!resolved)
        throw new CapabilityValidationError("scanned package record disappeared", name);
      const tree = readPackageTree(
        packageTreeCachePath(this.options.privateRoot, resolved.pin.content_sha256),
      );
      const manifestRecord = parseCapabilityManifest(
        tree.files.get("capability.json") as Uint8Array,
        tree.files,
      );
      const compatibility = createResolutionCompatibilityRecord(manifestRecord, {
        vf_version: this.options.vfVersion ?? "0.14.0",
        engines: [...engines].sort(bytewise).map((engine) => ({
          engine,
          version: this.options.engineVersions?.[engine] ?? "1.0.0",
        })),
        platform: this.options.platform ?? {
          os:
            process.platform === CAPABILITY_MANIFEST_PLATFORM_OS.WINDOWS
              ? CAPABILITY_MANIFEST_PLATFORM_OS.WINDOWS
              : process.platform === CAPABILITY_MANIFEST_PLATFORM_OS.LINUX
                ? CAPABILITY_MANIFEST_PLATFORM_OS.LINUX
                : CAPABILITY_MANIFEST_PLATFORM_OS.DARWIN,
          arch:
            process.arch === CAPABILITY_MANIFEST_PLATFORM_ARCH.ARM64
              ? CAPABILITY_MANIFEST_PLATFORM_ARCH.ARM64
              : CAPABILITY_MANIFEST_PLATFORM_ARCH.X64,
          libc:
            process.platform === CAPABILITY_MANIFEST_PLATFORM_OS.LINUX
              ? CAPABILITY_MANIFEST_PLATFORM_LIBC.GLIBC
              : null,
        },
      });
      return {
        resolved,
        candidate: createResolutionCandidate({
          pin: resolved.pin,
          manifest_record: manifestRecord,
          package_tree: tree,
          compatibility,
        }),
      };
    });
  }

  /** Revalidates the fixed cache and durable trust head used by proposal execution objects. */
  executionAuthority(pinDigest: string): CachedPackageExecutionAuthorityV1 {
    const resolved = this.readByPin(pinDigest);
    if (!resolved)
      throw new CapabilityValidationError(
        "package execution authority is absent",
        "package_cache_record",
        "integrity_failure",
      );
    if (!this.options.authorityTransitionResolver)
      throw new CapabilityValidationError(
        "durable action authority verifier is unavailable",
        "authority.transition",
        "integrity_failure",
      );
    const identityPath =
      this.options.scope === CAPABILITY_SCOPE.PROJECT
        ? join(dirname(dirname(this.options.privateRoot)), "PROJECT_ID.json")
        : join(this.options.privateRoot, "authority", "USER_IDENTITY.json");
    return {
      record: this.readRecord(pinDigest),
      resolved,
      trust: readDurableRegistryTrustSnapshot({
        private_root: this.options.privateRoot,
        identity_path: identityPath,
        scope: this.options.scope,
        scope_identity_digest: this.options.scopeIdentityDigest,
        authority_transition_resolver: this.options.authorityTransitionResolver,
      }),
    };
  }

  sourceAuthorityBindingDigest(
    record: CapabilityPackageCacheRecordV1,
    authority = this.options.authority(),
  ): string {
    return digestV1("VF-RESOLVED-SOURCE-AUTHORITY\0v1\0", {
      schema_version: "1.0",
      scope: record.scope,
      scope_identity_digest: record.scope_identity_digest,
      authority_epoch: authority.authority_epoch,
      authority_head_digest: authority.authority_head_digest,
      pin_digest: record.package_pin.pin_digest,
      authenticity_digest: record.authenticity_digest,
      package_cache_record_digest: record.record_digest,
    });
  }

  private readRecord(pinDigest: string): CapabilityPackageCacheRecordV1 {
    const record = validateCapabilityPackageCacheRecord(
      parseJsonFile(
        packageRecordCachePath(this.options.privateRoot, pinDigest),
        "package cache record",
      ),
    );
    if (
      record.package_pin.pin_digest !== pinDigest ||
      record.scope !== this.options.scope ||
      record.scope_identity_digest !== this.options.scopeIdentityDigest
    )
      throw new CapabilityValidationError(
        "package cache record belongs to another identity",
        "package_cache_record",
      );
    return record;
  }

  private readAuthenticity(
    record: CapabilityPackageCacheRecordV1,
    tree: PackageTreeV1,
    manifest: ValidatedCapabilityManifestV1,
  ): PackageAuthenticityBindingV1 {
    const stored = parseJsonFile<PackageAuthenticityBindingV1>(
      packageAuthenticityCachePath(this.options.privateRoot, record.authenticity_digest),
      "cached authenticity binding",
    );
    let verified = null;
    if (record.package_pin.source.kind === CAPABILITY_SOURCE_KIND.REGISTRY) {
      const digest = record.registry_envelope_digest as string;
      const envelope = parseJsonFile<RegistrySignatureEnvelopeV1>(
        packageRegistryEnvelopeCachePath(this.options.privateRoot, digest),
        "cached registry envelope",
      );
      if (!this.options.authorityTransitionResolver)
        throw new CapabilityValidationError(
          "durable action authority verifier is unavailable",
          "authority.transition",
          "integrity_failure",
        );
      const identityPath =
        this.options.scope === CAPABILITY_SCOPE.PROJECT
          ? join(dirname(dirname(this.options.privateRoot)), "PROJECT_ID.json")
          : join(this.options.privateRoot, "authority", "USER_IDENTITY.json");
      const trust = readDurableRegistryTrustSnapshot({
        private_root: this.options.privateRoot,
        identity_path: identityPath,
        scope: this.options.scope,
        scope_identity_digest: this.options.scopeIdentityDigest,
        authority_transition_resolver: this.options.authorityTransitionResolver,
      });
      verified = verifyRegistryEnvelope(envelope, {
        trust_snapshot: trust,
        at: this.#now(),
        mode: "resolution",
        expected: {
          registry_origin: record.package_pin.source.registry_origin,
          package_id: record.package_pin.id,
          version: record.package_pin.version,
          content_sha256: record.package_pin.content_sha256,
        },
      });
      if (verified.envelope_digest !== digest)
        throw new CapabilityValidationError(
          "registry envelope fixed path mismatch",
          "registry_envelope",
        );
      revalidateCachedRegistryPackagePin(record.package_pin, verified);
    } else if (record.package_pin.source.kind === CAPABILITY_SOURCE_KIND.LEGACY_ADOPT) {
      const evidence = parseJsonFile<LegacyInspectionEvidenceV1>(
        legacyInspectionEvidenceCachePath(
          this.options.privateRoot,
          record.legacy_inspection_evidence_digest as string,
        ),
        "legacy inspection evidence",
      );
      if (evidence.evidence_digest !== record.legacy_inspection_evidence_digest)
        throw new CapabilityValidationError(
          "legacy inspection evidence digest mismatch",
          "legacy_evidence",
        );
      revalidateCachedLegacyAdoptPackagePin(record.package_pin, {
        manifest,
        tree,
        evidence,
      });
    }
    const expected = createAuthenticityBinding(
      record.package_pin,
      record.manifest_digest,
      verified,
    );
    if (
      canonicalJson(stored) !== canonicalJson(expected) ||
      expected.authenticity_digest !== record.authenticity_digest
    )
      throw new CapabilityValidationError(
        "cached authenticity binding is not validator-derived",
        "authenticity",
        "integrity_failure",
      );
    if (!canonicalJsonBytes(stored).equals(canonicalJsonBytes(expected)))
      throw new CapabilityValidationError(
        "cached authenticity bytes are not canonical",
        "authenticity",
      );
    return expected;
  }
}
