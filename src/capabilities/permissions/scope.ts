import type { EngineName } from "../../actions/types.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import type {
  CapabilityPermissionKindScopeV1,
  CapabilityPermissionV1,
  RuntimeEnforcementV1,
} from "../manifest/types.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  boolean,
  bytewise,
  enumeration,
  exactKeys,
  integer,
  localId,
  text,
} from "../wire/primitives.js";

const ENGINES: EngineName[] = ["claude", "codex", "copilot", "opencode", "antigravity"];
const ENFORCEMENTS: RuntimeEnforcementV1[] = [
  "brokered",
  "sandboxed",
  "engine-enforced",
  "disclosed-not-enforced",
];

export function canonicalRelativePrefix(value: unknown, path: string, allowEmpty = true): string {
  const result = text(value, path, { min: allowEmpty ? 0 : 1, max: 4_096 });
  if (
    result.startsWith("/") ||
    result.endsWith("/") ||
    result.includes("\\") ||
    /^[A-Za-z]:/.test(result) ||
    result.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    if (!(allowEmpty && result === ""))
      throw new CapabilityValidationError("path prefix is not canonical relative form", path);
  }
  return result;
}

export function canonicalUrlPathPrefix(value: unknown, path: string): string {
  const result = text(value, path, { min: 1, max: 4_096, ascii: true });
  if (!result.startsWith("/") || result.includes("\\") || /%(?![0-9A-F]{2})/.test(result))
    throw new CapabilityValidationError("URL path prefix is not canonical", path);
  let canonical: string;
  try {
    canonical = new URL(result, "https://vf.invalid").pathname;
  } catch {
    throw new CapabilityValidationError("invalid URL path prefix", path);
  }
  if (canonical !== result)
    throw new CapabilityValidationError(
      "URL path prefix must use normalized percent encoding",
      path,
    );
  return result;
}

export function canonicalHost(value: unknown, path: string): string {
  const result = text(value, path, { min: 1, max: 253, ascii: true });
  if (result.includes("*") || result.endsWith("."))
    throw new CapabilityValidationError("wildcard or trailing-dot hosts are forbidden", path);
  let observed: string;
  try {
    observed = new URL(`https://${result}`).hostname;
  } catch {
    throw new CapabilityValidationError("invalid network host", path);
  }
  if (observed !== result || result !== result.toLowerCase())
    throw new CapabilityValidationError("host must be canonical lowercase IDNA", path);
  return result;
}

function structuredKey(value: unknown, path: string): string {
  const result = text(value, path, { min: 1, max: 512, ascii: true });
  for (const segment of result.split(".")) localId(segment, path);
  return result;
}

