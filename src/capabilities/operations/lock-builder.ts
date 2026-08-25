import type { PublicTargetResultV1 } from "../../actions/public-types.js";
import { digestV1 } from "../../durability/index.js";
import type { PermissionBindingRowV1 } from "../permissions/types.js";
import type { CapabilityFabricPlanV1 } from "../planning/types.js";
import {
  capabilityLockEntryDigest,
  materializeCapabilityLock,
  portableInputDigest,
} from "../storage/lock-validation.js";
import type {
  CapabilityLockEntryV1,
  CapabilityLockV1,
  CapabilityLockedTargetV1,
} from "../wire/lock.js";
import { bytewise } from "../wire/primitives.js";

function targetPermissionRows(
  plan: CapabilityFabricPlanV1,
  targetId: string,
): PermissionBindingRowV1[] {
  return plan.permission_binding.permissions.filter((row) => row.target_ids.includes(targetId));
}

function lockedTarget(
  plan: CapabilityFabricPlanV1,
  result: PublicTargetResultV1,
): CapabilityLockedTargetV1 {
  const adapterPlans = plan.adapter_plans.filter((item) =>
    item.targets.some((target) => target.target_id === result.target_id),
  );
  const resources = adapterPlans.flatMap((item) => {
    const stepResources = item.steps.flatMap((step) => step.owned_resources);
    if (stepResources.length > 0) return stepResources;
    const snapshot = plan.runtime_closure.snapshots.find(
      (value) => value.snapshot_digest === item.inspection_snapshot_digest,
    );
    return snapshot?.owned_resources ?? [];
  });
  const projections = resources
    .filter((resource) => resource.expected_postimage_sha256 !== null)
    .map((resource) => {
      const descriptor = plan.runtime_closure.descriptors.find(
        (item) =>
          item.target_id === result.target_id &&
          item.resource.ownership_key === resource.ownership_key &&
          item.descriptor_kind === "intent",
      );
      return {
        ownership_key: resource.ownership_key,
        projection_digest:
          descriptor?.projection_digest ??
          digestV1("VF-OWNED-PROJECTION\0v1\0", {
            ownership_key: resource.ownership_key,
            target_ids: [result.target_id],
            expected_postimage_sha256: resource.expected_postimage_sha256,
          }),
      };
    })
    .sort((left, right) =>
      bytewise(
        `${left.ownership_key}\0${left.projection_digest}`,
        `${right.ownership_key}\0${right.projection_digest}`,
      ),
    );
  const permissions = targetPermissionRows(plan, result.target_id);
  const health = adapterPlans.flatMap((item) =>
    item.health_plan.filter((probe) => probe.target_ids.includes(result.target_id)),
  );
  const source = plan.targets.find((target) => target.target_id === result.target_id);
  if (!source || source.subject.kind !== "capability")
    throw new Error("target result is not in plan");
  return {
    target_id: result.target_id,
    component_id: source.subject.component_id,
    scope: result.target.scope,
    engine: result.target.engine,
    participant_id: result.target.participant_id,
    required: result.target.required,
    state: result.outcome === "degraded" ? "degraded" : "installed",
    adapter_fingerprints: [...new Set(adapterPlans.map((item) => item.adapter.fingerprint))].sort(
      bytewise,
    ),
    projections,
    enforcement_digest: digestV1("VF-TARGET-ENFORCEMENT\0v1\0", {
      schema_version: "1.0",
      target_id: result.target_id,
      permissions,
    }),
    health_plan_digest: digestV1("VF-TARGET-HEALTH-PLAN\0v1\0", {
      schema_version: "1.0",
      target_id: result.target_id,
      health,
    }),
  };
}

function lockEntry(
  plan: CapabilityFabricPlanV1,
  pkg: CapabilityFabricPlanV1["runtime_closure"]["packages"][number],
  results: PublicTargetResultV1[],
): CapabilityLockEntryV1 | null {
  const targets = results
    .filter(
      (result) =>
        result.subject.kind === "capability" &&
        result.subject.package_id === pkg.pin.id &&
        ["applied", "degraded"].includes(result.outcome),
    )
    .map((result) => lockedTarget(plan, result))
    .filter((target) => target.projections.length > 0)
    .sort((left, right) => bytewise(left.target_id, right.target_id));
  if (targets.length === 0) return null;
  const draft: CapabilityLockEntryV1 = {
    package_id: pkg.pin.id,
    pin: pkg.pin,
    manifest_digest: pkg.manifest_digest,
    authenticity_binding: pkg.authenticity_binding,
    lock_entry_digest: "",
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
    portable_input_digest: "",
    targets,
    ownership_keys: [
      ...new Set(targets.flatMap((target) => target.projections.map((row) => row.ownership_key))),
    ].sort(bytewise),
  };
  draft.portable_input_digest = portableInputDigest(draft);
  draft.lock_entry_digest = capabilityLockEntryDigest(draft);
  return draft;
}

export function buildCapabilityLockFromResults(input: {
  plan: CapabilityFabricPlanV1;
  results: PublicTargetResultV1[];
  base: CapabilityLockV1 | null;
}): CapabilityLockV1 {
  const packages = input.plan.runtime_closure.packages
    .map((pkg) => lockEntry(input.plan, pkg, input.results))
    .filter((entry): entry is CapabilityLockEntryV1 => entry !== null)
    .sort((left, right) => bytewise(left.package_id, right.package_id));
  return materializeCapabilityLock({
    schema_version: "1.0",
    fabric_active: true,
    scope: input.plan.scope,
    generation_ordinal: input.base === null ? 0 : input.base.generation_ordinal + 1,
    parent_generation_digests: input.base === null ? [] : [input.base.content_digest],
    packages,
    policy_digest: input.plan.runtime_closure.authority.policy_digest,
    permission_digest: input.plan.permission_digest,
    created_at: input.plan.created_at,
  });
}
