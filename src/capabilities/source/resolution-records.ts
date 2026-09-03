import {
  CAPABILITY_MANIFEST_PLATFORM_ARCHES,
  CAPABILITY_MANIFEST_PLATFORM_LIBCS,
  CAPABILITY_MANIFEST_PLATFORM_OS,
  CAPABILITY_MANIFEST_PLATFORM_OSES,
} from "../../actions/capability-manifest-vocabulary-contract.js";
import {
  CAPABILITY_REGISTRY_ENVELOPE_STATUS,
  CAPABILITY_SOURCE_KIND,
} from "../../actions/capability-security-contract.js";
import type { EngineName } from "../../actions/types.js";
import { ENGINES } from "../../core/agent-contract.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import type {
  CapabilityConflictV1,
  CapabilityDependencyV1,
  PlatformConstraintV1,
  ValidatedCapabilityManifestV1,
} from "../manifest/types.js";
import {
  assertValidatedCapabilityManifest,
  parseCapabilityManifest,
} from "../manifest/validation.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  enumeration,
  exactKeys,
} from "../wire/primitives.js";
import { assertVerifiedRegistryPackagePin, validateImmutablePackagePin } from "./pins.js";
import { assertSignatureVerifiedRegistryEnvelope } from "./registry.js";
import { parseSemver, versionSatisfiesRange } from "./semver.js";
import { assertValidatedPackageTree } from "./tree.js";
import type { PackageTreeV1 } from "./tree.js";
import type { PackagePinV1 } from "./types.js";

export interface ResolutionCompatibilityContextV1 {
  vf_version: string;
  engines: Array<{ engine: EngineName; version: string }>;
  platform: PlatformConstraintV1;
}

export interface ValidatedResolutionCompatibilityV1 {
  schema_version: "1.0";
  manifest_digest: string;
  context: ResolutionCompatibilityContextV1;
  compatibility_digest: string;
}

export interface ResolutionCandidateV1 {
  source_identity: string;
  pin: PackagePinV1;
  manifest_digest: string;
  package_tree_record_digest: string;
  compatibility_digest: string;
  dependencies: CapabilityDependencyV1[];
  conflicts: CapabilityConflictV1[];
  candidate_digest: string;
}

const COMPATIBILITY_RECORDS = new WeakSet<object>();
const RESOLUTION_CANDIDATES = new WeakSet<object>();
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function validatePlatform(platform: PlatformConstraintV1): void {
  exactKeys(platform, ["os", "arch", "libc"], [], "compatibility.platform");
  enumeration(platform.os, CAPABILITY_MANIFEST_PLATFORM_OSES, "compatibility.platform.os");
  enumeration(platform.arch, CAPABILITY_MANIFEST_PLATFORM_ARCHES, "compatibility.platform.arch");
  if (platform.os === CAPABILITY_MANIFEST_PLATFORM_OS.LINUX) {
    if (platform.libc !== null && !CAPABILITY_MANIFEST_PLATFORM_LIBCS.includes(platform.libc))
      throw new CapabilityValidationError("unsupported Linux libc", "compatibility.platform.libc");
  } else if (platform.libc !== null)
    throw new CapabilityValidationError(
      "libc is only legal on Linux",
      "compatibility.platform.libc",
    );
}

export function createResolutionCompatibilityRecord(
  manifestRecord: ValidatedCapabilityManifestV1,
  context: ResolutionCompatibilityContextV1,
): ValidatedResolutionCompatibilityV1 {
  assertValidatedCapabilityManifest(manifestRecord);
  exactKeys(context, ["vf_version", "engines", "platform"], [], "compatibility.context");
  parseSemver(context.vf_version);
  if (!Array.isArray(context.engines) || context.engines.length === 0 || context.engines.length > 5)
    throw new CapabilityValidationError(
      "resolution engine set is out of bounds",
      "compatibility.engines",
    );
  for (const [index, row] of context.engines.entries()) {
    exactKeys(row, ["engine", "version"], [], `compatibility.engines[${index}]`);
    enumeration(row.engine, ENGINES, `compatibility.engines[${index}].engine`);
    parseSemver(row.version);
  }
  assertSortedUnique(
    context.engines,
    (a, b) => bytewise(a.engine, b.engine),
    "compatibility.engines",
  );
  validatePlatform(context.platform);
  const declared = manifestRecord.manifest.compatibility;
  if (!versionSatisfiesRange(context.vf_version, declared.vf))
    throw new CapabilityValidationError(
      "package is incompatible with the selected VF version",
      "compatibility.vf",
    );
  for (const row of context.engines) {
    const range = declared.engines[row.engine];
    if (!range || !versionSatisfiesRange(row.version, range))
      throw new CapabilityValidationError(
        "package is incompatible with a selected engine",
        `compatibility.engines.${row.engine}`,
      );
  }
  if (
    declared.platforms &&
    !declared.platforms.some(
      (item) =>
        item.os === context.platform.os &&
        item.arch === context.platform.arch &&
        item.libc === context.platform.libc,
    )
  )
    throw new CapabilityValidationError(
      "package is incompatible with the selected platform",
      "compatibility.platform",
    );
  const draft = {
    schema_version: "1.0" as const,
    manifest_digest: manifestRecord.manifest_digest,
    context: structuredClone(context),
  };
  const result = deepFreeze({
    ...draft,
    compatibility_digest: digestV1("VF-RESOLUTION-COMPATIBILITY\0v1\0", draft),
  });
  COMPATIBILITY_RECORDS.add(result);
  return result;
}

