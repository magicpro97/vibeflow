import type { LegacySourceV1, LegacySyntheticComponentV1 } from "./legacy-adopt-types.js";
import { isCanonicalVersionRange } from "./package-pin-validation.js";
import { assertRawSha256, bytewise } from "./record-primitives.js";
import { ActionValidationError, boundedString, exactObject, safeInteger } from "./strict-json.js";

const ENGINES = new Set(["claude", "codex", "copilot", "opencode", "antigravity"]);
const LOCAL_ID = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const SOURCE_TYPE: Record<LegacySourceV1, LegacySyntheticComponentV1["type"]> = {
  "skill-lock": "skill",
  "tool-managed-evidence": "tool",
  "mcp-managed-sidecar": "mcp",
  "hook-sentinel": "hook",
  "role-marker": "role",
};
const HEALTH_KIND: Record<LegacySourceV1, string> = {
  "skill-lock": "file-hash",
  "tool-managed-evidence": "binary-version",
  "mcp-managed-sidecar": "mcp-handshake",
  "hook-sentinel": "hook-selftest",
  "role-marker": "role-parse",
};

export interface ValidatedLegacyComponentV1 {
  component_id: string;
  targets: LegacySyntheticComponentV1["targets"];
  required: boolean;
}

export function validateLegacyComponents(
  value: unknown,
  source: LegacySourceV1,
  path: string,
): ValidatedLegacyComponentV1 {
  if (!Array.isArray(value) || value.length !== 1)
    invalid("Adopt manifest must contain exactly one legacy component", path);
  const component = validateComponent(value[0], `${path}[0]`);
  if (component.type !== SOURCE_TYPE[source])
    invalid("legacy source and component type mismatch", `${path}[0].type`);
  return component;
}

export function validateLegacyHealth(
  value: unknown,
  component: ValidatedLegacyComponentV1,
  source: LegacySourceV1,
  path: string,
): void {
  if (!Array.isArray(value) || value.length !== 1)
    invalid("Adopt manifest must contain exactly one host-owned health probe", path);
  const row = exactObject(
    value[0],
    ["probe_id", "component_ids", "kind", "required", "timeout_ms", "retries"],
    [],
    `${path}[0]`,
  );
  localId(row.probe_id, `${path}[0].probe_id`);
  if (
    !Array.isArray(row.component_ids) ||
    row.component_ids.length !== 1 ||
    row.component_ids[0] !== component.component_id ||
    row.kind !== HEALTH_KIND[source] ||
    row.required !== component.required
  )
    invalid("legacy health probe does not bind its component", `${path}[0]`);
  const timeout = safeInteger(row.timeout_ms, `${path}[0].timeout_ms`, 1);
  if (timeout > 120_000) invalid("legacy health timeout exceeds bound", `${path}[0].timeout_ms`);
  if (![0, 1, 2].includes(row.retries as number))
    invalid("legacy health retry count is invalid", `${path}[0].retries`);
}

function validateComponent(value: unknown, path: string): LegacySyntheticComponentV1 {
  const base = exactObject(
    value,
    ["component_id", "type", "targets", "required"],
    [
      "bundle_path",
      "bundle_sha256",
      "transport",
      "executable",
      "args",
      "url",
      "secret_slots",
      "installer",
      "expected_binary",
      "version_constraint",
      "event",
      "vf_handler_id",
      "role_spec_path",
      "role_spec_sha256",
    ],
    path,
  );
  localId(base.component_id, `${path}.component_id`);
  if (typeof base.required !== "boolean") invalid("invalid component required flag", path);
  const targets = engineArray(base.targets, `${path}.targets`);
  if (targets.length !== 1) invalid("legacy component must name one real engine target", path);
  switch (base.type) {
    case "skill":
      exactObject(
        value,
        ["component_id", "type", "targets", "required", "bundle_path", "bundle_sha256"],
        [],
        path,
      );
      relativePath(base.bundle_path, `${path}.bundle_path`);
      assertRawSha256(base.bundle_sha256, `${path}.bundle_sha256`);
      break;
    case "mcp":
      validateMcp(value, base, path);
      break;
    case "tool":
      validateTool(value, base, path);
      break;
    case "hook":
      exactObject(
        value,
        ["component_id", "type", "targets", "required", "event", "vf_handler_id"],
        [],
        path,
      );
      if (!["pre-tool", "post-tool", "pre-commit", "pre-push"].includes(base.event as string))
        invalid("invalid legacy hook event", `${path}.event`);
      localId(base.vf_handler_id, `${path}.vf_handler_id`);
      break;
    case "role":
      exactObject(
        value,
        ["component_id", "type", "targets", "required", "role_spec_path", "role_spec_sha256"],
        [],
        path,
      );
      relativePath(base.role_spec_path, `${path}.role_spec_path`);
      assertRawSha256(base.role_spec_sha256, `${path}.role_spec_sha256`);
      break;
    default:
      invalid("invalid legacy component type", `${path}.type`);
  }
  return value as LegacySyntheticComponentV1;
}

