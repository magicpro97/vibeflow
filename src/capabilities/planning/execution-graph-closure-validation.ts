import { canonicalJson } from "../../durability/index.js";
import type { CapabilityActionPlanBindingV1 } from "../action-domain/types.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import type { CapabilityAdapterSetBindingV1 } from "./execution-types.js";
import type { CapabilityAdapterPlanV1, CapabilityDurablePlanningGraphV1 } from "./types.js";

const EFFECT_ORDER: readonly import("../../actions/types.js").ActionEffectClass[] = [
  "pure-local-read",
  "local-read-with-cache",
  "network-read",
  "process-probe",
  "project-write",
  "user-write",
  "external-compensatable",
  "external-irreversible",
];

function fail(message: string): never {
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

export function assertCapabilityGraphOuterClosure(graph: CapabilityDurablePlanningGraphV1): void {
  const { plan, execution_closure: closure, action_plan: actionPlan } = graph;
  const authority = plan.runtime_closure.authority;
  if (
    plan.scope !== closure.scope ||
    plan.scope_identity_digest !== closure.scope_identity_digest ||
    canonicalJson(plan.action_root_locator) !== canonicalJson(closure.action_root_locator) ||
    plan.adapter_registry_digest !== closure.adapter_registry_digest ||
    plan.adapter_set_digest !== closure.adapter_set_digest ||
    plan.permission_digest !== closure.permission_digest ||
    plan.source_authority_set_digest !== closure.source_authority_set_digest ||
    authority.scope !== closure.scope ||
    authority.scope_identity_digest !== closure.scope_identity_digest ||
    authority.source_authority_set_digest !== closure.source_authority_set_digest ||
    actionPlan.schema_version !== "1.0" ||
    actionPlan.domain !== "capability" ||
    actionPlan.permission_digest !== closure.permission_digest ||
    canonicalJson(actionPlan.action_root_locator) !== canonicalJson(closure.action_root_locator)
  )
    fail("Fabric plan escaped its durable execution closure");
}

export function assertCapabilityActionPlanStep(
  action: CapabilityActionPlanBindingV1["steps"][number],
  plan: CapabilityAdapterPlanV1,
  order: number,
): void {
  const targetIds = plan.targets.map((target) => target.target_id).sort(bytewise);
  const effectClasses = EFFECT_ORDER.filter((effect) =>
    plan.steps.some((step) => step.effect_classes.includes(effect)),
  );
  if (
    action.order !== order ||
    action.plan_kind !== "capability-adapter" ||
    action.step_id !== plan.plan_id ||
    action.plan_digest !== plan.plan_digest ||
    canonicalJson(action.target_ids) !== canonicalJson(targetIds) ||
    canonicalJson(action.effect_classes) !== canonicalJson(effectClasses) ||
    action.reversibility !== plan.reversibility
  )
    fail("action plan step is not the exact adapter-plan projection");
}

export function assertCapabilityAdapterSet(
  value: CapabilityAdapterSetBindingV1,
  plans: readonly CapabilityAdapterPlanV1[],
  registryDigest: string,
): void {
  const expected: CapabilityAdapterSetBindingV1 = {
    schema_version: "1.0",
    adapter_registry_digest: registryDigest,
    adapters: plans.map((plan) => ({
      ...plan.adapter,
      target_ids: plan.targets.map((target) => target.target_id),
    })),
  };
  if (canonicalJson(value) !== canonicalJson(expected))
    fail("adapter set is not the exact dense adapter-plan binding");
}

export function assertCapabilitySnapshotSet(
  graph: CapabilityDurablePlanningGraphV1,
  plans: readonly CapabilityAdapterPlanV1[],
): void {
  const expected = plans.map((plan) => plan.inspection_snapshot_digest).sort(bytewise);
  const observed = graph.plan.runtime_closure.snapshots
    .map((snapshot) => snapshot.snapshot_digest)
    .sort(bytewise);
  if (
    new Set(expected).size !== expected.length ||
    new Set(observed).size !== observed.length ||
    canonicalJson(expected) !== canonicalJson(observed)
  )
    fail("runtime snapshot set is not exactly the adapter-plan snapshot set");
}
