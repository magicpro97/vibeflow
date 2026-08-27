import { validateRepairPlan } from "../../actions/internal-repair-validation.js";
import { EMPTY_PERMISSION_DIGEST } from "../../actions/proposal-content-validation.js";
import { assertAuthorityRepairDomainLocator } from "./adapter-registry.js";
import { assertAuthorityRepairActionPlan } from "./repair-objects.js";
import { assertAuthorityRepairSteps, assertRepairAuthorizationBinding } from "./repair-objects.js";
import type { AuthorityRepairActionObjectClosureV1 } from "./types.js";
import { exact, invalid } from "./validation.js";

export function assertAuthorityRepairClosure(
  value: AuthorityRepairActionObjectClosureV1,
): AuthorityRepairActionObjectClosureV1 {
  const binding = assertRepairAuthorizationBinding(value.authorization);
  const steps = assertAuthorityRepairSteps(value.steps);
  assertAuthorityRepairDomainLocator(steps.domain, steps);
  validateRepairPlan(value.plan);
  assertAuthorityRepairActionPlan(value.action_plan, value.plan);
  if (
    binding.target_domain !== value.plan.domain ||
    binding.target_authority_scope !== value.plan.authority_scope ||
    binding.target_scope_id !== value.plan.scope_id ||
    binding.binding_digest !== value.plan.repair_authorization_binding_digest ||
    steps.domain !== value.plan.domain ||
    steps.authority_scope !== value.plan.authority_scope ||
    steps.scope_id !== value.plan.scope_id ||
    steps.steps_digest !== value.plan.repair_steps_digest ||
    !exact(steps.target_preimage, value.plan.target_preimage) ||
    steps.last_valid_record_digest !== value.plan.last_valid_record_digest ||
    steps.lost_tail_digest !== value.plan.lost_tail_digest ||
    steps.journal_identity_digest !== value.plan.journal_identity_digest ||
    value.plan.permission_digest !== EMPTY_PERMISSION_DIGEST
  )
    invalid("repair action objects do not form one immutable closure");
  return value;
}