function validateMcp(value: unknown, base: Record<string, unknown>, path: string): void {
  exactObject(
    value,
    ["component_id", "type", "targets", "required", "transport"],
    ["executable", "args", "url", "secret_slots"],
    path,
  );
  const slots = base.secret_slots ?? [];
  if (!Array.isArray(slots) || slots.length !== 0)
    invalid("legacy MCP cannot introduce secret inputs", `${path}.secret_slots`);
  if (base.transport === "stdio") {
    if (base.executable === undefined || base.url !== undefined)
      invalid("stdio MCP executable/url matrix mismatch", path);
    const executable = exactObject(
      base.executable,
      ["component_id", "relative_path", "sha256"],
      [],
      `${path}.executable`,
    );
    if (executable.component_id !== base.component_id)
      invalid("MCP executable component mismatch", `${path}.executable.component_id`);
    relativePath(executable.relative_path, `${path}.executable.relative_path`);
    assertRawSha256(executable.sha256, `${path}.executable.sha256`);
    const args = base.args ?? [];
    if (!Array.isArray(args) || args.length > 128)
      invalid("MCP argument list exceeds bound", `${path}.args`);
    args.forEach((arg, index) => canonicalText(arg, `${path}.args[${index}]`, 4_096));
  } else if (base.transport === "http" || base.transport === "sse") {
    if (base.url === undefined || base.executable !== undefined || base.args !== undefined)
      invalid("remote MCP URL/executable matrix mismatch", path);
    const url = canonicalText(base.url, `${path}.url`, 2_048);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      invalid("invalid legacy MCP URL", `${path}.url`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.href !== url)
      invalid("legacy MCP URL is not canonical HTTPS", `${path}.url`);
  } else invalid("invalid legacy MCP transport", `${path}.transport`);
}

function validateTool(value: unknown, base: Record<string, unknown>, path: string): void {
  exactObject(
    value,
    [
      "component_id",
      "type",
      "targets",
      "required",
      "installer",
      "expected_binary",
      "version_constraint",
    ],
    [],
    path,
  );
  const installer = exactObject(
    base.installer,
    ["kind", "coordinate", "version", "artifact_sha256", "lifecycle_scripts"],
    [],
    `${path}.installer`,
  );
  if (
    !["npm", "bun", "pipx", "uv", "go", "cargo", "download"].includes(installer.kind as string) ||
    installer.lifecycle_scripts !== "disabled"
  )
    invalid("legacy tool installer is invalid", `${path}.installer`);
  canonicalText(installer.coordinate, `${path}.installer.coordinate`, 1_024);
  canonicalText(installer.version, `${path}.installer.version`, 128);
  assertRawSha256(installer.artifact_sha256, `${path}.installer.artifact_sha256`);
  localId(base.expected_binary, `${path}.expected_binary`);
  const versionConstraint = canonicalText(
    base.version_constraint,
    `${path}.version_constraint`,
    128,
  );
  if (!isCanonicalVersionRange(versionConstraint))
    invalid("legacy tool version constraint is invalid", `${path}.version_constraint`);
}

function engineArray(value: unknown, path: string): LegacySyntheticComponentV1["targets"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5)
    invalid("invalid component targets", path);
  const values = value.map((item, index) => {
    if (!ENGINES.has(item as string)) invalid("invalid component engine", `${path}[${index}]`);
    return item as LegacySyntheticComponentV1["targets"][number];
  });
  ordered(values, path);
  return values;
}

function relativePath(value: unknown, path: string): void {
  const text = canonicalText(value, path, 1_024);
  const segments = text.split("/");
  if (
    text.startsWith("/") ||
    /^[A-Za-z]:/.test(text) ||
    text.includes("\\") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  )
    invalid("component path is not canonical relative", path);
}

function localId(value: unknown, path: string): string {
  const text = canonicalText(value, path, 64);
  if (!LOCAL_ID.test(text)) invalid("invalid local identifier", path);
  return text;
}

function canonicalText(value: unknown, path: string, max: number): string {
  const text = boundedString(value, path, { min: 1, max });
  if (text !== text.normalize("NFC")) invalid("text is not NFC", path);
  return text;
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
