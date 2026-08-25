import type {
  ActionEffectClass,
  ActionPlanningOptionsV1,
  ActionProposalV1,
  PrivateActionRootLocatorV1,
  Reversibility,
} from "../../actions/index.js";

export interface CapabilityActionPlanBindingV1 {
  schema_version: "1.0";
  domain: "capability";
  action_root_locator: Exclude<PrivateActionRootLocatorV1, { kind: "recovery-bootstrap" }>;
  planning_options: ActionPlanningOptionsV1;
  execution_object_closure_digest: string;
  permission_digest: string;
  steps: Array<{
    order: number;
    step_id: string;
    plan_kind: "capability-adapter";
    plan_digest: string;
    target_ids: string[];
    effect_classes: ActionEffectClass[];
    reversibility: Reversibility;
  }>;
}

export type CapabilityActionGraphV1 = {
  proposal: ActionProposalV1;
} & import("../planning/types.js").CapabilityDurablePlanningGraphV1;
