import { digestV1 } from "../../durability/index.js";
import {
  assertExactAuthorityWrapper,
  sameCanonical,
  validateLineageActionClosure,
} from "./lineage-action-authority.js";
import type { ConversationLineageReadV1, ValidatedLineageNodeV1 } from "./lineage-reader.js";
import {
  type RevisionReservationRecordV1,
  assertRevisionReservationRecordV1,
} from "./lineage-reservation.js";
import { assertRevisionOperationEventChainV1 } from "./lineage-revision-event-chain.js";
import {
  type RevisionOperationV1,
  type RevisionPreparationPlanV1,
  assertOperationReservationClosure,
  assertRevisionOperationV1,
  assertRevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import {
  LINEAGE_LIMITS,
  type LineageHeadRecordV1,
  type LineageNodeIdentityV1,
  assertLineageHeadRecordV1,
  assertLineageNodeIdentityV1,
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

export interface LineageHeadSelectionPlanV1 {
  schema_version: "1.0";
  root_session_id: string;
  expected_head_status: "ambiguous" | "unclaimed";
  expected_head_digest: string;
  expected_head_epoch: number;
  candidate: LineageNodeIdentityV1;
  candidate_manifest_digest: string;
  candidate_ancestry_digest: string;
  validated_leaf_set_digest: string;
  created_at: string;
  expires_at: string;
  plan_digest: string;
}

export interface ValidatedLineageHeadAuthorityV1 {
  revision_claim_epoch: number;
  reservation_digest: string | null;
}

const nodeKey = (node: LineageNodeIdentityV1): string =>
  `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;

export function assertLineageHeadSelectionPlanV1(
  value: unknown,
): asserts value is LineageHeadSelectionPlanV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "candidate",
      "candidate_ancestry_digest",
      "candidate_manifest_digest",
      "created_at",
      "expected_head_digest",
      "expected_head_epoch",
      "expected_head_status",
      "expires_at",
      "plan_digest",
      "root_session_id",
      "schema_version",
      "validated_leaf_set_digest",
    ]) ||
    value.schema_version !== "1.0" ||
    !isBoundedLineageReference(value.root_session_id) ||
    !["ambiguous", "unclaimed"].includes(value.expected_head_status as string) ||
    !isLineageDigest(value.expected_head_digest) ||
    !Number.isSafeInteger(value.expected_head_epoch) ||
    (value.expected_head_epoch as number) < 0 ||
    !isLineageDigest(value.candidate_manifest_digest) ||
    !isLineageDigest(value.candidate_ancestry_digest) ||
    !isLineageDigest(value.validated_leaf_set_digest) ||
    !isMillisecondIsoDate(value.created_at) ||
    !isMillisecondIsoDate(value.expires_at) ||
    value.expires_at <= value.created_at ||
    !isLineageDigest(value.plan_digest)
  )
    throw new Error("invalid lineage head selection plan");
  assertLineageNodeIdentityV1(value.candidate);
  const { plan_digest: _digest, ...preimage } = value;
  if (digestV1("VF-LINEAGE-HEAD-SELECTION-PLAN\0v1\0", preimage) !== value.plan_digest)
    throw new Error("invalid lineage head selection plan digest");
}

function nodeByIdentity(
  lineage: ConversationLineageReadV1,
  identity: LineageNodeIdentityV1,
): ValidatedLineageNodeV1 {
  const found = lineage.nodes.find((node) => nodeKey(node.node) === nodeKey(identity));
  if (!found) throw new Error("lineage authority node is absent");
  return found;
}

function assertTransitionMetadata(
  prior: LineageHeadRecordV1,
  current: LineageHeadRecordV1,
  operationId: string,
  createdAt: string,
): void {
  if (
    current.root_session_id !== prior.root_session_id ||
    current.head_epoch !== prior.head_epoch + 1 ||
    current.previous_head_digest !== prior.content_digest ||
    current.updated_by_operation_id !== operationId ||
    current.updated_at !== createdAt
  )
    throw new Error("lineage head transition is discontinuous");
}

function validateSelection(
  input: Record<string, unknown>,
  current: LineageHeadRecordV1,
  lineage: ConversationLineageReadV1,
): LineageHeadRecordV1 {
  assertLineageHeadRecordV1(input.prior_head);
  assertLineageHeadSelectionPlanV1(input.plan);
  const prior = input.prior_head;
  const plan = input.plan;
  const closure = validateLineageActionClosure(
    {
      action_plan: input.action_plan,
      proposal: input.proposal,
      approval: input.approval,
      dispatch: input.dispatch,
    },
    plan.plan_digest,
    "lineage-head",
    null,
  );
  assertTransitionMetadata(
    prior,
    current,
    closure.dispatch.operation_id,
    closure.dispatch.created_at,
  );
  if (
    prior.head_status !== plan.expected_head_status ||
    prior.content_digest !== plan.expected_head_digest ||
    prior.head_epoch !== plan.expected_head_epoch ||
    prior.root_session_id !== plan.root_session_id ||
    current.head_status !== "committed" ||
    !current.active ||
    nodeKey(current.active) !== nodeKey(plan.candidate) ||
    !prior.candidate_heads.some((candidate) => nodeKey(candidate) === nodeKey(plan.candidate))
  )
    throw new Error("lineage head selection does not bind prior authority");
  const selected = nodeByIdentity(lineage, plan.candidate);
  const leaves = prior.candidate_heads.map((candidate) => {
    const node = nodeByIdentity(lineage, candidate);
    return {
      node: candidate,
      manifest_digest: node.manifest_digest,
      ancestry_digest: node.ancestry_digest,
    };
  });
  const leafSetDigest = digestV1("VF-LINEAGE-VALIDATED-LEAF-SET\0v1\0", {
    schema_version: "1.0",
    leaves,
  });
  const proposal = closure.proposal;
  const action = proposal.action;
  if (
    plan.candidate_manifest_digest !== selected.manifest_digest ||
    plan.candidate_ancestry_digest !== selected.ancestry_digest ||
    plan.validated_leaf_set_digest !== leafSetDigest ||
    proposal.created_at !== plan.created_at ||
    proposal.expires_at !== plan.expires_at ||
    proposal.base.root_session_id !== prior.root_session_id ||
    proposal.base.lineage_head_digest !== prior.content_digest ||
    proposal.base.lineage_head_epoch !== prior.head_epoch ||
    proposal.action_root_locator.kind !== "conversation" ||
    proposal.action_root_locator.root_session_id !== prior.root_session_id ||
    action.type !== "conversation.select_lineage_head" ||
    action.root_session_id !== prior.root_session_id ||
    action.candidate_conversation_id !== plan.candidate.conversation_id ||
    action.candidate_revision_id !== plan.candidate.revision_id
  )
    throw new Error("lineage head selection action closure mismatch");
  return structuredClone(prior);
}

const REVISION_ACTIONS = new Set([
  "conversation.continue_message",
  "conversation.add_participant",
  "conversation.remove_participant",
  "conversation.update_participant",
  "conversation.update_settings",
]);

function validateChildCommit(
  input: Record<string, unknown>,
  current: LineageHeadRecordV1,
  lineage: ConversationLineageReadV1,
): LineageHeadRecordV1 {
  assertLineageHeadRecordV1(input.prior_head);
  assertRevisionReservationRecordV1(input.reservation);
  assertRevisionPreparationPlanV1(input.revision_plan);
  assertRevisionOperationV1(input.operation);
  const prior = input.prior_head;
  const reservation = input.reservation as RevisionReservationRecordV1;
  const revisionPlan = input.revision_plan as RevisionPreparationPlanV1;
  const operation = input.operation as RevisionOperationV1;
  const commit = assertRevisionOperationEventChainV1(
    input.operation_events,
    operation.operation_id,
  );
  const closure = validateLineageActionClosure(
    {
      action_plan: input.action_plan,
      proposal: input.proposal,
      approval: input.approval,
      dispatch: input.dispatch,
    },
    revisionPlan.plan_digest,
    "revision-operation",
    operation.header_digest,
  );
  assertTransitionMetadata(
    prior,
    current,
    closure.dispatch.operation_id,
    closure.dispatch.created_at,
  );
  if (
    prior.head_status !== "committed" ||
    !prior.active ||
    current.head_status !== "committed" ||
    !current.active ||
    nodeKey(prior.active) !== nodeKey(operation.parent) ||
    nodeKey(current.active) !== nodeKey(operation.child) ||
    operation.child.revision_ordinal !== operation.parent.revision_ordinal + 1
  )
    throw new Error("invalid lineage child head edge");
  const child = nodeByIdentity(lineage, operation.child);
  if (!child.parent || nodeKey(child.parent) !== nodeKey(operation.parent))
    throw new Error("lineage child is not durable under prior head");
  assertOperationReservationClosure(operation, reservation);
  const proposal = closure.proposal;
  const approval = closure.approval;
  const dispatch = closure.dispatch;
  if (
    operation.operation_id !== dispatch.operation_id ||
    operation.proposal_id !== proposal.proposal_id ||
    operation.proposal_digest !== proposal.proposal_digest ||
    operation.approval_id !== approval.approval_id ||
    operation.approval_digest !== approval.approval_digest ||
    operation.plan_digest !== proposal.plan_digest ||
    operation.authority_epoch !== proposal.base.authority_epoch ||
    operation.authority_head_digest !== proposal.base.authority_head_digest ||
    operation.root_session_id !== prior.root_session_id ||
    operation.expected_head_digest !== prior.content_digest ||
    operation.expected_parent_last_seq !== proposal.base.last_seq ||
    operation.expected_parent_lock_digest !== proposal.base.conversation_lock_digest ||
    operation.permission_digest !== proposal.permission_digest ||
    operation.handoff_selection_digest !== proposal.handoff_selection_digest ||
    operation.created_at !== dispatch.created_at ||
    revisionPlan.root_session_id !== operation.root_session_id ||
    nodeKey(revisionPlan.parent) !== nodeKey(operation.parent) ||
    revisionPlan.expected_head_digest !== operation.expected_head_digest ||
    revisionPlan.expected_head_epoch !== prior.head_epoch ||
    revisionPlan.expected_reservation_digest !== operation.expected_reservation_digest ||
    revisionPlan.expected_reservation_epoch !== operation.expected_reservation_epoch ||
    revisionPlan.expected_parent_last_seq !== operation.expected_parent_last_seq ||
    revisionPlan.expected_parent_lock_digest !== operation.expected_parent_lock_digest ||
    revisionPlan.permission_digest !== operation.permission_digest ||
    revisionPlan.revision_claim_epoch !== operation.revision_claim_epoch ||
    revisionPlan.resulting_binding_set_digest !== operation.binding_set_digest ||
    revisionPlan.created_at !== proposal.created_at ||
    revisionPlan.expires_at !== proposal.expires_at ||
    proposal.base.root_session_id !== prior.root_session_id ||
    proposal.base.conversation_id !== operation.parent.conversation_id ||
    proposal.base.revision_id !== operation.parent.revision_id ||
    proposal.base.lineage_head_digest !== prior.content_digest ||
    proposal.base.lineage_head_epoch !== prior.head_epoch ||
    proposal.action_root_locator.kind !== "conversation" ||
    proposal.action_root_locator.root_session_id !== prior.root_session_id ||
    !REVISION_ACTIONS.has(proposal.action.type) ||
    commit.operation_id !== operation.operation_id ||
    commit.payload.authorized_by_action_operation_id !== dispatch.operation_id ||
    commit.payload.effect_action_operation_id !== dispatch.operation_id ||
    commit.payload.prior_head_digest !== prior.content_digest ||
    commit.payload.prior_head_checkpoint_digest !== prior.content_digest ||
    commit.payload.committed_head_digest !== current.content_digest ||
    commit.recorded_at < dispatch.created_at
  )
    throw new Error("invalid lineage child operation closure");
  return structuredClone(prior);
}

function validateTransition(
  value: unknown,
  current: LineageHeadRecordV1,
  lineage: ConversationLineageReadV1,
): LineageHeadRecordV1 {
  if (!isPlainLineageRecord(value)) throw new Error("lineage head transition is absent");
  if (value.kind === "selection") {
    assertExactAuthorityWrapper(value, [
      "approval",
      "action_plan",
      "dispatch",
      "kind",
      "plan",
      "prior_head",
      "proposal",
    ]);
    return validateSelection(value, current, lineage);
  }
  if (value.kind === "child-commit") {
    assertExactAuthorityWrapper(value, [
      "approval",
      "action_plan",
      "dispatch",
      "kind",
      "operation",
      "operation_events",
      "prior_head",
      "proposal",
      "reservation",
      "revision_plan",
    ]);
    return validateChildCommit(value, current, lineage);
  }
  throw new Error("invalid lineage head transition kind");
}

export function validateLineageHeadAuthorityChain(
  head: LineageHeadRecordV1,
  lineage: ConversationLineageReadV1,
  transitions: ReadonlyMap<string, unknown>,
): ValidatedLineageHeadAuthorityV1 {
  let current = head;
  const seen = new Set<string>();
  let latestPublishedClaimEpoch = 0;
  let latestPublishedReservationDigest: string | null = null;
  let newerPublishedClaimEpoch = Number.POSITIVE_INFINITY;
  while (current.head_epoch > 0) {
    if (seen.has(current.content_digest) || seen.size >= LINEAGE_LIMITS.maxNodes)
      throw new Error("lineage head transition cycle");
    seen.add(current.content_digest);
    const authority = transitions.get(current.content_digest);
    current = validateTransition(authority, current, lineage);
    if (isPlainLineageRecord(authority) && authority.kind === "child-commit") {
      assertRevisionOperationV1(authority.operation);
      const claimEpoch = authority.operation.revision_claim_epoch;
      if (claimEpoch >= newerPublishedClaimEpoch)
        throw new Error("revision claim epochs are not monotonic");
      if (latestPublishedClaimEpoch === 0) {
        latestPublishedClaimEpoch = claimEpoch;
        assertRevisionReservationRecordV1(authority.reservation);
        latestPublishedReservationDigest = authority.reservation.content_digest;
      }
      newerPublishedClaimEpoch = claimEpoch;
    }
  }
  const initial = lineage.initial_head_candidate;
  if (
    current.head_epoch !== 0 ||
    current.previous_head_digest !== null ||
    initial === null ||
    !sameCanonical(current, initial)
  )
    throw new Error("lineage head chain lacks an initial authority");
  return {
    revision_claim_epoch: latestPublishedClaimEpoch,
    reservation_digest: latestPublishedReservationDigest,
  };
}
