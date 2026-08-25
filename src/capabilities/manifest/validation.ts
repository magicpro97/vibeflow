import { parseStrictJson } from "../../actions/strict-json.js";
import type { EngineName } from "../../actions/types.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import { validateManifestPermission } from "../permissions/scope.js";
import { parseSemver, validateVersionRange } from "../source/semver.js";
import { assertCanonicalHttpsUrl } from "../source/url.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  exactKeys,
  integer,
  localId,
  packageId,
  rawSha256,
  text,
} from "../wire/primitives.js";
import { validateComponent } from "./component-validation.js";
import type {
  CapabilityComponentV1,
  CapabilityConflictV1,
  CapabilityDependencyV1,
  CapabilityInputDeclarationV1,
  CapabilityManifestV1,
  PlatformConstraintV1,
  ValidatedCapabilityManifestV1,
} from "./types.js";
import { inTreePath, validateInputDeclaration, verifyFile } from "./validation-helpers.js";

const ENGINES: EngineName[] = ["claude", "codex", "copilot", "opencode", "antigravity"];
const VALIDATED_MANIFESTS = new WeakSet<object>();

function assertExactManifestShapes(manifest: CapabilityManifestV1): void {
  exactKeys(
    manifest,
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
    "$",
  );
  exactKeys(
    manifest.metadata,
    ["display_name", "summary", "homepage_url", "documentation_url", "icon"],
    [],
    "$.metadata",
  );
  exactKeys(manifest.compatibility, ["vf", "engines"], ["platforms"], "$.compatibility");
  manifest.components.forEach((component, index) => {
    const common = ["type", "component_id", "targets", "required"];
    const fields: Record<string, string[]> = {
      skill: ["bundle_path", "bundle_sha256"],
      mcp: ["transport", "executable", "args", "url", "secret_slots"],
      tool: ["installer", "expected_binary", "version_constraint"],
      hook: ["event", "vf_handler_id"],
      role: ["role_spec_path", "role_spec_sha256"],
      "engine-setting": ["setting_id", "value"],
    };
    const extra = fields[component.type];
    if (!extra)
      throw new CapabilityValidationError("unknown component type", `$.components[${index}].type`);
    const optional = component.type === "mcp" ? ["executable", "args", "url", "secret_slots"] : [];
    exactKeys(
      component,
      [...common, ...extra.filter((key) => !optional.includes(key))],
      optional,
      `$.components[${index}]`,
    );
  });
  manifest.dependencies.forEach((value, index) =>
    exactKeys(
      value,
      ["package_id", "version_range", "required_scope"],
      [],
      `$.dependencies[${index}]`,
    ),
  );
  manifest.conflicts.forEach((value, index) =>
    exactKeys(value, ["package_id", "version_range", "reason"], [], `$.conflicts[${index}]`),
  );
  manifest.permissions.forEach((value, index) =>
    exactKeys(
      value,
      ["permission_id", "required_enforcement", "kind", "scope"],
      [],
      `$.permissions[${index}]`,
    ),
  );
  manifest.inputs.forEach((value, index) =>
    exactKeys(
      value,
      [
        "input_id",
        "label",
        "type",
        "required",
        "default_value",
        "enum_values",
        "min",
        "max",
        "pattern",
      ],
      [],
      `$.inputs[${index}]`,
    ),
  );
  manifest.health.forEach((value, index) =>
    exactKeys(
      value,
      ["probe_id", "component_ids", "kind", "required", "timeout_ms", "retries"],
      [],
      `$.health[${index}]`,
    ),
  );
}

function validateMetadata(
  manifest: CapabilityManifestV1,
  files: ReadonlyMap<string, Uint8Array>,
): void {
  const metadata = manifest.metadata;
  text(metadata.display_name, "$.metadata.display_name", { min: 1, max: 256 });
  text(metadata.summary, "$.metadata.summary", { min: 1, max: 8_192 });
  for (const field of ["homepage_url", "documentation_url"] as const) {
    const value = metadata[field];
    if (value !== null)
      assertCanonicalHttpsUrl(text(value, `$.metadata.${field}`, { max: 2_048, ascii: true }));
  }
  if (metadata.icon === null) return;
  exactKeys(metadata.icon, ["relative_path", "sha256", "media_type"], [], "$.metadata.icon");
  const relative = inTreePath(metadata.icon.relative_path, "$.metadata.icon.relative_path");
  const bytes = verifyFile(files, relative, metadata.icon.sha256, "$.metadata.icon", 256 * 1024);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const valid =
    metadata.icon.media_type === "image/png"
      ? bytes.byteLength >= 24 && Buffer.from(bytes.subarray(0, 8)).equals(png)
      : metadata.icon.media_type === "image/webp" &&
        bytes.byteLength >= 16 &&
        Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
        Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  if (!valid)
    throw new CapabilityValidationError(
      "icon bytes do not match the declared safe media type",
      "$.metadata.icon",
    );
}

