import { digestV1 } from "../durability/index.js";
import { assertDigest, assertOpaqueId, assertTimestamp, bytewise } from "./record-primitives.js";
import { HOST_ACTION_KINDS } from "./request-types.js";
import { ActionValidationError, boundedString, exactObject, safeInteger } from "./strict-json.js";

const ENGINES = new Set(["claude", "codex", "copilot", "opencode", "antigravity"]);
const LOCAL_ID = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;

export function validateGrantInput(value: unknown, path: string): void {
  const row = exactObject(
    value,
    ["scope", "principal_id", "action_types", "permissions", "target_engines", "expires_at"],
    [],
    path,
  );
  if (row.scope !== "project" && row.scope !== "user")
    invalid("invalid grant scope", `${path}.scope`);
  assertOpaqueId(row.principal_id, `${path}.principal_id`);
  const actionTypes = stringArray(row.action_types, `${path}.action_types`, { min: 1 });
  for (const action of actionTypes)
    if (action !== "capability.discover" && !HOST_ACTION_KINDS.has(action as never))
      invalid("unsupported grant action type", `${path}.action_types`);
  const permissions = array(row.permissions, `${path}.permissions`, 512).map((item, index) =>
    validateGrantedPermission(
      item,
      row.scope as "project" | "user",
      `${path}.permissions[${index}]`,
    ),
  );
  orderedUnique(
    permissions.map((permission) => `${permission.permission_id}\0${permission.binding_digest}`),
    `${path}.permissions`,
  );
  const targetEngines = stringArray(row.target_engines, `${path}.target_engines`);
  for (const engine of targetEngines)
    if (!ENGINES.has(engine)) invalid("invalid grant target engine", `${path}.target_engines`);
  assertTimestamp(row.expires_at, `${path}.expires_at`);
}

interface ValidatedPermission {
  permission_id: string;
  binding_digest: string;
}

export function validateManifestPermission(
  value: unknown,
  packageId: string,
  installScope: "project" | "user",
  path: string,
): string {
  const row = exactObject(
    value,
    ["permission_id", "kind", "scope", "required_enforcement"],
    [],
    path,
  );
  const permissionId = boundedString(row.permission_id, `${path}.permission_id`, {
    min: 3,
    max: 193,
  });
  const prefix = `${packageId}/`;
  if (!permissionId.startsWith(prefix))
    invalid("manifest permission is outside its package namespace", `${path}.permission_id`);
  localId(permissionId.slice(prefix.length), `${path}.permission_id`);
  if (permissionId.startsWith("vf.source/"))
    invalid("reserved source permission ID", `${path}.permission_id`);
  if (
    !["brokered", "sandboxed", "engine-enforced", "disclosed-not-enforced"].includes(
      row.required_enforcement as string,
    )
  )
    invalid("invalid manifest permission enforcement", `${path}.required_enforcement`);
  validatePermissionScope(row.kind, row.scope, installScope, `${path}.scope`);
  return permissionId;
}

function validateGrantedPermission(
  value: unknown,
  grantScope: "project" | "user",
  path: string,
): ValidatedPermission {
  const row = exactObject(
    value,
    [
      "schema_version",
      "permission_id",
      "kind",
      "scope",
      "target_ids",
      "enforcement",
      "binding_digest",
    ],
    [],
    path,
  );
  if (row.schema_version !== "1.0") invalid("unsupported permission version", path);
  const permissionId = localId(row.permission_id, `${path}.permission_id`);
  if (permissionId.startsWith("vf.source."))
    invalid("reserved source permission ID", `${path}.permission_id`);
  const targetIds = stringArray(row.target_ids, `${path}.target_ids`);
  for (const [index, targetId] of targetIds.entries())
    if (!/^vf-target-[a-f0-9]{64}$/.test(targetId))
      invalid("invalid permission target ID", `${path}.target_ids[${index}]`);
  if (
    !new Set(["brokered", "sandboxed", "engine-enforced", "disclosed-not-enforced"]).has(
      row.enforcement as string,
    )
  )
    invalid("invalid permission enforcement", `${path}.enforcement`);
  validatePermissionScope(row.kind, row.scope, grantScope, `${path}.scope`);
  assertDigest(row.binding_digest, `${path}.binding_digest`);
  const { binding_digest: observed, ...preimage } = row;
  if (observed !== digestV1("VF-GRANTED-PERMISSION-BINDING\0v1\0", preimage))
    invalid("granted permission binding digest mismatch", `${path}.binding_digest`);
  return { permission_id: permissionId, binding_digest: observed as string };
}

