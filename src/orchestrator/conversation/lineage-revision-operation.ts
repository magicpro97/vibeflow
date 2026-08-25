import { digestV1 } from "../../durability/index.js";
import type { RevisionReservationRecordV1 } from "./lineage-reservation.js";
import {
  type LineageNodeIdentityV1,
  assertLineageNodeIdentityV1,
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

const OPERATION_ID = /^vf-operation-[0-9a-f]{64}$/;
const PROPOSAL_ID = /^vf-proposal-[0-9a-f]{64}$/;
const APPROVAL_ID = /^vf-approval-[0-9a-f]{64}$/;
const HANDOFF_ID = /^vf-handoff-[0-9a-f]{64}$/;

export interface RevisionPreparationPlanV1 {
  schema_version: "1.0";
  root_session_id: string;
  parent: LineageNodeIdentityV1;
  expected_head_digest: string;
  expected_head_epoch: number;
  expected_reservation_digest: string | null;
  expected_reservation_epoch: number;
  expected_parent_last_seq: number;
  expected_parent_lock_digest: string;
  permission_digest: string;
  revision_claim_epoch: number;
  binding_delta_digest: string;
  resulting_binding_set_digest: string;
  handoff_selection_plan_digest: string;
  participant_starts: Array<{
    participant_id: string;
    engine: "claude" | "codex" | "copilot" | "opencode" | "antigravity";
    model: string | null;
    adapter_fingerprint: string;
    reconciliation_mode: "provider-idempotency" | "inspect-start" | "vf-process-lease";
    cancellation_mode: "idempotent-cancel" | "inspect-cancel" | "vf-process-lease";
    wrapper_descriptor_digest: string;
    max_shared_prompt_bytes: number;
  }>;
  created_at: string;
  expires_at: string;
  plan_digest: string;
}

export interface RevisionOperationV1 {
  schema_version: "1.0";
  operation_id: string;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  plan_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
  root_session_id: string;
  parent: LineageNodeIdentityV1;
  child: LineageNodeIdentityV1;
  expected_head_digest: string;
  expected_reservation_digest: string | null;
  expected_reservation_epoch: number;
  reservation_epoch: number;
  revision_claim_epoch: number;
  expected_parent_last_seq: number;
  expected_parent_lock_digest: string;
  permission_digest: string;
  binding_set_digest: string;
  handoff_profile: "vf-public-handoff/1";
  handoff_id: string;
  handoff_digest: string;
  handoff_selection_digest: string;
  prompt_projection_digest: string;
  created_at: string;
  header_digest: string;
}

export interface RevisionHeadCommitEventV1 {
  schema_version: "1.0";
  operation_id: string;
  sequence: number;
  previous_event_digest: string | null;
  payload: {
    kind: "head-commit";
    authorized_by_action_operation_id: string;
    effect_action_operation_id: string;
    prior_head_digest: string;
    prior_head_checkpoint_digest: string;
    committed_head_digest: string;
    directory_fsync_completed: true;
  };
  recorded_at: string;
  event_digest: string;
}

export function assertRevisionPreparationPlanV1(
  value: unknown,
): asserts value is RevisionPreparationPlanV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "binding_delta_digest",
      "created_at",
      "expected_head_digest",
      "expected_head_epoch",
      "expected_parent_last_seq",
      "expected_parent_lock_digest",
      "expected_reservation_digest",
      "expected_reservation_epoch",
      "expires_at",
      "handoff_selection_plan_digest",
      "parent",
      "participant_starts",
      "permission_digest",
      "plan_digest",
      "resulting_binding_set_digest",
      "revision_claim_epoch",
      "root_session_id",
      "schema_version",
    ]) ||
    value.schema_version !== "1.0" ||
    !isBoundedLineageReference(value.root_session_id) ||
    !Number.isSafeInteger(value.expected_head_epoch) ||
    (value.expected_head_epoch as number) < 0 ||
    !Number.isSafeInteger(value.expected_reservation_epoch) ||
    (value.expected_reservation_epoch as number) < 0 ||
    !Number.isSafeInteger(value.expected_parent_last_seq) ||
    (value.expected_parent_last_seq as number) < 0 ||
    !Number.isSafeInteger(value.revision_claim_epoch) ||
    (value.revision_claim_epoch as number) < 1 ||
    !Array.isArray(value.participant_starts) ||
    value.participant_starts.length > 64 ||
    !isMillisecondIsoDate(value.created_at) ||
    !isMillisecondIsoDate(value.expires_at) ||
    value.expires_at <= value.created_at
  )
    throw new Error("invalid revision preparation plan");
  for (const field of [
    "expected_head_digest",
    "expected_parent_lock_digest",
    "permission_digest",
    "binding_delta_digest",
    "resulting_binding_set_digest",
    "handoff_selection_plan_digest",
    "plan_digest",
  ])
    if (!isLineageDigest(value[field])) throw new Error("invalid revision preparation digest");
  if (
    value.expected_reservation_digest !== null &&
    !isLineageDigest(value.expected_reservation_digest)
  )
    throw new Error("invalid revision preparation reservation digest");
  if ((value.expected_reservation_epoch === 0) !== (value.expected_reservation_digest === null))
    throw new Error("invalid revision preparation reservation pair");
  assertLineageNodeIdentityV1(value.parent);
  const participants = value.participant_starts;
  for (const [index, participant] of participants.entries()) {
    if (
      !isPlainLineageRecord(participant) ||
      !hasExactLineageKeys(participant, [
        "adapter_fingerprint",
        "cancellation_mode",
        "engine",
        "max_shared_prompt_bytes",
        "model",
        "participant_id",
        "reconciliation_mode",
        "wrapper_descriptor_digest",
      ]) ||
      !isBoundedLineageReference(participant.participant_id) ||
      !["claude", "codex", "copilot", "opencode", "antigravity"].includes(
        participant.engine as string,
      ) ||
      (participant.model !== null && !isBoundedLineageReference(participant.model)) ||
      !isBoundedLineageReference(participant.adapter_fingerprint) ||
      !["provider-idempotency", "inspect-start", "vf-process-lease"].includes(
        participant.reconciliation_mode as string,
      ) ||
      !["idempotent-cancel", "inspect-cancel", "vf-process-lease"].includes(
        participant.cancellation_mode as string,
      ) ||
      !isLineageDigest(participant.wrapper_descriptor_digest) ||
      !Number.isSafeInteger(participant.max_shared_prompt_bytes) ||
      (participant.max_shared_prompt_bytes as number) < 1 ||
      (participant.max_shared_prompt_bytes as number) > 16 * 1024 * 1024 ||
      (index > 0 &&
        Buffer.compare(
          Buffer.from(participants[index - 1]?.participant_id ?? ""),
          Buffer.from(participant.participant_id as string),
        ) >= 0)
    )
      throw new Error("invalid revision preparation participant");
  }
  const { plan_digest: _digest, ...preimage } = value;
  if (digestV1("VF-REVISION-PREPARATION-PLAN\0v1\0", preimage) !== value.plan_digest)
    throw new Error("invalid revision preparation plan digest");
}

