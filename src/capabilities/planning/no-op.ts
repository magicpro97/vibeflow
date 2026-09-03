import type { CapabilityTargetDispositionV1 } from "../../actions/preview-types.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import type { PermissionBindingV1 } from "../permissions/types.js";
import type { CapabilityLockEntryV1, CapabilityLockedTargetV1 } from "../wire/lock.js";
import { bytewise } from "../wire/primitives.js";
import { ownedProjectionRecord } from "./resource-planner.js";
import type {
  CapabilityAdapterPlanV1,
  CapabilityPlanningRequestV1,
  CapabilityProjectionSnapshotV1,
} from "./types.js";

function portablePackage(
  pkg: CapabilityPlanningRequestV1["desired_packages"][number],
): Omit<CapabilityLockEntryV1, "lock_entry_digest" | "targets" | "ownership_keys"> {
  return {
    package_id: pkg.pin.id,
    pin: pkg.pin,
    manifest_digest: pkg.manifest_digest,
    authenticity_binding: pkg.authenticity_binding,
    dependencies: [...pkg.dependencies].sort((left, right) =>
      bytewise(
        `${left.required_scope}\0${left.package_id}\0${left.version}\0${left.content_sha256}`,
        `${right.required_scope}\0${right.package_id}\0${right.version}\0${right.content_sha256}`,
      ),
    ),
    public_inputs: [...pkg.public_inputs].sort((left, right) =>
      bytewise(left.input_id, right.input_id),
    ),
    secret_input_ids: [...pkg.secret_input_ids].sort(bytewise),
    portable_input_digest: digestV1("VF-CAPABILITY-PORTABLE-INPUTS\0v1\0", {
      schema_version: "1.0",
      public_inputs: [...pkg.public_inputs].sort((left, right) =>
        bytewise(left.input_id, right.input_id),
      ),
      secret_input_ids: [...pkg.secret_input_ids].sort(bytewise),
    }),
  };
}

function basePackagePortable(entry: CapabilityLockEntryV1) {
  const { lock_entry_digest: _, targets: __, ownership_keys: ___, ...portable } = entry;
  return portable;
}

function expectedLockedTarget(
  targetId: string,
  plans: CapabilityAdapterPlanV1[],
  snapshots: CapabilityProjectionSnapshotV1[],
  permissionBinding: PermissionBindingV1,
): CapabilityLockedTargetV1 | null {
  const covering = plans.filter((plan) =>
    plan.targets.some((target) => target.target_id === targetId),
  );
  if (covering.length !== 1) return null;
  const plan = covering[0] as CapabilityAdapterPlanV1;
  if (plan.steps.length !== 0 || plan.health_plan.length !== 0) return null;
  const target = plan.targets.find((row) => row.target_id === targetId);
  const snapshot = snapshots.find((row) => row.snapshot_digest === plan.inspection_snapshot_digest);
  if (!target || target.subject.kind !== "capability" || !snapshot) return null;
  const state = snapshot.target_states.find((row) => row.target_id === targetId);
  if (state?.state !== "owned") return null;
  const resources = snapshot.owned_resources;
  if (
    resources.length === 0 ||
    resources.some(
      (resource) =>
        resource.expected_postimage_sha256 === null ||
        resource.expected_preimage_sha256 !== resource.expected_postimage_sha256,
    )
  )
    return null;
  const projections = resources
    .map((resource) => {
      const projection = ownedProjectionRecord(resource, targetId);
      return {
        ownership_key: resource.ownership_key,
        projection_digest: projection.projection_digest,
      };
    })
    .sort((left, right) =>
      bytewise(
        `${left.ownership_key}\0${left.projection_digest}`,
        `${right.ownership_key}\0${right.projection_digest}`,
      ),
    );
  if (
    canonicalJson(state.live_projection_digests) !==
    canonicalJson(projections.map((row) => row.projection_digest).sort(bytewise))
  )
    return null;
  const permissions = permissionBinding.permissions.filter((row) =>
    row.target_ids.includes(targetId),
  );
  return {
    target_id: targetId,
    component_id: target.subject.component_id,
    scope: target.target.scope,
    engine: target.target.engine,
    participant_id: target.target.participant_id,
    required: target.target.required,
    state: "installed",
    adapter_fingerprints: [plan.adapter.fingerprint],
    projections,
    enforcement_digest: digestV1("VF-TARGET-ENFORCEMENT\0v1\0", {
      schema_version: "1.0",
      target_id: targetId,
      permissions,
    }),
    health_plan_digest: digestV1("VF-TARGET-HEALTH-PLAN\0v1\0", {
      schema_version: "1.0",
      target_id: targetId,
      health: [],
    }),
  };
}

export function isProvedCapabilityNoOp(input: {
  request: CapabilityPlanningRequestV1;
  plans: CapabilityAdapterPlanV1[];
  snapshots: CapabilityProjectionSnapshotV1[];
  dispositions: CapabilityTargetDispositionV1[];
  permissionDigest: string;
  permissionBinding: PermissionBindingV1;
  effectCount: number;
}): boolean {
  const base = input.request.base_lock;
  if (
    !base ||
    input.effectCount !== 0 ||
    base.policy_digest !== input.request.authority.policy_digest ||
    base.permission_digest !== input.permissionDigest ||
    input.dispositions.some((row) => row.execution !== "host") ||
    base.packages.length !== input.request.desired_packages.length
  )
    return false;
  for (const pkg of input.request.desired_packages) {
    const entry = base.packages.find((row) => row.package_id === pkg.pin.id);
    if (!entry || canonicalJson(basePackagePortable(entry)) !== canonicalJson(portablePackage(pkg)))
      return false;
  }
  const baseTargets = base.packages.flatMap((pkg) => pkg.targets);
  const planTargetIds = input.plans.flatMap((plan) =>
    plan.targets.map((target) => target.target_id),
  );
  if (
    new Set(planTargetIds).size !== planTargetIds.length ||
    baseTargets.length !== planTargetIds.length
  )
    return false;
  return baseTargets.every((baseTarget) => {
    const expected = expectedLockedTarget(
      baseTarget.target_id,
      input.plans,
      input.snapshots,
      input.permissionBinding,
    );
    return expected !== null && canonicalJson(expected) === canonicalJson(baseTarget);
  });
}
