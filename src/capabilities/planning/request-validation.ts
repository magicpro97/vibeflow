import { actionIdempotencyScopeDigest } from "../../actions/idempotency.js";
import { validateLegacyCandidate } from "../../actions/internal-candidate-validation.js";
import type { ActionTargetBindingV1 } from "../../actions/preview-types.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import { validateCapabilityManifest } from "../manifest/validation.js";
import { canonicalPermissionBinding } from "../permissions/index.js";
import type { PermissionBindingRowV1, PermissionBindingV1 } from "../permissions/types.js";
import { validateImmutablePackagePin } from "../source/pins.js";
import { validateCapabilityLock } from "../storage/lock-validation.js";
import { CapabilityValidationError, bytewise } from "../wire/primitives.js";
import { targetPermissions } from "./component-target.js";
import type { CapabilityPlanningRequestV1, ResolvedCapabilityPackageV1 } from "./types.js";

export function validateCapabilityPlanningRequest(request: CapabilityPlanningRequestV1): void {
  if (request.schema_version !== "1.0" || request.scope !== request.authority.scope)
    throw new CapabilityValidationError(
      "planning request scope/schema mismatch",
      "planning_request",
    );
  if (
    request.scope_identity_digest !== request.authority.scope_identity_digest ||
    (request.base_lock !== null && request.base_lock.scope !== request.scope)
  )
    throw new CapabilityValidationError(
      "planning authority/base scope mismatch",
      "planning_request",
    );
  if (request.action_root_locator) {
    actionIdempotencyScopeDigest(request.action_root_locator);
    if (
      request.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY &&
      (request.action_root_locator.scope !== request.scope ||
        request.action_root_locator.scope_identity_digest !== request.scope_identity_digest)
    )
      throw new CapabilityValidationError(
        "capability planning action root belongs to another scope",
        "action_root_locator",
      );
  }
  if (request.base_lock)
    validateCapabilityLock(request.base_lock, { expected_scope: request.scope });
  if (new Set(request.selected_engines).size !== request.selected_engines.length)
    throw new CapabilityValidationError("selected engine is duplicated", "selected_engines");
  if (request.selected_targets) {
    const identities = request.selected_targets.map(
      (target) => `${target.package_id}\0${target.engine}\0${target.participant_id ?? ""}`,
    );
    if (
      new Set(identities).size !== identities.length ||
      canonicalJson(identities) !== canonicalJson([...identities].sort(bytewise)) ||
      request.selected_targets.some((target) => !request.selected_engines.includes(target.engine))
    )
      throw new CapabilityValidationError(
        "selected targets must be sorted, unique, and engine-closed",
        "selected_targets",
      );
  }
  const effectPackages = request.effect_packages ?? request.desired_packages;
  for (const pkg of effectPackages) {
    validateImmutablePackagePin(pkg.pin);
    validateCapabilityManifest(pkg.manifest, pkg.files);
    if (
      pkg.pin.id !== pkg.manifest.id ||
      pkg.pin.version !== pkg.manifest.version ||
      pkg.manifest_digest !== digestV1("VF-CAPABILITY-MANIFEST\0v1\0", pkg.manifest) ||
      pkg.authenticity_binding.pin_digest !== pkg.pin.pin_digest ||
      pkg.authenticity_binding.manifest_digest !== pkg.manifest_digest
    )
      throw new CapabilityValidationError(
        "resolved package identity/manifest mismatch",
        "desired_packages",
      );
  }
  for (const [field, packages] of [
    ["desired_packages", request.desired_packages],
    ["effect_packages", effectPackages],
  ] as const) {
    const ids = packages.map((pkg) => pkg.pin.id);
    if (
      new Set(ids).size !== ids.length ||
      canonicalJson(ids) !== canonicalJson([...ids].sort(bytewise))
    )
      throw new CapabilityValidationError(`${field} must be sorted and unique`, field);
  }
  const effectIds = new Set(effectPackages.map((pkg) => pkg.pin.id));
  if (request.desired_packages.some((pkg) => !effectIds.has(pkg.pin.id)))
    throw new CapabilityValidationError(
      "every desired package must be effect-closed",
      "effect_packages",
    );
  if (request.intent.kind === "remove") {
    const removedPackageId = request.intent.package_id;
    if (
      request.desired_packages.some((pkg) => pkg.pin.id === removedPackageId) ||
      !effectIds.has(removedPackageId)
    )
      throw new CapabilityValidationError(
        "remove requires the removed package only in effect_packages",
        "effect_packages",
      );
  }
  if (request.intent.kind === "adopt") {
    const candidate = request.adopt_candidate;
    if (!candidate)
      throw new CapabilityValidationError(
        "adopt requires its exact inspected candidate",
        "adopt_candidate",
      );
    validateLegacyCandidate(candidate, request.scope, "adopt_candidate");
    if (
      candidate.scope_identity_digest !== request.scope_identity_digest ||
      candidate.candidate_digest !== request.intent.candidate_digest ||
      !effectPackages.some(
        (pkg) =>
          pkg.pin.pin_digest === candidate.synthetic_pin.pin_digest &&
          pkg.manifest_digest ===
            digestV1("VF-CAPABILITY-MANIFEST\0v1\0", candidate.synthetic_manifest),
      )
    )
      throw new CapabilityValidationError(
        "adopt candidate identity closure mismatch",
        "adopt_candidate",
      );
  } else if (request.adopt_candidate !== undefined) {
    throw new CapabilityValidationError(
      "adopt candidate is forbidden for this intent",
      "adopt_candidate",
    );
  }
}

export function buildPermissionBinding(
  packages: readonly ResolvedCapabilityPackageV1[],
  targets: readonly ActionTargetBindingV1[],
): PermissionBindingV1 {
  const rows: PermissionBindingRowV1[] = [];
  for (const pkg of packages) {
    const packageTargets = targets.filter(
      (target) => target.subject.kind === "capability" && target.subject.package_id === pkg.pin.id,
    );
    for (const permission of pkg.manifest.permissions) {
      const target_ids = packageTargets
        .filter((target) => targetPermissions([permission], target).length > 0)
        .map((target) => target.target_id)
        .sort(bytewise);
      if (target_ids.length === 0) continue;
      const { required_enforcement: enforcement, ...kindScope } = permission;
      rows.push({ ...kindScope, target_ids, enforcement });
    }
  }
  const binding = {
    schema_version: "1.0" as const,
    permissions: rows,
    secret_input_ids: [...new Set(packages.flatMap((pkg) => pkg.secret_input_ids))].sort(bytewise),
  };
  binding.permissions = canonicalPermissionBinding(binding).permissions;
  return binding;
}