export function validatePermissionKindScope(
  value: unknown,
  path = "$",
): CapabilityPermissionKindScopeV1 {
  const outer = exactKeys(value, ["kind", "scope"], [], path);
  const kind = enumeration(
    outer.kind,
    ["filesystem", "network", "process", "shell", "config", "secret", "hook"] as const,
    `${path}.kind`,
  );
  const scopePath = `${path}.scope`;
  if (kind === "filesystem") {
    const scope = exactKeys(outer.scope, ["root", "access", "path_prefix"], [], scopePath);
    enumeration(scope.root, ["project", "user-home"] as const, `${scopePath}.root`);
    enumeration(scope.access, ["read", "write"] as const, `${scopePath}.access`);
    canonicalRelativePrefix(scope.path_prefix, `${scopePath}.path_prefix`);
  } else if (kind === "network") {
    const scope = exactKeys(
      outer.scope,
      ["transport", "host", "port", "path_prefix"],
      [],
      scopePath,
    );
    enumeration(
      scope.transport,
      ["https", "git-https", "mcp-https"] as const,
      `${scopePath}.transport`,
    );
    canonicalHost(scope.host, `${scopePath}.host`);
    if (scope.port !== null) integer(scope.port, `${scopePath}.port`, 1, 65_535);
    canonicalUrlPathPrefix(scope.path_prefix, `${scopePath}.path_prefix`);
  } else if (kind === "process") {
    const scope = exactKeys(
      outer.scope,
      ["executable_class", "argv_prefix", "allow_additional_args"],
      [],
      scopePath,
    );
    localId(scope.executable_class, `${scopePath}.executable_class`);
    if (!Array.isArray(scope.argv_prefix) || scope.argv_prefix.length > 128)
      throw new CapabilityValidationError("invalid argv prefix", `${scopePath}.argv_prefix`);
    scope.argv_prefix.forEach((item, index) =>
      text(item, `${scopePath}.argv_prefix[${index}]`, { max: 4_096 }),
    );
    boolean(scope.allow_additional_args, `${scopePath}.allow_additional_args`);
  } else if (kind === "shell") {
    const scope = exactKeys(outer.scope, ["adapter_id", "template_id"], [], scopePath);
    localId(scope.adapter_id, `${scopePath}.adapter_id`);
    localId(scope.template_id, `${scopePath}.template_id`);
  } else if (kind === "config") {
    const scope = exactKeys(
      outer.scope,
      ["engine", "namespace", "access", "key_prefix"],
      [],
      scopePath,
    );
    enumeration(scope.engine, ENGINES, `${scopePath}.engine`);
    localId(scope.namespace, `${scopePath}.namespace`);
    enumeration(scope.access, ["read", "write"] as const, `${scopePath}.access`);
    structuredKey(scope.key_prefix, `${scopePath}.key_prefix`);
  } else if (kind === "secret") {
    const scope = exactKeys(outer.scope, ["input_ids"], [], scopePath);
    if (
      !Array.isArray(scope.input_ids) ||
      scope.input_ids.length === 0 ||
      scope.input_ids.length > 128
    )
      throw new CapabilityValidationError("invalid secret input set", `${scopePath}.input_ids`);
    const ids = scope.input_ids.map((item, index) =>
      localId(item, `${scopePath}.input_ids[${index}]`),
    );
    assertSortedUnique(ids, bytewise, `${scopePath}.input_ids`);
  } else {
    const scope = exactKeys(outer.scope, ["engine", "hook_point", "participant_id"], [], scopePath);
    enumeration(scope.engine, ENGINES, `${scopePath}.engine`);
    localId(scope.hook_point, `${scopePath}.hook_point`);
    if (scope.participant_id !== null)
      text(scope.participant_id, `${scopePath}.participant_id`, { min: 1, max: 512, ascii: true });
  }
  return value as CapabilityPermissionKindScopeV1;
}

export function validateManifestPermission(
  value: unknown,
  manifestId: string,
  path: string,
): CapabilityPermissionV1 {
  const outer = exactKeys(
    value,
    ["permission_id", "required_enforcement", "kind", "scope"],
    [],
    path,
  );
  const permissionId = text(outer.permission_id, `${path}.permission_id`, {
    min: 3,
    max: 193,
    ascii: true,
  });
  const prefix = `${manifestId}/`;
  if (!permissionId.startsWith(prefix) || permissionId.startsWith("vf.source/"))
    throw new CapabilityValidationError(
      "permission ID must use the manifest namespace",
      `${path}.permission_id`,
    );
  localId(permissionId.slice(prefix.length), `${path}.permission_id`);
  enumeration(outer.required_enforcement, ENFORCEMENTS, `${path}.required_enforcement`);
  validatePermissionKindScope({ kind: outer.kind, scope: outer.scope }, path);
  return value as CapabilityPermissionV1;
}

export function permissionScopeDigest(value: CapabilityPermissionKindScopeV1): string {
  validatePermissionKindScope(value);
  return digestV1("VF-CAPABILITY-PERMISSION-SCOPE\0v1\0", value);
}

export function publicPermissionScope(value: CapabilityPermissionKindScopeV1): string {
  validatePermissionKindScope(value);
  return canonicalJson(value);
}

export function assertPermissionMatchesOperationScope(
  permission: CapabilityPermissionKindScopeV1,
  scope: "project" | "user",
): void {
  if (permission.kind !== "filesystem") return;
  const expected = scope === "project" ? "project" : "user-home";
  if (permission.scope.root !== expected)
    throw new CapabilityValidationError(
      "filesystem permission crosses the operation scope",
      "permission.scope.root",
    );
}
