import { CAPABILITY_MANIFEST_PERMISSION_KIND } from "../../actions/capability-manifest-vocabulary-contract.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import type { CapabilityPermissionKindScopeV1 } from "../manifest/types.js";
import { CapabilityValidationError, assertSortedUnique, bytewise } from "../wire/primitives.js";
import { permissionScopeDigest, validatePermissionKindScope } from "./scope.js";
import type { PermissionBindingRowV1, PermissionBindingV1 } from "./types.js";

function segmentContains(parent: string, child: string, separator: string): boolean {
  return parent === "" || parent === child || child.startsWith(`${parent}${separator}`);
}

function arrayPrefix(left: readonly string[], right: readonly string[]): boolean {
  return left.length <= right.length && left.every((value, index) => value === right[index]);
}

function permissionKindScope(
  value: CapabilityPermissionKindScopeV1,
): CapabilityPermissionKindScopeV1 {
  switch (value.kind) {
    case CAPABILITY_MANIFEST_PERMISSION_KIND.FILESYSTEM:
      return { kind: CAPABILITY_MANIFEST_PERMISSION_KIND.FILESYSTEM, scope: value.scope };
    case CAPABILITY_MANIFEST_PERMISSION_KIND.NETWORK:
      return { kind: CAPABILITY_MANIFEST_PERMISSION_KIND.NETWORK, scope: value.scope };
    case CAPABILITY_MANIFEST_PERMISSION_KIND.PROCESS:
      return { kind: CAPABILITY_MANIFEST_PERMISSION_KIND.PROCESS, scope: value.scope };
    case CAPABILITY_MANIFEST_PERMISSION_KIND.SHELL:
      return { kind: CAPABILITY_MANIFEST_PERMISSION_KIND.SHELL, scope: value.scope };
    case CAPABILITY_MANIFEST_PERMISSION_KIND.CONFIG:
      return { kind: CAPABILITY_MANIFEST_PERMISSION_KIND.CONFIG, scope: value.scope };
    case CAPABILITY_MANIFEST_PERMISSION_KIND.SECRET:
      return { kind: CAPABILITY_MANIFEST_PERMISSION_KIND.SECRET, scope: value.scope };
    case CAPABILITY_MANIFEST_PERMISSION_KIND.HOOK:
      return { kind: CAPABILITY_MANIFEST_PERMISSION_KIND.HOOK, scope: value.scope };
  }
}

export function permissionContains(
  grant: CapabilityPermissionKindScopeV1,
  request: CapabilityPermissionKindScopeV1,
): boolean {
  validatePermissionKindScope(permissionKindScope(grant), "grant");
  validatePermissionKindScope(permissionKindScope(request), "request");
  if (grant.kind !== request.kind) return false;
  switch (grant.kind) {
    case CAPABILITY_MANIFEST_PERMISSION_KIND.FILESYSTEM:
      return (
        request.kind === CAPABILITY_MANIFEST_PERMISSION_KIND.FILESYSTEM &&
        grant.scope.root === request.scope.root &&
        grant.scope.access === request.scope.access &&
        segmentContains(grant.scope.path_prefix, request.scope.path_prefix, "/")
      );
    case CAPABILITY_MANIFEST_PERMISSION_KIND.NETWORK:
      return (
        request.kind === CAPABILITY_MANIFEST_PERMISSION_KIND.NETWORK &&
        grant.scope.transport === request.scope.transport &&
        grant.scope.host === request.scope.host &&
        (grant.scope.port ?? 443) === (request.scope.port ?? 443) &&
        segmentContains(grant.scope.path_prefix, request.scope.path_prefix, "/")
      );
    case CAPABILITY_MANIFEST_PERMISSION_KIND.PROCESS:
      return (
        request.kind === CAPABILITY_MANIFEST_PERMISSION_KIND.PROCESS &&
        grant.scope.executable_class === request.scope.executable_class &&
        arrayPrefix(grant.scope.argv_prefix, request.scope.argv_prefix) &&
        (!request.scope.allow_additional_args || grant.scope.allow_additional_args) &&
        (request.scope.allow_additional_args ||
          grant.scope.allow_additional_args ||
          grant.scope.argv_prefix.length === request.scope.argv_prefix.length)
      );
    case CAPABILITY_MANIFEST_PERMISSION_KIND.SHELL:
      return (
        request.kind === CAPABILITY_MANIFEST_PERMISSION_KIND.SHELL &&
        canonicalJson(grant.scope) === canonicalJson(request.scope)
      );
    case CAPABILITY_MANIFEST_PERMISSION_KIND.CONFIG:
      return (
        request.kind === CAPABILITY_MANIFEST_PERMISSION_KIND.CONFIG &&
        grant.scope.engine === request.scope.engine &&
        grant.scope.namespace === request.scope.namespace &&
        grant.scope.access === request.scope.access &&
        segmentContains(grant.scope.key_prefix, request.scope.key_prefix, ".")
      );
    case CAPABILITY_MANIFEST_PERMISSION_KIND.SECRET:
      return (
        request.kind === CAPABILITY_MANIFEST_PERMISSION_KIND.SECRET &&
        request.scope.input_ids.every((input) => grant.scope.input_ids.includes(input))
      );
    case CAPABILITY_MANIFEST_PERMISSION_KIND.HOOK:
      return (
        request.kind === CAPABILITY_MANIFEST_PERMISSION_KIND.HOOK &&
        grant.scope.engine === request.scope.engine &&
        grant.scope.hook_point === request.scope.hook_point &&
        (grant.scope.participant_id === null ||
          grant.scope.participant_id === request.scope.participant_id)
      );
  }
}