export function assertRevisionOperationV1(value: unknown): asserts value is RevisionOperationV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "approval_digest",
      "approval_id",
      "authority_epoch",
      "authority_head_digest",
      "binding_set_digest",
      "child",
      "created_at",
      "expected_head_digest",
      "expected_parent_last_seq",
      "expected_parent_lock_digest",
      "expected_reservation_digest",
      "expected_reservation_epoch",
      "handoff_digest",
      "handoff_id",
      "handoff_profile",
      "handoff_selection_digest",
      "header_digest",
      "operation_id",
      "parent",
      "permission_digest",
      "plan_digest",
      "prompt_projection_digest",
      "proposal_digest",
      "proposal_id",
      "reservation_epoch",
      "revision_claim_epoch",
      "root_session_id",
      "schema_version",
    ]) ||
    value.schema_version !== "1.0" ||
    typeof value.operation_id !== "string" ||
    !OPERATION_ID.test(value.operation_id) ||
    typeof value.proposal_id !== "string" ||
    !PROPOSAL_ID.test(value.proposal_id) ||
    typeof value.approval_id !== "string" ||
    !APPROVAL_ID.test(value.approval_id) ||
    !isBoundedLineageReference(value.root_session_id) ||
    !Number.isSafeInteger(value.authority_epoch) ||
    (value.authority_epoch as number) < 0 ||
    !Number.isSafeInteger(value.expected_reservation_epoch) ||
    (value.expected_reservation_epoch as number) < 0 ||
    !Number.isSafeInteger(value.reservation_epoch) ||
    value.reservation_epoch !== (value.expected_reservation_epoch as number) + 1 ||
    !Number.isSafeInteger(value.revision_claim_epoch) ||
    (value.revision_claim_epoch as number) < 1 ||
    !Number.isSafeInteger(value.expected_parent_last_seq) ||
    (value.expected_parent_last_seq as number) < 0 ||
    value.handoff_profile !== "vf-public-handoff/1" ||
    typeof value.handoff_id !== "string" ||
    !HANDOFF_ID.test(value.handoff_id) ||
    !isMillisecondIsoDate(value.created_at)
  )
    throw new Error("invalid revision operation");
  for (const field of [
    "proposal_digest",
    "approval_digest",
    "plan_digest",
    "authority_head_digest",
    "expected_head_digest",
    "expected_parent_lock_digest",
    "permission_digest",
    "binding_set_digest",
    "handoff_digest",
    "handoff_selection_digest",
    "prompt_projection_digest",
    "header_digest",
  ])
    if (!isLineageDigest(value[field])) throw new Error("invalid revision operation digest");
  if (
    value.expected_reservation_digest !== null &&
    !isLineageDigest(value.expected_reservation_digest)
  )
    throw new Error("invalid revision operation reservation digest");
  if ((value.expected_reservation_epoch === 0) !== (value.expected_reservation_digest === null))
    throw new Error("invalid revision operation reservation pair");
  assertLineageNodeIdentityV1(value.parent);
  assertLineageNodeIdentityV1(value.child);
  if (value.handoff_id !== `vf-handoff-${(value.handoff_digest as string).slice(7)}`)
    throw new Error("invalid revision operation handoff identity");
  const { header_digest: _digest, ...preimage } = value;
  if (digestV1("VF-REVISION-OPERATION\0v1\0", preimage) !== value.header_digest)
    throw new Error("invalid revision operation digest");
}

