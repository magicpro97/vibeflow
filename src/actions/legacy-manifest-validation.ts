import { canonicalJsonBytes, digestHex, digestV1 } from "../durability/index.js";
import type {
  LegacyDependencyBindingV1,
  LegacyEngineV1,
  LegacyManifestDependencyV1,
  StrictLegacyAdoptCandidateV1,
} from "./legacy-adopt-types.js";
import { validateLegacyComponents, validateLegacyHealth } from "./legacy-component-validation.js";
import {
  isCanonicalSemver,
  isCanonicalVersionRange,
  versionSatisfiesRange,
} from "./package-pin-validation.js";
import { validateManifestPermission } from "./permission-validation.js";
import { targetId } from "./proposal-content-validation.js";
import { assertDigest, assertPackageId, assertRawSha256, bytewise } from "./record-primitives.js";
import { ActionValidationError, exactObject } from "./strict-json.js";

const ENGINES = ["claude", "codex", "copilot", "opencode", "antigravity"] as const;

export function validateLegacyManifestClosure(
  candidate: StrictLegacyAdoptCandidateV1,
  path: string,
): void {
  const manifest = exactObject(
    candidate.synthetic_manifest,
    [
      "schema_version",
      "id",
      "version",
      "metadata",
      "compatibility",
      "components",
      "dependencies",
      "conflicts",
      "permissions",
      "inputs",
      "health",
    ],
    [],
    `${path}.synthetic_manifest`,
  );
  if (
    manifest.schema_version !== "1.0" ||
    manifest.id !== candidate.synthetic_pin.id ||
    manifest.version !== candidate.synthetic_pin.version
  )
    invalid("synthetic manifest identity mismatch", `${path}.synthetic_manifest`);
  const packageId = assertPackageId(manifest.id, `${path}.synthetic_manifest.id`);
  validateManagedPackageId(packageId, candidate.legacy_source, manifest.components, path);
  validateMetadata(manifest.metadata, packageId, path);
  const component = validateLegacyComponents(
    manifest.components,
    candidate.legacy_source,
    `${path}.synthetic_manifest.components`,
  );
  validateCompatibility(manifest.compatibility, component.targets, path);
  const manifestDependencies = validateManifestDependencies(
    manifest.dependencies,
    packageId,
    `${path}.synthetic_manifest.dependencies`,
  );
  validateDependencyProjection(
    candidate.dependencies,
    manifestDependencies,
    `${path}.dependencies`,
  );
  if (!Array.isArray(manifest.conflicts) || manifest.conflicts.length !== 0)
    invalid(
      "legacy Adopt manifest conflicts must be empty",
      `${path}.synthetic_manifest.conflicts`,
    );
  if (!Array.isArray(manifest.inputs) || manifest.inputs.length !== 0)
    invalid("legacy Adopt manifest inputs must be empty", `${path}.synthetic_manifest.inputs`);
  validatePermissionProjection(
    manifest.permissions,
    candidate.permissions,
    packageId,
    candidate.scope,
    path,
  );
  validateLegacyHealth(
    manifest.health,
    component,
    candidate.legacy_source,
    `${path}.synthetic_manifest.health`,
  );
  validateTargetProjection(
    candidate,
    component.component_id,
    component.targets,
    component.required,
    path,
  );
  const { version: _version, ...syntheticManifestWithoutVersion } = manifest;
  const versionDigest = digestV1("VF-LEGACY-ADOPT-VERSION\0v1\0", {
    legacy_source: candidate.legacy_source,
    synthetic_manifest_without_version: syntheticManifestWithoutVersion,
    owned_resources: candidate.owned_resources,
    inspection_evidence_digest: candidate.inspection_evidence_digest,
  });
  const expectedVersion = `0.0.0-legacy.${digestHex(versionDigest).slice(0, 12)}`;
  if (candidate.synthetic_pin.version !== expectedVersion)
    invalid("synthetic version derivation mismatch", `${path}.synthetic_pin.version`);
}

function validateMetadata(value: unknown, packageId: string, path: string): void {
  const metadata = exactObject(
    value,
    ["display_name", "summary", "homepage_url", "documentation_url", "icon"],
    [],
    `${path}.synthetic_manifest.metadata`,
  );
  if (
    metadata.display_name !== packageId ||
    metadata.summary !== "Imported VF-managed legacy capability" ||
    metadata.homepage_url !== null ||
    metadata.documentation_url !== null ||
    metadata.icon !== null
  )
    invalid(
      "synthetic manifest metadata is not deterministic",
      `${path}.synthetic_manifest.metadata`,
    );
}

