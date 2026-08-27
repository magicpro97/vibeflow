import type { Engine } from "../core/agent-contract.js";
import type { HostActionKind } from "./host-action-contract.js";
import type { ActionOperationSsePayloadV1, ActionOperationState } from "./protocol-contract.js";
import type { PublicApiErrorBodyV1 } from "./public-error-contract.js";
import type {
  PUBLIC_ACTION_TARGET_APPLY_FAILURE,
  PUBLIC_ACTION_TARGET_HEALTH_FAILURE,
  PUBLIC_ACTION_TARGET_SUBJECT_KIND,
  PublicActionTargetScopeV1,
  PublicOperationPhaseV1,
  PublicOperationProgressStatusV1,
  PublicTargetResultHealthV1,
  PublicTargetResultOutcomeV1,
} from "./public-operation-contract.js";

export type PublicActionTargetV1 = {
  scope: PublicActionTargetScopeV1;
  engine: Engine | null;
  participant_id: string | null;
} & (
  | {
      required: true;
      on_apply_failure: typeof PUBLIC_ACTION_TARGET_APPLY_FAILURE.ABORT_SCOPE;
      on_health_failure: typeof PUBLIC_ACTION_TARGET_HEALTH_FAILURE.ABORT_SCOPE;
    }
  | {
      required: false;
      on_apply_failure: typeof PUBLIC_ACTION_TARGET_APPLY_FAILURE.OMIT_AFTER_ROLLBACK;
      on_health_failure:
        | typeof PUBLIC_ACTION_TARGET_HEALTH_FAILURE.OMIT_AFTER_ROLLBACK
        | typeof PUBLIC_ACTION_TARGET_HEALTH_FAILURE.COMMIT_DEGRADED;
    }
);

export type PublicActionTargetSubjectV1 =
  | {
      kind: typeof PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION;
      action_type: HostActionKind;
      participant_id: string | null;
    }
  | {
      kind: typeof PUBLIC_ACTION_TARGET_SUBJECT_KIND.CAPABILITY;
      package_id: string;
      component_id: string;
    };

export interface PublicOperationProgressV1 {
  sequence: number;
  phase: PublicOperationPhaseV1;
  status: PublicOperationProgressStatusV1;
  message_code: `operation.${PublicOperationPhaseV1}`;
  at: string;
}

export interface PublicTargetResultV1 {
  target_id: string;
  target: PublicActionTargetV1;
  subject: PublicActionTargetSubjectV1;
  outcome: PublicTargetResultOutcomeV1;
  health: PublicTargetResultHealthV1;
  evidence_digest: string | null;
}

export interface ActionOperationEventV1
  extends ActionOperationSsePayloadV1<
    PublicOperationProgressV1,
    PublicTargetResultV1,
    PublicApiErrorBodyV1
  > {
  state: ActionOperationState;
}
