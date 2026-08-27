import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/index.js";
import { ACTION_TARGET_DISPOSITION_EXECUTION_VALUE } from "../../actions/public-action-vocabulary-contract.js";
import {
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityAuthorityStaleRuntimeErrorCodeV1,
} from "../../core/capability-contract.js";
import { canonicalJson } from "../../durability/index.js";
import { digestHex } from "../../durability/index.js";
import { validatePrivateEffectBinding } from "../adapters/private-descriptors.js";
import { validateCapabilityAdapterRegistry } from "../adapters/registry.js";
import { permissionBindingDigest } from "../permissions/index.js";
import {
  adapterPlanDigest,
  adapterPlanIdentity,
  capabilityFabricPlanDigest,
  executionClosureDigest,
  projectionSnapshotDigest,
} from "../planning/digests.js";
import type { CapabilityFabricPlanV1, CapabilityRuntimeAuthorityV1 } from "../planning/types.js";
import { CapabilityRuntimeError } from "./errors.js";

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN);
}

export function validateCapabilityFabricPlan(plan: CapabilityFabricPlanV1): CapabilityFabricPlanV1 {
  if (plan.schema_version !== "1.0") invalid("unsupported Capability Fabric plan schema");
  validateCapabilityAdapterRegistry(plan.runtime_closure.adapter_registry);
  if (
    plan.adapter_registry_digest !== plan.runtime_closure.adapter_registry.registry_digest ||
    plan.adapter_registry_digest !== plan.execution_closure.adapter_registry_digest ||
    plan.execution_closure_digest !== executionClosureDigest(plan.execution_closure) ||
    plan.execution_closure_digest !== plan.execution_closure.closure_digest
  )
    invalid("execution closure digest mismatch");
  if (
    (plan.action_root_locator as { kind: string }).kind ===
      ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP ||
    canonicalJson(plan.action_root_locator) !==
      canonicalJson(plan.execution_closure.action_root_locator)
  )
    invalid("execution closure action root mismatch");
  if (plan.permission_digest !== permissionBindingDigest(plan.permission_binding))
    invalid("permission binding digest mismatch");
  if (plan.permission_digest !== plan.execution_closure.permission_digest)
    invalid("execution closure permission binding mismatch");
  for (const descriptor of plan.runtime_closure.descriptors) {
    const binding = validatePrivateEffectBinding(descriptor.private_payload_binding);
    if (
      binding.descriptor_schema_id !== descriptor.descriptor_schema_id ||
      binding.descriptor_digest !== descriptor.descriptor_digest ||
      binding.private_descriptor_ref !==
        `actions/v1/objects/${digestHex(binding.descriptor_digest)}.json` ||
      canonicalJson(binding.action_root_locator) !== canonicalJson(plan.action_root_locator)
    )
      invalid("private adapter payload binding mismatch");
  }
  for (const snapshot of plan.runtime_closure.snapshots)
    if (snapshot.snapshot_digest !== projectionSnapshotDigest(snapshot))
      invalid("projection snapshot digest mismatch");
  for (const adapterPlan of plan.adapter_plans) {
    const digest = adapterPlanDigest(adapterPlan);
    if (adapterPlan.plan_digest !== digest || adapterPlan.plan_id !== adapterPlanIdentity(digest))
      invalid("adapter plan identity mismatch");
    if (adapterPlan.authority.permission_digest !== plan.permission_digest)
      invalid("adapter plan permission digest mismatch");
  }
  if (
    canonicalJson(
      plan.adapter_plans.map((adapterPlan, order) => ({
        order,
        plan_id: adapterPlan.plan_id,
        plan_digest: adapterPlan.plan_digest,
      })),
    ) !== canonicalJson(plan.execution_closure.plans)
  )
    invalid("execution closure adapter plans mismatch");
  if (plan.plan_digest !== capabilityFabricPlanDigest(plan)) invalid("Fabric plan digest mismatch");
  return structuredClone(plan);
}

