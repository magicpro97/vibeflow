import {
  ACTION_EFFECT_CLASS,
  ACTION_REVERSIBILITY_VALUE,
  ACTION_RISK,
  ACTION_ROOT_LOCATOR_KIND,
} from "../../actions/index.js";
import type { AuthorityRepairPlanV1 } from "../../actions/internal-action-types.js";
import { EMPTY_PERMISSION_DIGEST } from "../../actions/proposal-content-validation.js";
import type { ActionDomain } from "../../actions/public-action-vocabulary-contract.js";
import { assertOpaqueId } from "../../actions/record-primitives.js";
import type { PrivateActionRootLocatorV1 } from "../../actions/types.js";
import { CAPABILITY_SCOPE } from "../../core/capability-contract.js";
import { assertAuthorityRepairDomainLocator } from "./adapter-registry.js";
import { assertAuthorityRepairClosure } from "./closure-records.js";
import {
  AUTHORITY_REPAIR_BINDING_MODE,
  AUTHORITY_REPAIR_CONTROL_STATE,
  AUTHORITY_REPAIR_LIMIT,
  AUTHORITY_REPAIR_SCHEMA_VERSION,
} from "./contract.js";
import { authorityRepairProposedRestoredDigest } from "./digests.js";
import { authorityRepairActionPlanDigest } from "./digests.js";
import { materializeAuthorityRepairPlan } from "./plan-records.js";
import {
  materializeAuthorityRepairActionPlan,
  materializeAuthorityRepairSteps,
  materializeRepairAuthorizationBinding,
} from "./repair-objects.js";
import type {
  AuthorityRepairActionObjectClosureV1,
  AuthorityRepairStepsV1,
  RepairAuthorizationBindingV1,
} from "./types.js";

export type AuthorityRepairControlStateV1 =
  (typeof AUTHORITY_REPAIR_CONTROL_STATE)[keyof typeof AUTHORITY_REPAIR_CONTROL_STATE];

export interface AuthorityRepairPlanningCandidateV1 {
  candidate_id: string;
  control_state: AuthorityRepairControlStateV1;
  action_domain: ActionDomain;
  action_root_locator: PrivateActionRootLocatorV1;
  authorization: Omit<RepairAuthorizationBindingV1, "binding_digest" | "mode">;
  steps: Omit<AuthorityRepairStepsV1, "steps_digest">;
  created_at: string;
  expires_at: string;
}

export interface PlannedAuthorityRepairV1 {
  candidate_id: string;
  closure: AuthorityRepairActionObjectClosureV1;
  action_plan_digest: string;
  bootstrap_required: boolean;
}

/** Pure planner: adapters must supply already validated/checkpoint-bound candidate bytes. */
export function planAuthorityRepair(
  candidate: AuthorityRepairPlanningCandidateV1,
): PlannedAuthorityRepairV1 {
  assertOpaqueId(candidate.candidate_id, "$.authority_repair_candidate.candidate_id");
  if (
    Date.parse(candidate.expires_at) - Date.parse(candidate.created_at) >
    AUTHORITY_REPAIR_LIMIT.PLAN_TTL_MS
  )
    throw new Error("authority repair plan lifetime exceeds the protocol bound");
  const mode =
    candidate.control_state === AUTHORITY_REPAIR_CONTROL_STATE.CURRENT_VALID
      ? AUTHORITY_REPAIR_BINDING_MODE.CURRENT
      : candidate.control_state === AUTHORITY_REPAIR_CONTROL_STATE.RECOVERY_CHECKPOINT_ONLY
        ? AUTHORITY_REPAIR_BINDING_MODE.RECOVERY_CHECKPOINT
        : (() => {
            throw new Error("unknown authority repair control state");
          })();
  const bootstrap =
    candidate.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP;
  if (bootstrap !== (mode === AUTHORITY_REPAIR_BINDING_MODE.RECOVERY_CHECKPOINT))
    throw new Error("current and recovery-checkpoint repair paths cannot be interchanged");
  const authorization = materializeRepairAuthorizationBinding({ ...candidate.authorization, mode });
  const steps = materializeAuthorityRepairSteps(candidate.steps);
  assertAuthorityRepairDomainLocator(steps.domain, steps);
  if (
    authorization.target_domain !== steps.domain ||
    authorization.target_authority_scope !== steps.authority_scope ||
    authorization.target_scope_id !== steps.scope_id
  )
    throw new Error("authority repair candidate authorization and target differ");
  const plan: AuthorityRepairPlanV1 = materializeAuthorityRepairPlan({
    schema_version: AUTHORITY_REPAIR_SCHEMA_VERSION,
    domain: steps.domain,
    authority_scope: steps.authority_scope,
    scope_id: steps.scope_id,
    target_preimage: structuredClone(steps.target_preimage),
    last_valid_record_digest: steps.last_valid_record_digest,
    proposed_restored_authority_digest: authorityRepairProposedRestoredDigest(steps),
    lost_tail_digest: steps.lost_tail_digest,
    journal_identity_digest: steps.journal_identity_digest,
    repair_steps_digest: steps.steps_digest,
    repair_authorization_binding_digest: authorization.binding_digest,
    permission_digest: EMPTY_PERMISSION_DIGEST,
    risk: ACTION_RISK.CRITICAL,
    created_at: candidate.created_at,
    expires_at: candidate.expires_at,
  });
  const effectClass =
    authorization.control_scope === CAPABILITY_SCOPE.USER
      ? ACTION_EFFECT_CLASS.USER_WRITE
      : ACTION_EFFECT_CLASS.PROJECT_WRITE;
  const actionPlan = materializeAuthorityRepairActionPlan({
    domain: candidate.action_domain,
    action_root_locator: candidate.action_root_locator,
    native_plan: plan,
    effect_class: effectClass,
    reversibility: ACTION_REVERSIBILITY_VALUE.MANUAL,
  });
  const closure = { authorization, steps, plan, action_plan: actionPlan };
  assertAuthorityRepairClosure(closure);
  return Object.freeze({
    candidate_id: candidate.candidate_id,
    closure: structuredClone(closure),
    action_plan_digest: authorityRepairActionPlanDigest(actionPlan),
    bootstrap_required: bootstrap,
  });
}
