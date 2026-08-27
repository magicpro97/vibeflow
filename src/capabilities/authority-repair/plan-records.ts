import type { AuthorityRepairPlanV1 } from "../../actions/internal-action-types.js";
import { validateRepairPlan } from "../../actions/internal-repair-validation.js";
import { digestHex, digestV1 } from "../../durability/index.js";
import { AUTHORITY_REPAIR_DIGEST_DOMAIN } from "./contract.js";

export function materializeAuthorityRepairPlan(
  draft: Omit<AuthorityRepairPlanV1, "repair_id" | "plan_digest">,
): AuthorityRepairPlanV1 {
  const planDigest = digestV1(AUTHORITY_REPAIR_DIGEST_DOMAIN.PLAN, draft);
  const value = {
    ...structuredClone(draft),
    repair_id: `vf-authority-repair-${digestHex(planDigest)}`,
    plan_digest: planDigest,
  };
  validateRepairPlan(value);
  return value;
}