export function assertRevisionHeadCommitEventV1(
  value: unknown,
): asserts value is RevisionHeadCommitEventV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "event_digest",
      "operation_id",
      "payload",
      "previous_event_digest",
      "recorded_at",
      "schema_version",
      "sequence",
    ]) ||
    value.schema_version !== "1.0" ||
    typeof value.operation_id !== "string" ||
    !OPERATION_ID.test(value.operation_id) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.previous_event_digest !== null && !isLineageDigest(value.previous_event_digest)) ||
    ((value.sequence as number) === 0) !== (value.previous_event_digest === null) ||
    !isMillisecondIsoDate(value.recorded_at) ||
    !isLineageDigest(value.event_digest) ||
    !isPlainLineageRecord(value.payload) ||
    !hasExactLineageKeys(value.payload, [
      "authorized_by_action_operation_id",
      "committed_head_digest",
      "directory_fsync_completed",
      "effect_action_operation_id",
      "kind",
      "prior_head_checkpoint_digest",
      "prior_head_digest",
    ]) ||
    value.payload.kind !== "head-commit" ||
    typeof value.payload.authorized_by_action_operation_id !== "string" ||
    !OPERATION_ID.test(value.payload.authorized_by_action_operation_id) ||
    typeof value.payload.effect_action_operation_id !== "string" ||
    !OPERATION_ID.test(value.payload.effect_action_operation_id) ||
    !isLineageDigest(value.payload.prior_head_digest) ||
    !isLineageDigest(value.payload.prior_head_checkpoint_digest) ||
    !isLineageDigest(value.payload.committed_head_digest) ||
    value.payload.directory_fsync_completed !== true
  )
    throw new Error("invalid revision head commit event");
  const { event_digest: _digest, ...preimage } = value;
  if (digestV1("VF-REVISION-OPERATION-EVENT\0v1\0", preimage) !== value.event_digest)
    throw new Error("invalid revision head commit digest");
}

export function assertOperationReservationClosure(
  operation: RevisionOperationV1,
  reservation: RevisionReservationRecordV1,
): void {
  if (
    reservation.status !== "active" ||
    reservation.root_session_id !== operation.root_session_id ||
    reservation.operation_id !== operation.operation_id ||
    reservation.proposal_id !== operation.proposal_id ||
    reservation.plan_digest !== operation.plan_digest ||
    reservation.reservation_epoch !== operation.reservation_epoch ||
    reservation.previous_reservation_digest !== operation.expected_reservation_digest ||
    reservation.revision_claim_epoch !== operation.revision_claim_epoch ||
    reservation.created_at !== operation.created_at ||
    reservation.updated_at !== operation.created_at ||
    JSON.stringify(reservation.parent) !== JSON.stringify(operation.parent) ||
    JSON.stringify(reservation.child) !== JSON.stringify(operation.child)
  )
    throw new Error("revision operation reservation closure mismatch");
}