export function authorityMismatch(
  expected: CapabilityRuntimeAuthorityV1,
  observed: CapabilityRuntimeAuthorityV1,
  includeSourceAuthority = true,
): CapabilityAuthorityStaleRuntimeErrorCodeV1 | null {
  if (
    observed.scope !== expected.scope ||
    observed.scope_identity_digest !== expected.scope_identity_digest ||
    observed.authority_epoch !== expected.authority_epoch ||
    observed.authority_head_digest !== expected.authority_head_digest
  )
    return CAPABILITY_RUNTIME_ERROR_CODE.AUTHORITY_HEAD_STALE;
  if (observed.policy_digest !== expected.policy_digest)
    return CAPABILITY_RUNTIME_ERROR_CODE.POLICY_STALE;
  if (observed.grant_digest !== expected.grant_digest)
    return CAPABILITY_RUNTIME_ERROR_CODE.GRANT_STALE;
  if (observed.permission_digest !== expected.permission_digest)
    return CAPABILITY_RUNTIME_ERROR_CODE.PERMISSION_STALE;
  if (
    includeSourceAuthority &&
    observed.source_authority_set_digest !== expected.source_authority_set_digest
  )
    return CAPABILITY_RUNTIME_ERROR_CODE.SOURCE_AUTHORITY_STALE;
  return null;
}

export function capabilityRuntimeAuthorityMismatch(
  graph: import("../planning/types.js").CapabilityDurablePlanningGraphV1,
  authority: import("./types.js").CapabilityRuntimeAuthorityReaderV1,
  sourceAuthority: import("./types.js").CapabilityRuntimeSourceAuthorityReaderV1 | undefined,
  now: (() => string) | undefined,
): ReturnType<typeof authorityMismatch> {
  if (!now)
    throw new CapabilityRuntimeError(
      "capability authority clock is unavailable",
      CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
    );
  const checkedAt = now();
  const observed = authority.read(graph.plan.scope);
  return capabilityRuntimeAuthorityMismatchAt(
    graph,
    observed,
    authority,
    sourceAuthority,
    checkedAt,
  );
}

export function capabilityRuntimeAuthorityMismatchAt(
  graph: import("../planning/types.js").CapabilityDurablePlanningGraphV1,
  observed: CapabilityRuntimeAuthorityV1,
  authority: import("./types.js").CapabilityRuntimeAuthorityReaderV1,
  sourceAuthority: import("./types.js").CapabilityRuntimeSourceAuthorityReaderV1 | undefined,
  checkedAt: string,
): ReturnType<typeof authorityMismatch> {
  return captureCapabilityRuntimeAuthorityCheck(
    graph,
    observed,
    authority,
    sourceAuthority,
    checkedAt,
  ).reason;
}

export interface CapabilityRuntimeAuthorityCheckV1 {
  checked_at: string;
  observed: CapabilityRuntimeAuthorityV1;
  reason: ReturnType<typeof authorityMismatch>;
}

export function captureCapabilityRuntimeAuthorityCheck(
  graph: import("../planning/types.js").CapabilityDurablePlanningGraphV1,
  observed: CapabilityRuntimeAuthorityV1,
  authority: import("./types.js").CapabilityRuntimeAuthorityReaderV1,
  sourceAuthority: import("./types.js").CapabilityRuntimeSourceAuthorityReaderV1 | undefined,
  checkedAt: string,
): CapabilityRuntimeAuthorityCheckV1 {
  const { plan } = graph;
  const permissionDigest = authority.readPermissionAuthority(graph, checkedAt);
  const sourceAuthoritySetDigest = sourceAuthority
    ? sourceAuthority.readSourceAuthoritySet(graph, checkedAt)
    : observed.source_authority_set_digest;
  const effectiveObserved = {
    ...structuredClone(observed),
    permission_digest: permissionDigest,
    source_authority_set_digest: sourceAuthoritySetDigest,
  };
  return {
    checked_at: checkedAt,
    observed: effectiveObserved,
    reason: authorityMismatch(plan.runtime_closure.authority, effectiveObserved, true),
  };
}

export function capabilityHostTargetIds(plan: CapabilityFabricPlanV1): string[] {
  const hostTargets = plan.target_dispositions
    .filter(
      (disposition) => disposition.execution === ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.HOST,
    )
    .map((disposition) => disposition.target_id);
  if (hostTargets.length === 0)
    throw new CapabilityRuntimeError(
      "an executable capability plan has no canonical host targets",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  return hostTargets;
}
