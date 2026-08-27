import {
  ACTION_DOMAIN,
  ACTION_EFFECT_CLASS,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTION_REVERSIBILITY,
  ACTION_ROOT_LOCATOR_KIND,
  ACTION_SCOPE,
} from "../../actions/index.js";
import type { AuthorityRepairPlanV1 } from "../../actions/internal-action-types.js";
import { validateRepairPlan } from "../../actions/internal-repair-validation.js";
import { EMPTY_PERMISSION_DIGEST } from "../../actions/proposal-content-validation.js";
import { exactObject } from "../../actions/strict-json.js";
import { digestHex } from "../../durability/index.js";
import { AUTHORITY_REPAIR_PLAN_KIND, AUTHORITY_REPAIR_SCHEMA_VERSION } from "./contract.js";
import type { AuthorityRepairActionPlanBindingV1 } from "./types.js";
import { assertPrivateActionRootLocator, invalid } from "./validation.js";

export function materializeAuthorityRepairActionPlan(input: {
  domain: AuthorityRepairActionPlanBindingV1["domain"];
  action_root_locator: AuthorityRepairActionPlanBindingV1["action_root_locator"];
  native_plan: AuthorityRepairPlanV1;
  effect_class: typeof ACTION_EFFECT_CLASS.PROJECT_WRITE | typeof ACTION_EFFECT_CLASS.USER_WRITE;
  reversibility: AuthorityRepairActionPlanBindingV1["steps"][0]["reversibility"];
}): AuthorityRepairActionPlanBindingV1 {
  return assertAuthorityRepairActionPlan(
    {
      schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
      domain: input.domain,
      action_root_locator: structuredClone(input.action_root_locator),
      planning_options: {
        mode: ACTION_PLANNING_MODE.DURABLE,
        network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
      },
      execution_object_closure_digest: null,
      permission_digest: input.native_plan.permission_digest,
      steps: [
        {
          order: 0,
          step_id: `authority-repair-${digestHex(input.native_plan.plan_digest).slice(0, 26)}`,
          plan_kind: AUTHORITY_REPAIR_PLAN_KIND,
          plan_digest: input.native_plan.plan_digest,
          target_ids: [],
          effect_classes: [input.effect_class],
          reversibility: input.reversibility,
        },
      ],
    },
    input.native_plan,
  );
}

export function assertAuthorityRepairActionPlan(
  value: AuthorityRepairActionPlanBindingV1,
  plan: AuthorityRepairPlanV1,
): AuthorityRepairActionPlanBindingV1 {
  exactObject(
    value,
    [
      "schema_version",
      "domain",
      "action_root_locator",
      "planning_options",
      "execution_object_closure_digest",
      "permission_digest",
      "steps",
    ],
    [],
    "$.action_plan",
  );
  validateRepairPlan(plan);
  assertPrivateActionRootLocator(value.action_root_locator);
  const step = value.steps[0];
  exactObject(
    value.planning_options,
    ["mode", "network_read"],
    [],
    "$.action_plan.planning_options",
  );
  if (step)
    exactObject(
      step,
      [
        "order",
        "step_id",
        "plan_kind",
        "plan_digest",
        "target_ids",
        "effect_classes",
        "reversibility",
      ],
      [],
      "$.action_plan.steps[0]",
    );
  const kind = value.action_root_locator.kind;
  const expectedDomain =
    plan.authority_scope === ACTION_SCOPE.CONVERSATION
      ? ACTION_DOMAIN.CONVERSATION
      : ACTION_DOMAIN.CAPABILITY;
  if (
    value.schema_version !== AUTHORITY_REPAIR_SCHEMA_VERSION ||
    value.domain !== expectedDomain ||
    value.execution_object_closure_digest !== null ||
    value.permission_digest !== EMPTY_PERMISSION_DIGEST ||
    value.permission_digest !== plan.permission_digest ||
    value.planning_options.mode !== ACTION_PLANNING_MODE.DURABLE ||
    value.planning_options.network_read !==
      ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY ||
    value.steps.length !== 1 ||
    !step ||
    step.order !== 0 ||
    step.step_id !== `authority-repair-${digestHex(plan.plan_digest).slice(0, 26)}` ||
    step.plan_kind !== AUTHORITY_REPAIR_PLAN_KIND ||
    step.plan_digest !== plan.plan_digest ||
    step.target_ids.length !== 0 ||
    step.effect_classes.length !== 1 ||
    (step.effect_classes[0] !== ACTION_EFFECT_CLASS.PROJECT_WRITE &&
      step.effect_classes[0] !== ACTION_EFFECT_CLASS.USER_WRITE) ||
    !ACTION_REVERSIBILITY.some((candidate) => candidate === step.reversibility) ||
    (kind !== ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP && kind !== value.domain)
  )
    invalid("action plan is not one exact authority-repair step");
  if (
    kind === ACTION_ROOT_LOCATOR_KIND.CONVERSATION &&
    (plan.authority_scope !== ACTION_SCOPE.CONVERSATION ||
      value.action_root_locator.root_session_id !== plan.scope_id)
  )
    invalid("conversation repair action root differs from its target origin");
  if (
    kind === ACTION_ROOT_LOCATOR_KIND.CAPABILITY &&
    (value.action_root_locator.scope !== plan.authority_scope ||
      value.action_root_locator.scope_identity_digest !== plan.scope_id)
  )
    invalid("capability repair action root differs from its target origin");
  return value;
}