function validatePlatforms(platforms: PlatformConstraintV1[] | undefined): void {
  if (platforms === undefined) return;
  if (!Array.isArray(platforms) || platforms.length === 0 || platforms.length > 64)
    throw new CapabilityValidationError(
      "platform list is out of bounds",
      "$.compatibility.platforms",
    );
  for (const [index, platform] of platforms.entries()) {
    exactKeys(platform, ["os", "arch", "libc"], [], `$.compatibility.platforms[${index}]`);
    if (
      !["darwin", "linux", "win32"].includes(platform.os) ||
      !["arm64", "x64"].includes(platform.arch)
    )
      throw new CapabilityValidationError(
        "unsupported platform tuple",
        `$.compatibility.platforms[${index}]`,
      );
    if (
      platform.os === "linux"
        ? ![null, "glibc", "musl"].includes(platform.libc)
        : platform.libc !== null
    )
      throw new CapabilityValidationError(
        "libc is invalid for platform",
        `$.compatibility.platforms[${index}].libc`,
      );
  }
  assertSortedUnique(
    platforms,
    (a, b) =>
      bytewise(`${a.os}\0${a.arch}\0${a.libc ?? ""}`, `${b.os}\0${b.arch}\0${b.libc ?? ""}`),
    "$.compatibility.platforms",
  );
}

function validateCompatibility(manifest: CapabilityManifestV1): void {
  validateVersionRange(manifest.compatibility.vf);
  const engines = exactKeys(manifest.compatibility.engines, [], ENGINES, "$.compatibility.engines");
  for (const [engine, range] of Object.entries(engines))
    validateVersionRange(
      text(range, `$.compatibility.engines.${engine}`, { max: 256, ascii: true }),
    );
  const used = [...new Set(manifest.components.flatMap((component) => component.targets))].sort(
    bytewise,
  );
  const declared = Object.keys(engines).sort(bytewise);
  if (JSON.stringify(used) !== JSON.stringify(declared))
    throw new CapabilityValidationError(
      "engine compatibility keys must exactly cover component targets",
      "$.compatibility.engines",
    );
  validatePlatforms(manifest.compatibility.platforms);
}

function validateDependencies(values: CapabilityDependencyV1[], manifestId: string): void {
  for (const [index, dependency] of values.entries()) {
    packageId(dependency.package_id, `$.dependencies[${index}].package_id`);
    if (dependency.package_id === manifestId)
      throw new CapabilityValidationError(
        "self dependency is forbidden",
        `$.dependencies[${index}]`,
      );
    validateVersionRange(dependency.version_range);
    if (!["same", "user-prerequisite"].includes(dependency.required_scope))
      throw new CapabilityValidationError(
        "invalid dependency scope",
        `$.dependencies[${index}].required_scope`,
      );
  }
  assertSortedUnique(
    values,
    (a, b) =>
      bytewise(
        `${a.required_scope}\0${a.package_id}\0${a.version_range}`,
        `${b.required_scope}\0${b.package_id}\0${b.version_range}`,
      ),
    "$.dependencies",
  );
}

function validateConflicts(values: CapabilityConflictV1[]): void {
  for (const [index, conflict] of values.entries()) {
    packageId(conflict.package_id, `$.conflicts[${index}].package_id`);
    if (conflict.version_range !== null) validateVersionRange(conflict.version_range);
    text(conflict.reason, `$.conflicts[${index}].reason`, { min: 1, max: 8_192 });
  }
  assertSortedUnique(
    values,
    (a, b) =>
      bytewise(
        `${a.package_id}\0${a.version_range ?? ""}\0${a.reason}`,
        `${b.package_id}\0${b.version_range ?? ""}\0${b.reason}`,
      ),
    "$.conflicts",
  );
}

function validateInputs(
  values: CapabilityInputDeclarationV1[],
): Map<string, CapabilityInputDeclarationV1> {
  values.forEach((value, index) => validateInputDeclaration(value, `$.inputs[${index}]`));
  assertSortedUnique(values, (a, b) => bytewise(a.input_id, b.input_id), "$.inputs");
  return new Map(values.map((value) => [value.input_id, value]));
}

