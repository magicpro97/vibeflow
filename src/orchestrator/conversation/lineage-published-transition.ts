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
  type LineageHeadRecordV1,
  type LineageNodeIdentityV1,
  assertLineageHeadRecordV1,
  isPlainLineageRecord,
} from "./lineage-types.js";

export interface PublishedRevisionTransitionInputV1 {
  committed_head: unknown;
  authority: unknown;
}

export interface PublishedRevisionTransitionV1 {
  root_session_id: string;
  parent: LineageNodeIdentityV1;
  child: LineageNodeIdentityV1;
  prior_head_digest: string;
  committed_head_digest: string;
  operation_id: string;
  prior_head: LineageHeadRecordV1;
  committed_head: LineageHeadRecordV1;
  authority: unknown;
}

function nodeKey(node: LineageNodeIdentityV1): string {
  return `${node.conversation_id}\0${node.revision_id}\0${node.revision_ordinal}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

export function validatePublishedRevisionTransition(
  input: PublishedRevisionTransitionInputV1,
): PublishedRevisionTransitionV1 {
  if (!isPlainLineageRecord(input) || !exactKeys(input, ["authority", "committed_head"]))
    throw new Error("invalid published revision transition wrapper");
  if (
    !isPlainLineageRecord(input.authority) ||
    !exactKeys(input.authority, [
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
    ]) ||
    input.authority.kind !== "child-commit"
  )
    throw new Error("invalid published revision authority");
  assertLineageHeadRecordV1(input.committed_head);
  assertLineageHeadRecordV1(input.authority.prior_head);
  assertRevisionOperationV1(input.authority.operation);
  assertRevisionReservationRecordV1(input.authority.reservation);
  assertRevisionPreparationPlanV1(input.authority.revision_plan);
  const current = input.committed_head as LineageHeadRecordV1;
  const prior = input.authority.prior_head as LineageHeadRecordV1;
  const operation = input.authority.operation as RevisionOperationV1;
  const reservation = input.authority.reservation as RevisionReservationRecordV1;
  const plan = input.authority.revision_plan as RevisionPreparationPlanV1;
  const commit = assertRevisionOperationEventChainV1(
    input.authority.operation_events,
    operation.operation_id,
  );
  assertOperationReservationClosure(operation, reservation);
  if (
    prior.head_status !== "committed" ||
    !prior.active ||
    current.head_status !== "committed" ||
    !current.active ||
    current.root_session_id !== prior.root_session_id ||
    current.root_session_id !== operation.root_session_id ||
    current.head_epoch !== prior.head_epoch + 1 ||
    current.previous_head_digest !== prior.content_digest ||
    current.updated_by_operation_id !== operation.operation_id ||
    current.updated_at !== operation.created_at ||
    operation.expected_head_digest !== prior.content_digest ||
    nodeKey(operation.parent) !== nodeKey(prior.active) ||
    nodeKey(operation.child) !== nodeKey(current.active) ||
    operation.child.revision_ordinal !== operation.parent.revision_ordinal + 1 ||
    plan.root_session_id !== operation.root_session_id ||
    nodeKey(plan.parent) !== nodeKey(operation.parent) ||
    plan.expected_head_digest !== operation.expected_head_digest ||
    plan.expected_head_epoch !== prior.head_epoch ||
    commit.payload.prior_head_digest !== prior.content_digest ||
    commit.payload.prior_head_checkpoint_digest !== prior.content_digest ||
    commit.payload.committed_head_digest !== current.content_digest ||
    commit.payload.authorized_by_action_operation_id !== operation.operation_id ||
    commit.payload.effect_action_operation_id !== operation.operation_id
  )
    throw new Error("published revision transition is not closed");
  return {
    root_session_id: operation.root_session_id,
    parent: structuredClone(operation.parent),
    child: structuredClone(operation.child),
    prior_head_digest: prior.content_digest,
    committed_head_digest: current.content_digest,
    operation_id: operation.operation_id,
    prior_head: structuredClone(prior),
    committed_head: structuredClone(current),
    authority: structuredClone(input.authority),
  };
}

export function publishedRevisionTransitionMap(
  inputs: readonly PublishedRevisionTransitionInputV1[],
): ReadonlyMap<string, PublishedRevisionTransitionV1> {
  const byChild = new Map<string, PublishedRevisionTransitionV1>();
  for (const input of inputs) {
    const transition = validatePublishedRevisionTransition(input);
    if (byChild.has(transition.child.conversation_id))
      throw new Error("duplicate published revision child transition");
    byChild.set(transition.child.conversation_id, transition);
  }
  return byChild;
}

export function publishedRevisionAuthorityMap(
  inputs: readonly PublishedRevisionTransitionInputV1[],
): ReadonlyMap<string, unknown> {
  const output = new Map<string, unknown>();
  for (const input of inputs) {
    const transition = validatePublishedRevisionTransition(input);
    if (output.has(transition.committed_head_digest))
      throw new Error("duplicate published revision head transition");
    output.set(transition.committed_head_digest, structuredClone(transition.authority));
  }
  return output;
}