function validatePermissionScope(
  kind: unknown,
  value: unknown,
  grantScope: "project" | "user",
  path: string,
): void {
  switch (kind) {
    case "filesystem": {
      const row = exactObject(value, ["root", "access", "path_prefix"], [], path);
      const expectedRoot = grantScope === "project" ? "project" : "user-home";
      if (row.root !== expectedRoot || !["read", "write"].includes(row.access as string))
        invalid("filesystem scope/root mismatch", path);
      relativePrefix(row.path_prefix, `${path}.path_prefix`);
      return;
    }
    case "network": {
      const row = exactObject(value, ["transport", "host", "port", "path_prefix"], [], path);
      if (!["https", "git-https", "mcp-https"].includes(row.transport as string))
        invalid("invalid network transport", `${path}.transport`);
      canonicalHost(row.host, `${path}.host`);
      if (row.port !== null && safeInteger(row.port, `${path}.port`, 1) > 65_535)
        invalid("network port exceeds 65535", `${path}.port`);
      canonicalUrlPath(row.path_prefix, `${path}.path_prefix`);
      return;
    }
    case "process": {
      const row = exactObject(
        value,
        ["executable_class", "argv_prefix", "allow_additional_args"],
        [],
        path,
      );
      localId(row.executable_class, `${path}.executable_class`);
      const argv = array(row.argv_prefix, `${path}.argv_prefix`, 128);
      argv.forEach((item, index) => canonicalText(item, `${path}.argv_prefix[${index}]`, 4_096));
      if (typeof row.allow_additional_args !== "boolean")
        invalid("invalid additional-argument flag", `${path}.allow_additional_args`);
      return;
    }
    case "shell": {
      const row = exactObject(value, ["adapter_id", "template_id"], [], path);
      localId(row.adapter_id, `${path}.adapter_id`);
      localId(row.template_id, `${path}.template_id`);
      return;
    }
    case "config": {
      const row = exactObject(value, ["engine", "namespace", "access", "key_prefix"], [], path);
      if (!ENGINES.has(row.engine as string)) invalid("invalid config engine", `${path}.engine`);
      localId(row.namespace, `${path}.namespace`);
      if (!new Set(["read", "write"]).has(row.access as string))
        invalid("invalid config access", `${path}.access`);
      structuredKey(row.key_prefix, `${path}.key_prefix`);
      return;
    }
    case "secret": {
      const row = exactObject(value, ["input_ids"], [], path);
      const ids = stringArray(row.input_ids, `${path}.input_ids`, { min: 1 });
      ids.forEach((id, index) => localId(id, `${path}.input_ids[${index}]`));
      return;
    }
    case "hook": {
      const row = exactObject(value, ["engine", "hook_point", "participant_id"], [], path);
      if (!ENGINES.has(row.engine as string)) invalid("invalid hook engine", `${path}.engine`);
      localId(row.hook_point, `${path}.hook_point`);
      if (row.participant_id !== null) assertOpaqueId(row.participant_id, `${path}.participant_id`);
      return;
    }
    default:
      invalid("invalid permission kind", `${path}.kind`);
  }
}

function relativePrefix(value: unknown, path: string): void {
  const text = canonicalText(value, path, 1_024);
  const segments = text.split("/");
  if (
    text.startsWith("/") ||
    text.includes("\\") ||
    (text.length > 0 && segments.some((segment) => !segment || segment === "." || segment === ".."))
  )
    invalid("filesystem prefix is not canonical relative scope", path);
}

function canonicalHost(value: unknown, path: string): void {
  const host = canonicalText(value, path, 253);
  if (!host || host.includes("*") || host.includes("@") || /[/:?#]/.test(host))
    invalid("network host is not canonical", path);
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    invalid("network host is not canonical", path);
  }
  if (parsed.hostname !== host || parsed.host !== host)
    invalid("network host is not canonical", path);
}

function canonicalUrlPath(value: unknown, path: string): void {
  const text = canonicalText(value, path, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(text, "https://permission.invalid");
  } catch {
    invalid("network path prefix is invalid", path);
  }
  if (
    !text.startsWith("/") ||
    parsed.origin !== "https://permission.invalid" ||
    parsed.pathname !== text ||
    parsed.search ||
    parsed.hash ||
    /%(?![0-9A-F]{2})/.test(text)
  )
    invalid("network path prefix is not canonical", path);
}

function structuredKey(value: unknown, path: string): void {
  const text = canonicalText(value, path, 256);
  if (!text || !text.split(".").every((part) => LOCAL_ID.test(part)))
    invalid("config key prefix is not canonical", path);
}

function localId(value: unknown, path: string): string {
  const text = canonicalText(value, path, 64);
  if (!LOCAL_ID.test(text)) invalid("invalid local identifier", path);
  return text;
}

function canonicalText(value: unknown, path: string, max: number): string {
  const text = boundedString(value, path, { max });
  if (text !== text.normalize("NFC")) invalid("text is not NFC", path);
  return text;
}

function stringArray(value: unknown, path: string, options: { min?: number } = {}): string[] {
  const rows = array(value, path, 512).map((item, index) =>
    canonicalText(item, `${path}[${index}]`, 512),
  );
  if (rows.length < (options.min ?? 0)) invalid("array is empty", path);
  orderedUnique(rows, path);
  return rows;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid("array exceeds bound", path);
  return value;
}

function orderedUnique(values: string[], path: string): void {
  if (
    new Set(values).size !== values.length ||
    values.some((value, index) => value !== [...values].sort(bytewise)[index])
  )
    invalid("array is duplicated or not bytewise sorted", path);
}

function invalid(message: string, path: string): never {
  throw new ActionValidationError(message, path);
}