function validateCompatibility(value: unknown, targets: LegacyEngineV1[], path: string): void {
  const compatibility = exactObject(
    value,
    ["vf", "engines"],
    ["platforms"],
    `${path}.synthetic_manifest.compatibility`,
  );
  if (typeof compatibility.vf !== "string" || !isCanonicalVersionRange(compatibility.vf))
    invalid("invalid VF compatibility range", `${path}.synthetic_manifest.compatibility.vf`);
  const engines = exactObject(
    compatibility.engines,
    [],
    [...ENGINES],
    `${path}.synthetic_manifest.compatibility.engines`,
  );
  const keys = Object.keys(engines).sort(bytewise);
  if (!canonicalJsonBytes(keys).equals(canonicalJsonBytes([...targets].sort(bytewise))))
    invalid(
      "compatibility engines do not exactly match component targets",
      `${path}.synthetic_manifest.compatibility`,
    );
  for (const engine of keys)
    if (typeof engines[engine] !== "string" || !isCanonicalVersionRange(engines[engine] as string))
      invalid(
        "invalid engine compatibility range",
        `${path}.synthetic_manifest.compatibility.engines.${engine}`,
      );
  if (compatibility.platforms !== undefined)
    validatePlatforms(
      compatibility.platforms,
      `${path}.synthetic_manifest.compatibility.platforms`,
    );
}

function validatePlatforms(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length > 16)
    invalid("platform constraints exceed bound", path);
  const identities = value.map((item, index) => {
    const row = exactObject(item, ["os", "arch", "libc"], [], `${path}[${index}]`);
    if (!["darwin", "linux", "win32"].includes(row.os as string))
      invalid("invalid platform OS", `${path}[${index}].os`);
    if (!["arm64", "x64"].includes(row.arch as string))
      invalid("invalid platform architecture", `${path}[${index}].arch`);
    if (row.libc !== null && !["glibc", "musl"].includes(row.libc as string))
      invalid("invalid platform libc", `${path}[${index}].libc`);
    if (row.os !== "linux" && row.libc !== null)
      invalid("non-Linux platform cannot select libc", `${path}[${index}].libc`);
    return `${row.os}\0${row.arch}\0${row.libc ?? ""}`;
  });
  ordered(identities, path);
}

function validateManifestDependencies(
  value: unknown,
  packageId: string,
  path: string,
): LegacyManifestDependencyV1[] {
  if (!Array.isArray(value) || value.length > 256)
    invalid("manifest dependencies exceed bound", path);
  const dependencies = value.map((item, index) => {
    const row = exactObject(
      item,
      ["package_id", "version_range", "required_scope"],
      [],
      `${path}[${index}]`,
    );
    const dependencyId = assertPackageId(row.package_id, `${path}[${index}].package_id`);
    if (dependencyId === packageId)
      invalid("legacy package depends on itself", `${path}[${index}]`);
    if (typeof row.version_range !== "string" || !isCanonicalVersionRange(row.version_range))
      invalid("invalid dependency version range", `${path}[${index}].version_range`);
    if (!["same", "user-prerequisite"].includes(row.required_scope as string))
      invalid("invalid dependency required scope", `${path}[${index}].required_scope`);
    return item as LegacyManifestDependencyV1;
  });
  ordered(
    dependencies.map((row) => `${row.required_scope}\0${row.package_id}\0${row.version_range}`),
    path,
  );
  if (new Set(dependencies.map((row) => row.package_id)).size !== dependencies.length)
    invalid("manifest dependency package is duplicated", path);
  return dependencies;
}

function validateDependencyProjection(
  value: unknown,
  manifest: LegacyManifestDependencyV1[],
  path: string,
): void {
  if (!Array.isArray(value) || value.length !== manifest.length)
    invalid("candidate dependency projection length mismatch", path);
  const bindings = value.map((item, index) => validateDependencyBinding(item, `${path}[${index}]`));
  ordered(
    bindings.map(
      (row) => `${row.required_scope}\0${row.package_id}\0${row.version}\0${row.content_sha256}`,
    ),
    path,
  );
  for (const [index, dependency] of manifest.entries()) {
    const binding = bindings[index];
    if (
      !binding ||
      binding.required_scope !== dependency.required_scope ||
      binding.package_id !== dependency.package_id ||
      !versionSatisfiesRange(binding.version, dependency.version_range)
    )
      invalid("candidate dependency does not resolve its manifest row", `${path}[${index}]`);
  }
}

