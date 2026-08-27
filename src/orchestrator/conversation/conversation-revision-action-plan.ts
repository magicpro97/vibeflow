import { ACTION_ROOT_LOCATOR_KIND, EMPTY_PERMISSION_DIGEST } from "../../actions/index.js";
import {
  ACTION_DOMAIN,
  ACTION_EFFECT_CLASS,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTION_REVERSIBILITY_VALUE,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "../../actions/public-action-contract.js";
import { digestV1 } from "../../durability/index.js";
import { LINEAGE_PLAN_KIND, type LineageActionPlanBindingV1 } from "./lineage-action-authority.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";

export const CONVERSATION_REVISION_ACTION_PLAN_DIGEST_DOMAIN = "VF-ACTION-PLAN\0v1\0" as const;

export function materializeConversationRevisionActionPlan(
  rootSessionId: string,
  revisionPlan: RevisionPreparationPlanV1,
): LineageActionPlanBindingV1 {
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    domain: ACTION_DOMAIN.CONVERSATION,
    action_root_locator: {
      kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
      root_session_id: rootSessionId,
    },
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    execution_object_closure_digest: null,
    permission_digest: EMPTY_PERMISSION_DIGEST,
    steps: [
      {
        order: 0,
        step_id: "revision-operation-0",
        plan_kind: LINEAGE_PLAN_KIND.REVISION_OPERATION,
        plan_digest: revisionPlan.plan_digest,
        target_ids: [],
        effect_classes: [ACTION_EFFECT_CLASS.PROJECT_WRITE],
        reversibility: ACTION_REVERSIBILITY_VALUE.REVERSIBLE,
      },
    ],
  };
}

export const conversationRevisionActionPlanDigest = (
  rootSessionId: string,
  revisionPlan: RevisionPreparationPlanV1,
): string =>
  digestV1(
    CONVERSATION_REVISION_ACTION_PLAN_DIGEST_DOMAIN,
    materializeConversationRevisionActionPlan(rootSessionId, revisionPlan),
  );
