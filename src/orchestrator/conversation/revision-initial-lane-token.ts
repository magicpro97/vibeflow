import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import { foldRevisionOperation } from "./revision-fold.js";
import type { InitialRevisionLaneTokenV1 } from "./revision-initial-lane-authority.js";
import type { ParticipantStartReceiptV1 } from "./revision-participant-receipt.js";
import { participantStartAttemptKey } from "./revision-participant-receipt.js";
import type { RevisionOperationEventV1 } from "./revision-planner.js";

export function missingInitialRevisionLaneToken(
  operation: RevisionOperationV1,
  plan: RevisionPreparationPlanV1,
  participant: RevisionPreparationPlanV1["participant_starts"][number],
  events: RevisionOperationEventV1[],
  now: string,
): InitialRevisionLaneTokenV1 {
  return {
    operation,
    participant,
    attempt_key: participantStartAttemptKey({
      operation_id: operation.operation_id,
      participant_id: participant.participant_id,
      start_generation: 0,
    }),
    prepared_at:
      (events.at(-1)?.recorded_at ?? operation.created_at) > now
        ? (events.at(-1)?.recorded_at ?? operation.created_at)
        : now,
    effect_action_operation_id: foldRevisionOperation(operation, events, {
      preparationPlan: plan,
    }).effect_action_operation_id,
  };
}

export function initialRevisionLaneTokenFromReceipt(
  operation: RevisionOperationV1,
  participant: RevisionPreparationPlanV1["participant_starts"][number],
  receipt: ParticipantStartReceiptV1,
  effect: string,
): InitialRevisionLaneTokenV1 {
  return {
    operation,
    participant,
    attempt_key: receipt.attempt_key,
    prepared_at: receipt.prepared_at,
    effect_action_operation_id: effect,
  };
}

export function initialRevisionLaneReceiptEvidence(
  receipt: ParticipantStartReceiptV1,
): { ref: string; digest: string } | null {
  const ref = receipt.private_native_session_ref ?? receipt.private_process_lease_ref;
  const digest =
    receipt.private_native_session_producer_receipt_digest ??
    receipt.private_process_lease_producer_receipt_digest;
  return ref && digest ? { ref, digest } : null;
}