function sourceIdentity(pin: PackagePinV1): string {
  if (pin.source.kind === CAPABILITY_SOURCE_KIND.REGISTRY)
    return `${CAPABILITY_SOURCE_KIND.REGISTRY}:${pin.source.registry_origin}`;
  if (pin.source.kind === CAPABILITY_SOURCE_KIND.GIT)
    return `${CAPABILITY_SOURCE_KIND.GIT}:${pin.source.canonical_url}`;
  if (pin.source.kind === CAPABILITY_SOURCE_KIND.LOCAL_DEV)
    return `${CAPABILITY_SOURCE_KIND.LOCAL_DEV}:${pin.source.repo_relative_alias}`;
  return `legacy:${pin.source.legacy_source}:${pin.source.inspection_evidence_digest}`;
}

export function createResolutionCandidate(input: {
  pin: PackagePinV1;
  manifest_record: ValidatedCapabilityManifestV1;
  package_tree: PackageTreeV1;
  compatibility: ValidatedResolutionCompatibilityV1;
}): ResolutionCandidateV1 {
  const pin = validateImmutablePackagePin(input.pin);
  if (pin.source.kind === CAPABILITY_SOURCE_KIND.REGISTRY) {
    const verification = assertVerifiedRegistryPackagePin(pin);
    const authority = assertSignatureVerifiedRegistryEnvelope(verification);
    if (
      authority.mode !== "resolution" ||
      verification.status !== CAPABILITY_REGISTRY_ENVELOPE_STATUS.VERIFIED
    )
      throw new CapabilityValidationError(
        "registry resolution candidate lacks current resolution authority",
        "resolution_candidate.pin",
      );
  }
  assertValidatedCapabilityManifest(input.manifest_record);
  const tree = assertValidatedPackageTree(input.package_tree);
  if (!COMPATIBILITY_RECORDS.has(input.compatibility))
    throw new CapabilityValidationError(
      "compatibility record is not validator-derived",
      "compatibility",
    );
  const manifestBytes = tree.files.get("capability.json");
  if (!manifestBytes || !Buffer.from(manifestBytes).equals(input.manifest_record.source_bytes))
    throw new CapabilityValidationError(
      "manifest source bytes do not equal the package tree",
      "manifest_record",
    );
  const reparsed = parseCapabilityManifest(manifestBytes, tree.files);
  if (
    reparsed.manifest_digest !== input.manifest_record.manifest_digest ||
    canonicalJson(reparsed.manifest) !== canonicalJson(input.manifest_record.manifest) ||
    pin.id !== reparsed.manifest.id ||
    pin.version !== reparsed.manifest.version ||
    pin.content_sha256 !== tree.content_sha256
  )
    throw new CapabilityValidationError(
      "pin, tree, and validated manifest identities disagree",
      "resolution_candidate",
      "integrity_failure",
    );
  const expectedCompatibility = createResolutionCompatibilityRecord(
    reparsed,
    input.compatibility.context,
  );
  if (expectedCompatibility.compatibility_digest !== input.compatibility.compatibility_digest)
    throw new CapabilityValidationError(
      "compatibility record does not bind this manifest",
      "compatibility",
    );
  const packageTreeRecord = {
    schema_version: "1.0" as const,
    content_sha256: tree.content_sha256,
    entry_count: tree.entry_count,
    expanded_byte_length: tree.expanded_byte_length,
  };
  const draft = {
    source_identity: sourceIdentity(pin),
    pin,
    manifest_digest: reparsed.manifest_digest,
    package_tree_record_digest: digestV1("VF-PACKAGE-TREE-RECORD\0v1\0", packageTreeRecord),
    compatibility_digest: expectedCompatibility.compatibility_digest,
    dependencies: structuredClone(reparsed.manifest.dependencies),
    conflicts: structuredClone(reparsed.manifest.conflicts),
  };
  const result = deepFreeze({
    ...draft,
    candidate_digest: digestV1("VF-RESOLUTION-CANDIDATE\0v1\0", draft),
  });
  RESOLUTION_CANDIDATES.add(result);
  return result;
}

export function assertValidatedResolutionCandidate(
  value: ResolutionCandidateV1,
): ResolutionCandidateV1 {
  if (!RESOLUTION_CANDIDATES.has(value))
    throw new CapabilityValidationError(
      "resolution candidate is not built from validated records",
      "resolution_candidate",
    );
  return value;
}
