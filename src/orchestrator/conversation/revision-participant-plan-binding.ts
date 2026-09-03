import { conversationRevisionActionPlanDigest } from "./conversation-revision-action-plan.js";
import {
  type RevisionOperationV1,
  type RevisionPreparationPlanV1,
  assertRevisionOperationV1,
  assertRevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import {
  type ParticipantStartReceiptV1,
  assertParticipantStartReceiptV1,
} from "./revision-participant-receipt.js";

export const REVISION_OPERATION_PLAN_SHARED_FIELDS = Object.freeze([
  "expected_head_digest",
  "expected_parent_last_seq",
  "expected_parent_lock_digest",
  "expected_reservation_digest",
  "expected_reservation_epoch",
  "permission_digest",
  "revision_claim_epoch",
  "root_session_id",
] as const satisfies readonly (keyof RevisionOperationV1 & keyof RevisionPreparationPlanV1)[]);

export const REVISION_PARTICIPANT_RECEIPT_PLAN_FIELDS = Object.freeze([
  "adapter_fingerprint",
  "engine",
  "model",
  "reconciliation_mode",
] as const satisfies readonly (keyof ParticipantStartReceiptV1 &
  keyof RevisionPreparationPlanV1["participant_starts"][number])[]);

function sameParent(operation: RevisionOperationV1, plan: RevisionPreparationPlanV1): boolean {
  return (
    operation.parent.conversation_id === plan.parent.conversation_id &&
    operation.parent.revision_id === plan.parent.revision_id &&
    operation.parent.revision_ordinal === plan.parent.revision_ordinal
  );
}

export function assertRevisionOperationPlanBinding(
  operation: RevisionOperationV1,
  plan: RevisionPreparationPlanV1,
): void {
  assertRevisionOperationV1(operation);
  assertRevisionPreparationPlanV1(plan);
  for (const field of REVISION_OPERATION_PLAN_SHARED_FIELDS)
    if (operation[field] !== plan[field])
      throw new Error(`revision operation preparation plan ${field} mismatch`);
  if (
    !sameParent(operation, plan) ||
    conversationRevisionActionPlanDigest(operation.root_session_id, plan) !==
      operation.plan_digest ||
    operation.binding_set_digest !== plan.resulting_binding_set_digest ||
    operation.handoff_selection_digest !== plan.handoff_selection_plan_digest
  )
    throw new Error("revision operation preparation plan binding mismatch");
}

export function assertParticipantStartReceiptPlanBinding(
  operation: RevisionOperationV1,
  plan: RevisionPreparationPlanV1,
  receipt: ParticipantStartReceiptV1,
): void {
  assertRevisionOperationPlanBinding(operation, plan);
  assertParticipantStartReceiptV1(receipt);
  if (receipt.operation_id !== operation.operation_id)
    throw new Error("participant receipt operation mismatch");
  const participant = plan.participant_starts.find(
    ({ participant_id }) => participant_id === receipt.participant_id,
  );
  if (!participant) throw new Error("participant receipt is absent from preparation plan");
  for (const field of REVISION_PARTICIPANT_RECEIPT_PLAN_FIELDS)
    if (receipt[field] !== participant[field])
      throw new Error(`participant receipt ${field} preparation binding mismatch`);
  if (
    receipt.shared_prompt_digest !== operation.prompt_projection_digest ||
    receipt.wrapper_digest !== participant.wrapper_descriptor_digest ||
    (receipt.cancellation_mode !== null &&
      receipt.cancellation_mode !== participant.cancellation_mode)
  )
    throw new Error("participant receipt prompt, wrapper, or cancellation binding mismatch");
}