export function permissionTargetSetDigest(targetIds: readonly string[]): string {
  const ids = [...targetIds];
  assertSortedUnique(ids, bytewise, "target_ids");
  return digestV1("VF-PERMISSION-TARGET-SET\0v1\0", ids);
}

export function permissionRowSortKey(row: PermissionBindingRowV1): string {
  return [
    row.permission_id,
    row.kind,
    permissionScopeDigest(permissionKindScope(row)),
    row.enforcement,
    permissionTargetSetDigest(row.target_ids),
  ].join("\0");
}

export function canonicalPermissionUnion(
  rows: readonly PermissionBindingRowV1[],
): PermissionBindingRowV1[] {
  const validated = rows.map((row, index) => {
    validatePermissionKindScope(permissionKindScope(row), `permissions[${index}]`);
    if (!row.permission_id || row.permission_id.length > 128)
      throw new CapabilityValidationError(
        "invalid permission ID",
        `permissions[${index}].permission_id`,
      );
    assertSortedUnique(row.target_ids, bytewise, `permissions[${index}].target_ids`);
    return structuredClone(row);
  });
  const reduced = validated.filter(
    (candidate, index) =>
      !validated.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          candidate.permission_id === other.permission_id &&
          candidate.enforcement === other.enforcement &&
          canonicalJson(candidate.target_ids) === canonicalJson(other.target_ids) &&
          permissionContains(other, candidate) &&
          (!permissionContains(candidate, other) ||
            permissionRowSortKey(other) < permissionRowSortKey(candidate)),
      ),
  );
  reduced.sort((left, right) => bytewise(permissionRowSortKey(left), permissionRowSortKey(right)));
  return reduced;
}

export function canonicalPermissionBinding(binding: PermissionBindingV1): PermissionBindingV1 {
  const secret = [...binding.secret_input_ids];
  assertSortedUnique(secret, bytewise, "secret_input_ids");
  const permissions = canonicalPermissionUnion(binding.permissions);
  if (
    permissions.length !== binding.permissions.length ||
    canonicalJson(permissions) !== canonicalJson(binding.permissions)
  )
    throw new CapabilityValidationError(
      "permission binding is not the canonical union",
      "permissions",
    );
  return structuredClone(binding);
}

export function permissionBindingDigest(binding: PermissionBindingV1): string {
  canonicalPermissionBinding(binding);
  return digestV1("VF-PERMISSION-BINDING\0v1\0", binding);
}

export function permissionUnionContains(
  granted: readonly PermissionBindingRowV1[],
  requested: readonly PermissionBindingRowV1[],
): boolean {
  const grantUnion = canonicalPermissionUnion(granted);
  const requestUnion = canonicalPermissionUnion(requested);
  return requestUnion.every((request) =>
    grantUnion.some(
      (grant) =>
        grant.permission_id === request.permission_id &&
        grant.enforcement === request.enforcement &&
        canonicalJson(grant.target_ids) === canonicalJson(request.target_ids) &&
        permissionContains(grant, request),
    ),
  );
}