function validateHealth(manifest: CapabilityManifestV1, components: ReadonlySet<string>): void {
  for (const [index, health] of manifest.health.entries()) {
    localId(health.probe_id, `$.health[${index}].probe_id`);
    if (!Array.isArray(health.component_ids) || health.component_ids.length === 0)
      throw new CapabilityValidationError(
        "health component set is empty",
        `$.health[${index}].component_ids`,
      );
    assertSortedUnique(health.component_ids, bytewise, `$.health[${index}].component_ids`);
    if (health.component_ids.some((id) => !components.has(id)))
      throw new CapabilityValidationError(
        "health references an unknown component",
        `$.health[${index}].component_ids`,
      );
    if (
      ![
        "binary-version",
        "file-hash",
        "mcp-handshake",
        "hook-selftest",
        "role-parse",
        "engine-config",
      ].includes(health.kind)
    )
      throw new CapabilityValidationError("unknown health probe kind", `$.health[${index}].kind`);
    if (typeof health.required !== "boolean" || ![0, 1, 2].includes(health.retries))
      throw new CapabilityValidationError(
        "invalid health requirement/retry fields",
        `$.health[${index}]`,
      );
    integer(health.timeout_ms, `$.health[${index}].timeout_ms`, 1, 30_000);
  }
  assertSortedUnique(manifest.health, (a, b) => bytewise(a.probe_id, b.probe_id), "$.health");
}

export function validateCapabilityManifest(
  manifest: CapabilityManifestV1,
  files: ReadonlyMap<string, Uint8Array>,
): CapabilityManifestV1 {
  assertExactManifestShapes(manifest);
  if (manifest.schema_version !== "1.0")
    throw new CapabilityValidationError(
      "unsupported manifest schema",
      "$.schema_version",
      "unsupported_schema_version",
    );
  const id = packageId(manifest.id, "$.id");
  parseSemver(text(manifest.version, "$.version", { min: 1, max: 128, ascii: true }));
  if (
    manifest.components.length === 0 ||
    manifest.components.length > 256 ||
    manifest.dependencies.length > 256 ||
    manifest.conflicts.length > 256 ||
    manifest.permissions.length > 512 ||
    manifest.inputs.length > 128 ||
    manifest.health.length > 64
  )
    throw new CapabilityValidationError("manifest collection exceeds bounds", "$", "bounds");
  validateMetadata(manifest, files);
  const inputs = validateInputs(manifest.inputs);
  const refs: Array<{ id: string; path: string }> = [];
  manifest.components.forEach((component, index) =>
    validateComponent(component, `$.components[${index}]`, files, inputs, refs),
  );
  assertSortedUnique(
    manifest.components,
    (a, b) => bytewise(a.component_id, b.component_id),
    "$.components",
  );
  const componentIds = new Set(manifest.components.map((component) => component.component_id));
  for (const ref of refs) {
    const declaration = inputs.get(ref.id);
    if (!declaration)
      throw new CapabilityValidationError("template references an undeclared input", ref.path);
    if (declaration.type === "secret-handle")
      throw new CapabilityValidationError(
        "secret handles may only be delivered through MCP secret_slots",
        ref.path,
      );
  }
  validateCompatibility(manifest);
  validateDependencies(manifest.dependencies, id);
  validateConflicts(manifest.conflicts);
  manifest.permissions.forEach((permission, index) =>
    validateManifestPermission(permission, id, `$.permissions[${index}]`),
  );
  assertSortedUnique(
    manifest.permissions,
    (a, b) => bytewise(a.permission_id, b.permission_id),
    "$.permissions",
  );
  validateHealth(manifest, componentIds);
  canonicalJsonBytes(manifest, { maxBytes: 512 * 1024 });
  return structuredClone(manifest);
}

export function parseCapabilityManifest(
  sourceBytes: Uint8Array,
  files: ReadonlyMap<string, Uint8Array>,
): ValidatedCapabilityManifestV1 {
  if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > 512 * 1024)
    throw new CapabilityValidationError("manifest byte size is out of bounds", "$", "bounds");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  } catch {
    throw new CapabilityValidationError("manifest is not strict UTF-8", "$", "invalid_capability");
  }
  if (source.startsWith("\uFEFF"))
    throw new CapabilityValidationError("UTF-8 BOM is forbidden", "$", "invalid_capability");
  const parsed = parseStrictJson(source) as unknown as CapabilityManifestV1;
  const manifest = validateCapabilityManifest(parsed, files);
  const canonicalBytes = canonicalJsonBytes(manifest, { maxBytes: 512 * 1024 });
  const result = {
    manifest,
    manifest_digest: digestV1("VF-CAPABILITY-MANIFEST\0v1\0", manifest),
    canonical_bytes: canonicalBytes,
    source_bytes: Buffer.from(sourceBytes),
  };
  VALIDATED_MANIFESTS.add(result);
  return result;
}

export function assertValidatedCapabilityManifest(
  value: ValidatedCapabilityManifestV1,
): ValidatedCapabilityManifestV1 {
  if (!VALIDATED_MANIFESTS.has(value))
    throw new CapabilityValidationError(
      "manifest record is not parser-validated",
      "manifest_record",
    );
  return value;
}
