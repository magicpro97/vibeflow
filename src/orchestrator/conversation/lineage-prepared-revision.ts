import {
  type RevisionReservationRecordV1,
  assertRevisionReservationRecordV1,
} from "./lineage-reservation.js";
import {
  type RevisionOperationV1,
  type RevisionPreparationPlanV1,
  assertOperationReservationClosure,
  assertRevisionOperationV1,
  assertRevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import type { LineageNodeIdentityV1 } from "./lineage-types.js";

export interface PreparedRevisionRecoveryLinkInputV1 {
  operation: unknown;
  revision_plan: unknown;
  reservation: unknown;
}

export interface PreparedRevisionRecoveryLinkV1 {
  root_session_id: string;
  parent: LineageNodeIdentityV1;
  child: LineageNodeIdentityV1;
  operation_id: string;
  operation_header_digest: string;
  reservation_digest: string;
}

function nodeKey(node: LineageNodeIdentityV1): string {
  return `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;
}

export function validatePreparedRevisionRecoveryLink(
  input: PreparedRevisionRecoveryLinkInputV1,
): PreparedRevisionRecoveryLinkV1 {
  assertRevisionOperationV1(input.operation);
  assertRevisionPreparationPlanV1(input.revision_plan);
  assertRevisionReservationRecordV1(input.reservation);
  const operation = input.operation as RevisionOperationV1;
  const plan = input.revision_plan as RevisionPreparationPlanV1;
  const reservation = input.reservation as RevisionReservationRecordV1;
  assertOperationReservationClosure(operation, reservation);
  if (
    plan.root_session_id !== operation.root_session_id ||
    nodeKey(plan.parent) !== nodeKey(operation.parent) ||
    plan.expected_head_digest !== operation.expected_head_digest ||
    plan.expected_reservation_digest !== operation.expected_reservation_digest ||
    plan.expected_reservation_epoch !== operation.expected_reservation_epoch ||
    plan.expected_parent_last_seq !== operation.expected_parent_last_seq ||
    plan.expected_parent_lock_digest !== operation.expected_parent_lock_digest ||
    plan.permission_digest !== operation.permission_digest ||
    plan.revision_claim_epoch !== operation.revision_claim_epoch ||
    plan.resulting_binding_set_digest !== operation.binding_set_digest
  )
    throw new Error("prepared revision recovery authority is not closed");
  return {
    root_session_id: operation.root_session_id,
    parent: structuredClone(operation.parent),
    child: structuredClone(operation.child),
    operation_id: operation.operation_id,
    operation_header_digest: operation.header_digest,
    reservation_digest: reservation.content_digest,
  };
}

export function preparedRevisionRecoveryLinkMap(
  inputs: readonly PreparedRevisionRecoveryLinkInputV1[],
): ReadonlyMap<string, PreparedRevisionRecoveryLinkV1> {
  const byChild = new Map<string, PreparedRevisionRecoveryLinkV1>();
  for (const input of inputs) {
    const link = validatePreparedRevisionRecoveryLink(input);
    if (byChild.has(link.child.conversation_id))
      throw new Error("duplicate prepared revision recovery child");
    byChild.set(link.child.conversation_id, link);
  }
  return byChild;
}
