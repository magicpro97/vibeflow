import {
  ACTION_EFFECT_CLASSES,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  type ActionEffectClass,
} from "../../actions/index.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { validateCapabilityFabricPlan } from "../operations/validation.js";
import type { CapabilityAdapterPlanV1, CapabilityFabricPlanV1 } from "../planning/types.js";
import type { CapabilityActionPlanBindingV1 } from "./types.js";

const EFFECT_ORDER: readonly ActionEffectClass[] = ACTION_EFFECT_CLASSES;

function stepEffects(plan: CapabilityAdapterPlanV1): ActionEffectClass[] {
  return EFFECT_ORDER.filter((effect) =>
    plan.steps.some((step) => step.effect_classes.includes(effect)),
  );
}

export function capabilityActionPlanDigest(value: CapabilityActionPlanBindingV1): string {
  return digestV1("VF-ACTION-PLAN\0v1\0", value);
}

export function materializeCapabilityActionPlan(
  input: CapabilityFabricPlanV1,
): CapabilityActionPlanBindingV1 {
  const plan = validateCapabilityFabricPlan(input);
  return {
    schema_version: "1.0",
    domain: "capability",
    action_root_locator: structuredClone(plan.action_root_locator),
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    execution_object_closure_digest: plan.execution_closure_digest,
    permission_digest: plan.permission_digest,
    steps: plan.adapter_plans.map((adapterPlan, order) => ({
      order,
      step_id: adapterPlan.plan_id,
      plan_kind: "capability-adapter",
      plan_digest: adapterPlan.plan_digest,
      target_ids: adapterPlan.targets.map((target) => target.target_id),
      effect_classes: stepEffects(adapterPlan),
      reversibility: adapterPlan.reversibility,
    })),
  };
}

export function assertCapabilityActionPlan(
  value: CapabilityActionPlanBindingV1,
  plan: CapabilityFabricPlanV1,
): void {
  const expected = materializeCapabilityActionPlan(plan);
  if (canonicalJson(value) !== canonicalJson(expected))
    throw new CapabilityRuntimeError(
      "capability action plan does not bind the exact Fabric plan",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
}
