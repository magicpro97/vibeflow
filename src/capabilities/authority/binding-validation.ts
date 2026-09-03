import { CAPABILITY_MANIFEST_RUNTIME_ENFORCEMENTS } from "../../actions/capability-manifest-vocabulary-contract.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import type { CapabilityScope } from "../../core/capability-contract.js";
import { validatePermissionKindScope } from "../permissions/scope.js";
import type { GrantedPermissionBindingV1 } from "../permissions/types.js";
import { grantedPermissionBindingDigest } from "../permissions/witness.js";
import {
  CapabilityValidationError,
  assertSortedUnique,
  bytewise,
  digest,
  enumeration,
  exactKeys,
  text,
} from "../wire/primitives.js";

export function assertAuthorityLocatorScope(
  locator: PrivateActionRootLocatorV1,
  scope: CapabilityScope,
  scopeIdentityDigest: string,
  path: string,
): void {
  if (
    locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY &&
    (locator.scope !== scope || locator.scope_identity_digest !== scopeIdentityDigest)
  )
    throw new CapabilityValidationError(
      "capability action root does not own this authority scope",
      path,
    );
}

export function validateGrantedPermissionBinding(
  binding: GrantedPermissionBindingV1,
  path: string,
): void {
  exactKeys(
    binding,
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
  if (binding.schema_version !== "1.0")
    throw new CapabilityValidationError("unsupported granted permission schema", path);
  text(binding.permission_id, `${path}.permission_id`, { min: 1, max: 193, ascii: true });
  if (!Array.isArray(binding.target_ids) || binding.target_ids.length === 0)
    throw new CapabilityValidationError(
      "granted permission target set is empty",
      `${path}.target_ids`,
    );
  binding.target_ids.forEach((value, index) =>
    text(value, `${path}.target_ids[${index}]`, { min: 1, max: 512, ascii: true }),
  );
  assertSortedUnique(binding.target_ids, bytewise, `${path}.target_ids`);
  enumeration(binding.enforcement, CAPABILITY_MANIFEST_RUNTIME_ENFORCEMENTS, `${path}.enforcement`);
  validatePermissionKindScope({ kind: binding.kind, scope: binding.scope }, path);
  digest(binding.binding_digest, `${path}.binding_digest`);
  if (binding.binding_digest !== grantedPermissionBindingDigest(binding))
    throw new CapabilityValidationError(
      "granted permission binding digest mismatch",
      path,
      "integrity_failure",
    );
}
