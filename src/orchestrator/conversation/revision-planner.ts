import { digestHex, digestV1 } from "../../durability/index.js";
import {
  type RevisionReservationRecordV1,
  revisionReservationDigest,
} from "./lineage-reservation.js";
import {
  type RevisionOperationV1,
  type RevisionPreparationPlanV1,
  assertRevisionOperationV1,
  assertRevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import {
  type LineageHeadRecordV1,
  type LineageNodeIdentityV1,
  lineageHeadDigest,
} from "./lineage-types.js";
import type { ParticipantStartReceiptV1 } from "./revision-participant-receipt.js";

export type RevisionOperationStateV1 =
  | "preparing"
  | "prepared"
  | "published"
  | "starting"
  | "started"
  | "abandoned"
  | "start_failed"
  | "needs_recovery";

export interface RevisionActionTerminalBindingV1 {
  action_operation_id: string;
  outcome: "succeeded" | "failed" | "needs_recovery";
  reason_code: string | null;
}

export type RevisionOperationPayloadV1 =
  | {
      kind: "state-transition";
      from: RevisionOperationStateV1 | "created";
      to: RevisionOperationStateV1;
      authorized_by_action_operation_id: string;
      effect_action_operation_id: string;
      action_terminals: RevisionActionTerminalBindingV1[];
      reason_code: string | null;
    }
  | {
      kind: "participant-start";
      authorized_by_action_operation_id: string;
      effect_action_operation_id: string;
      receipt: ParticipantStartReceiptV1;
    }
  | {
      kind: "reconciliation-result";
      authorized_by_action_operation_id: string;
      effect_action_operation_id: string;
      observed_state_digest: string;
      outcome: "failed";
      action_terminals: RevisionActionTerminalBindingV1[];
      reason_code: string;
    }
  | {
      kind: "head-commit";
      authorized_by_action_operation_id: string;
      effect_action_operation_id: string;
      prior_head_digest: string;
      prior_head_checkpoint_digest: string;
      committed_head_digest: string;
      directory_fsync_completed: true;
    };

export interface RevisionOperationEventV1 {
  schema_version: "1.0";
  operation_id: string;
  sequence: number;
  previous_event_digest: string | null;
  payload: RevisionOperationPayloadV1;
  recorded_at: string;
  event_digest: string;
}

export interface DeriveRevisionChildIdentityInputV1 {
  root_session_id: string;
  parent_conversation_id: string;
  parent_revision_id: string;
  proposal_id: string;
  revision_claim_epoch: number;
  revision_ordinal: number;
}

export function deriveRevisionChildIdentity(
  input: DeriveRevisionChildIdentityInputV1,
): LineageNodeIdentityV1 {
  if (!Number.isSafeInteger(input.revision_claim_epoch) || input.revision_claim_epoch < 1)
    throw new Error("invalid revision claim epoch");
  if (!Number.isSafeInteger(input.revision_ordinal) || input.revision_ordinal < 1)
    throw new Error("invalid revision ordinal");
  const digest = digestV1("VF-CONVERSATION-CHILD\0v1\0", {
    schema_version: "1.0",
    root_session_id: input.root_session_id,
    parent_conversation_id: input.parent_conversation_id,
    parent_revision_id: input.parent_revision_id,
    proposal_id: input.proposal_id,
    revision_claim_epoch: input.revision_claim_epoch,
  });
  const suffix = digestHex(digest).slice(0, 32);
  return {
    conversation_id: `conversation-${suffix}`,
    revision_id: `revision-${suffix}`,
    revision_ordinal: input.revision_ordinal,
  };
}

type RevisionOperationInputV1 = Omit<
  RevisionOperationV1,
  "schema_version" | "reservation_epoch" | "handoff_profile" | "handoff_id" | "header_digest"
>;

export function materializeRevisionOperation(input: RevisionOperationInputV1): RevisionOperationV1 {
  const preimage: Omit<RevisionOperationV1, "header_digest"> = {
    schema_version: "1.0",
    ...structuredClone(input),
    reservation_epoch: input.expected_reservation_epoch + 1,
    handoff_profile: "vf-public-handoff/1",
    handoff_id: `vf-handoff-${digestHex(input.handoff_digest)}`,
  };
  const operation: RevisionOperationV1 = {
    ...preimage,
    header_digest: digestV1("VF-REVISION-OPERATION\0v1\0", preimage),
  };
  assertRevisionOperationV1(operation);
  return operation;
}

export function materializeRevisionReservation(
  operation: RevisionOperationV1,
): RevisionReservationRecordV1 {
  const preimage: Omit<RevisionReservationRecordV1, "content_digest"> = {
    schema_version: "1.0",
    root_session_id: operation.root_session_id,
    reservation_epoch: operation.reservation_epoch,
    previous_reservation_digest: operation.expected_reservation_digest,
    status: "active",
    parent: structuredClone(operation.parent),
    revision_claim_epoch: operation.revision_claim_epoch,
    operation_id: operation.operation_id,
    proposal_id: operation.proposal_id,
    plan_digest: operation.plan_digest,
    child: structuredClone(operation.child),
    created_at: operation.created_at,
    updated_at: operation.created_at,
  };
  return { ...preimage, content_digest: revisionReservationDigest(preimage) };
}

export function materializeConsumedRevisionReservation(
  active: RevisionReservationRecordV1,
  recordedAt = active.updated_at,
): RevisionReservationRecordV1 {
  const { content_digest: _digest, ...current } = structuredClone(active);
  const preimage: Omit<RevisionReservationRecordV1, "content_digest"> = {
    ...current,
    reservation_epoch: active.reservation_epoch + 1,
    previous_reservation_digest: active.content_digest,
    status: "consumed",
    updated_at: recordedAt,
  };
  return { ...preimage, content_digest: revisionReservationDigest(preimage) };
}

export function materializeReleasedRevisionReservation(
  active: RevisionReservationRecordV1,
  recordedAt = active.updated_at,
): RevisionReservationRecordV1 {
  const { content_digest: _digest, ...current } = structuredClone(active);
  const preimage: Omit<RevisionReservationRecordV1, "content_digest"> = {
    ...current,
    reservation_epoch: active.reservation_epoch + 1,
    previous_reservation_digest: active.content_digest,
    status: "released",
    updated_at: recordedAt,
  };
  return { ...preimage, content_digest: revisionReservationDigest(preimage) };
}

export function materializeRevisionEvent(
  operation: RevisionOperationV1,
  events: readonly RevisionOperationEventV1[],
  payload: RevisionOperationPayloadV1,
  recordedAt = operation.created_at,
): RevisionOperationEventV1 {
  const prior = events.at(-1);
  const preimage: Omit<RevisionOperationEventV1, "event_digest"> = {
    schema_version: "1.0",
    operation_id: operation.operation_id,
    sequence: events.length,
    previous_event_digest: prior?.event_digest ?? null,
    payload: structuredClone(payload),
    recorded_at: recordedAt,
  };
  return {
    ...preimage,
    event_digest: digestV1("VF-REVISION-OPERATION-EVENT\0v1\0", preimage),
  };
}

export function materializeRevisionPreparationPlan(
  input: Omit<RevisionPreparationPlanV1, "schema_version" | "plan_digest">,
): RevisionPreparationPlanV1 {
  const preimage: Omit<RevisionPreparationPlanV1, "plan_digest"> = {
    schema_version: "1.0",
    ...structuredClone(input),
    participant_starts: structuredClone(input.participant_starts).sort((left, right) =>
      Buffer.compare(Buffer.from(left.participant_id), Buffer.from(right.participant_id)),
    ),
  };
  const plan = {
    ...preimage,
    plan_digest: digestV1("VF-REVISION-PREPARATION-PLAN\0v1\0", preimage),
  };
  assertRevisionPreparationPlanV1(plan);
  return plan;
}

export function materializeRevisionHead(
  prior: LineageHeadRecordV1,
  operation: RevisionOperationV1,
): LineageHeadRecordV1 {
  if (
    prior.head_status !== "committed" ||
    prior.active === null ||
    prior.content_digest !== operation.expected_head_digest
  )
    throw new Error("revision parent is not the committed head");
  const preimage: Omit<LineageHeadRecordV1, "content_digest"> = {
    schema_version: "1.0",
    root_session_id: operation.root_session_id,
    head_status: "committed",
    active: structuredClone(operation.child),
    candidate_heads: [],
    head_epoch: prior.head_epoch + 1,
    previous_head_digest: prior.content_digest,
    updated_by_operation_id: operation.operation_id,
    updated_at: operation.created_at,
  };
  return { ...preimage, content_digest: lineageHeadDigest(preimage) };
}