function validateDependencyBinding(value: unknown, path: string): LegacyDependencyBindingV1 {
  const base = exactObject(
    value,
    ["required_scope", "package_id", "version", "content_sha256"],
    ["required_health_plan_digest"],
    path,
  );
  assertPackageId(base.package_id, `${path}.package_id`);
  if (typeof base.version !== "string" || !isCanonicalSemver(base.version))
    invalid("invalid resolved dependency version", `${path}.version`);
  assertRawSha256(base.content_sha256, `${path}.content_sha256`);
  if (base.required_scope === "same") {
    exactObject(value, ["required_scope", "package_id", "version", "content_sha256"], [], path);
  } else if (base.required_scope === "user-prerequisite") {
    exactObject(
      value,
      ["required_scope", "package_id", "version", "content_sha256", "required_health_plan_digest"],
      [],
      path,
    );
    assertDigest(base.required_health_plan_digest, `${path}.required_health_plan_digest`);
  } else invalid("invalid resolved dependency scope", `${path}.required_scope`);
  return value as LegacyDependencyBindingV1;
}

function validatePermissionProjection(
  manifestValue: unknown,
  candidateValue: unknown,
  packageId: string,
  scope: "project" | "user",
  path: string,
): void {
  if (!Array.isArray(manifestValue) || !Array.isArray(candidateValue) || manifestValue.length > 512)
    invalid("legacy permission arrays are invalid", `${path}.permissions`);
  const ids = manifestValue.map((item, index) =>
    validateManifestPermission(
      item,
      packageId,
      scope,
      `${path}.synthetic_manifest.permissions[${index}]`,
    ),
  );
  ordered(ids, `${path}.synthetic_manifest.permissions`);
  if (!canonicalJsonBytes(manifestValue).equals(canonicalJsonBytes(candidateValue)))
    invalid("synthetic permission projection mismatch", `${path}.permissions`);
}

function validateTargetProjection(
  candidate: StrictLegacyAdoptCandidateV1,
  componentId: string,
  engines: LegacyEngineV1[],
  required: boolean,
  path: string,
): void {
  const expected = engines
    .map((engine) => {
      const identity = {
        target: required
          ? {
              scope: candidate.scope,
              engine,
              participant_id: null,
              required: true as const,
              on_apply_failure: "abort-scope" as const,
              on_health_failure: "abort-scope" as const,
            }
          : {
              scope: candidate.scope,
              engine,
              participant_id: null,
              required: false as const,
              on_apply_failure: "omit-after-rollback" as const,
              on_health_failure: "omit-after-rollback" as const,
            },
        subject: {
          kind: "capability" as const,
          package_id: candidate.synthetic_pin.id,
          component_id: componentId,
        },
      };
      return { target_id: targetId(identity), ...identity };
    })
    .sort((left, right) => bytewise(left.target_id, right.target_id));
  if (!canonicalJsonBytes(candidate.targets).equals(canonicalJsonBytes(expected)))
    invalid("candidate target projection does not match manifest components", `${path}.targets`);
}

function validateManagedPackageId(
  packageId: string,
  source: StrictLegacyAdoptCandidateV1["legacy_source"],
  components: unknown,
  path: string,
): void {
  const row = Array.isArray(components) ? (components[0] as { targets?: unknown }) : null;
  const engine = Array.isArray(row?.targets) ? row.targets[0] : null;
  const prefix =
    source === "skill-lock"
      ? "legacy.skill."
      : source === "tool-managed-evidence"
        ? "legacy.tool."
        : source === "mcp-managed-sidecar"
          ? `legacy.mcp.${engine}.`
          : source === "hook-sentinel"
            ? `legacy.hook.${engine}.`
            : `legacy.role.${engine}.`;
  const managed = packageId.slice(prefix.length);
  const managedMatch = /^([a-z0-9]+(?:-[a-z0-9]+)*)-([a-f0-9]{64})$/.exec(managed);
  if (
    !packageId.startsWith(prefix) ||
    !managedMatch ||
    Buffer.byteLength(managedMatch[1] as string, "utf8") > 32
  )
    invalid("synthetic package ID does not match its legacy source", `${path}.synthetic_pin.id`);
}

function ordered(values: string[], path: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== [...values].sort(bytewise)[index])
  )
    invalid("array is duplicated or not canonical", path);
}

function invalid(message: string, path: string): never {
  throw new ActionValidationError(message, path);
}
