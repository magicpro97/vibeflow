import {
  type ActionAuthoritySnapshotV1,
  type ActionRequestAuthorityV1,
  deriveOperationId,
} from "../../actions/index.js";
import { isAgentProposalBrowserController } from "../../actions/store-rules.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import {
  conversationActionAuthorityHead,
  materializeConversationRevisionActionPlan,
} from "./conversation-action-planner.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { validateLineageHeadForRead } from "./lineage-head-reader.js";
import {
  type PublishedRevisionTransitionInputV1,
  publishedRevisionAuthorityMap,
  validatePublishedRevisionTransition,
} from "./lineage-published-transition.js";
import { deriveConversationLineages } from "./lineage-reader.js";
import type { RevisionReservationRecordV1 } from "./lineage-reservation.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import {
  type ConversationRevisionMutationV1,
  isConversationRevisionMutation,
} from "./revision-action-manifest.js";
import type { ConversationRevisionAuthorityOptions } from "./revision-authority.js";
import type {
  DeferredRevisionProposalStore,
  DeferredRevisionProposalV1,
} from "./revision-proposal-store.js";
import { validatePublishedRevisionReservation } from "./revision-reservation-reconciliation.js";
import { revisionManifestRecord } from "./revision-source.js";
import { readConversationSourceInventory } from "./source-inventory.js";

export interface DeferredRevisionCommitInputV1 {
  conversationId: string;
  proposalId: string;
  proposalDigest: string;
  approvalId: string;
  authority: ActionRequestAuthorityV1;
}

export interface ValidatedDeferredRevisionCommitV1 {
  actionState: ActionAuthoritySnapshotV1 & {
    approval: NonNullable<ActionAuthoritySnapshotV1["approval"]>;
  };
  deferred: DeferredRevisionProposalV1;
  action: ConversationRevisionMutationV1;
  operationId: string;
}

export interface ValidatedPublishedRevisionReplayV1 {
  childId: string;
  operation: RevisionOperationV1;
  revisionPlan: RevisionPreparationPlanV1;
  reservation: RevisionReservationRecordV1;
  publicationVisible: boolean;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

/** Validates the caller and the immutable proposal/approval closure without writing. */
export function validateDeferredRevisionCommit(input: {
  options: ConversationRevisionAuthorityOptions;
  proposals: DeferredRevisionProposalStore;
  commit: DeferredRevisionCommitInputV1;
}): ValidatedDeferredRevisionCommitV1 {
  const actionState = input.options.home.actions.authority.get(input.commit.proposalId);
  const deferred = input.proposals.read(input.commit.proposalId);
  const action = actionState?.proposal.action;
  const approval = actionState?.approval;
  if (
    !actionState ||
    !approval ||
    !deferred ||
    !action ||
    !isConversationRevisionMutation(action) ||
    actionState.proposal.proposal_id !== input.commit.proposalId ||
    actionState.proposal.proposal_digest !== input.commit.proposalDigest ||
    deferred.proposal_id !== input.commit.proposalId ||
    deferred.proposal_digest !== input.commit.proposalDigest ||
    approval.approval_id !== input.commit.approvalId ||
    approval.proposal_id !== actionState.proposal.proposal_id ||
    approval.proposal_digest !== actionState.proposal.proposal_digest ||
    approval.plan_digest !== actionState.proposal.plan_digest ||
    approval.authority_epoch !== actionState.proposal.base.authority_epoch ||
    approval.authority_head_digest !== actionState.proposal.base.authority_head_digest ||
    approval.decision !== "approved" ||
    actionState.proposal.domain !== "conversation" ||
    actionState.proposal.action_root_locator.kind !== "conversation" ||
    actionState.proposal.base.root_session_id !==
      actionState.proposal.action_root_locator.root_session_id ||
    actionState.proposal.base.conversation_id !== input.commit.conversationId ||
    deferred.revision_plan.root_session_id !== actionState.proposal.base.root_session_id ||
    deferred.revision_plan.parent.conversation_id !== input.commit.conversationId ||
    actionState.proposal.handoff_selection_digest !==
      deferred.revision_plan.handoff_selection_plan_digest ||
    !same(approval.decided_by, input.commit.authority.actor) ||
    (!same(actionState.proposal.requested_by, input.commit.authority.actor) &&
      !isAgentProposalBrowserController(actionState.proposal, input.commit.authority))
  )
    throw new Error("deferred revision approval authority mismatch");
  const rootSessionId = actionState.proposal.base.root_session_id;
  if (!rootSessionId) throw new Error("deferred revision action root is absent");
  const actionPlan = materializeConversationRevisionActionPlan(
    rootSessionId,
    deferred.revision_plan,
  );
  if (digestV1("VF-ACTION-PLAN\0v1\0", actionPlan) !== actionState.proposal.plan_digest)
    throw new Error("deferred revision action plan changed");
  if (actionState.proposal.requested_by.kind !== "agent") {
    const authorityHead = conversationActionAuthorityHead({
      root_session_id: rootSessionId,
      authority: input.commit.authority,
    });
    if (
      authorityHead.authority_epoch !== actionState.proposal.base.authority_epoch ||
      authorityHead.authority_head_digest !== actionState.proposal.base.authority_head_digest
    )
      throw new Error("deferred revision request authority changed");
  }
  if (
    !["approved", "committing", "succeeded", "failed", "needs_recovery"].includes(actionState.state)
  )
    throw new Error("deferred revision proposal is not committable");
  const operationId = deriveOperationId(actionState.proposal, approval.approval_id);
  if (actionState.operation_id !== null && actionState.operation_id !== operationId)
    throw new Error("deferred revision operation authority changed");
  return {
    actionState: { ...actionState, approval },
    deferred,
    action,
    operationId,
  };
}

function validateCurrentLineage(input: {
  options: ConversationRevisionAuthorityOptions;
  operation: RevisionOperationV1;
  prepared: PublishedRevisionTransitionInputV1;
}): void {
  const published = input.options.home.publishedRevisionTransitions();
  const transitions = published.some(
    (candidate) =>
      validatePublishedRevisionTransition(candidate).operation_id === input.operation.operation_id,
  )
    ? published
    : [...published, input.prepared];
  const inventory = readConversationSourceInventory({
    artifactRoot: input.options.artifactRoot,
    traceRoot: input.options.traceRoot,
    actionAuthority: input.options.home.reviewedActionAuthority(),
    includeHiddenRevisions: true,
    includeHiddenRevisionOperationIds: new Set([input.operation.operation_id]),
  });
  const derivation = deriveConversationLineages(inventory, {
    publishedRevisionTransitions: transitions,
  });
  const lineage = derivation.lineages.find(
    (candidate) => candidate.root_session_id === input.operation.root_session_id,
  );
  const current = input.options.home.lineage.readHead(input.operation.root_session_id);
  if (!inventory.authoritative || !derivation.authoritative || !lineage || !current)
    throw new Error("published revision lineage is not authoritative");
  validateLineageHeadForRead(current, lineage, publishedRevisionAuthorityMap(transitions));
  const chain = transitions
    .map(validatePublishedRevisionTransition)
    .filter((item) => item.root_session_id === input.operation.root_session_id)
    .sort((left, right) => left.committed_head.head_epoch - right.committed_head.head_epoch);
  const position = chain.findIndex((item) => item.operation_id === input.operation.operation_id);
  if (position < 0) throw new Error("published revision lineage operation is absent");
  let cursor = chain[position]?.committed_head;
  for (const next of chain.slice(position + 1)) {
    if (!cursor || next.prior_head.content_digest !== cursor.content_digest)
      throw new Error("published revision descendant lineage is discontinuous");
    cursor = next.committed_head;
  }
  if (!cursor || current.content_digest !== cursor.content_digest)
    throw new Error("published revision lineage head changed outside its authority chain");
}

/** Finds a publication only after its complete stored replay closure is exact. */
export function findValidatedPublishedRevisionReplay(input: {
  options: ConversationRevisionAuthorityOptions;
  validated: ValidatedDeferredRevisionCommitV1;
}): ValidatedPublishedRevisionReplayV1 | null {
  const published = input.options.home.publishedRevisionTransitions();
  const matches = published.filter(
    (candidate) =>
      (candidate.authority as { proposal?: { proposal_id?: unknown } }).proposal?.proposal_id ===
      input.validated.actionState.proposal.proposal_id,
  );
  if (matches.length > 1) throw new Error("published revision proposal authority is duplicated");
  const source =
    matches[0] ?? input.options.home.revisions.readPreparedTransition(input.validated.operationId);
  if (!source) return null;
  const transition = validatePublishedRevisionTransition(source);
  if (matches.length === 0) {
    const current = input.options.home.lineage.readHead(transition.root_session_id);
    if (current?.content_digest === transition.prior_head_digest) return null;
  }
  const authority = transition.authority as {
    operation: RevisionOperationV1;
    revision_plan: RevisionPreparationPlanV1;
    reservation: RevisionReservationRecordV1;
    proposal: unknown;
    approval: unknown;
    action_plan: unknown;
    dispatch: unknown;
    operation_events: unknown[];
  };
  const operation = input.options.home.revisions.readOperation(input.validated.operationId);
  const plan = input.options.home.revisions.readPlan(input.validated.operationId);
  const prepared = input.options.home.revisions.readPreparedTransition(input.validated.operationId);
  const events = input.options.home.revisions.readEvents(input.validated.operationId);
  const dispatch = input.options.home.actions.authority.getDispatch(input.validated.operationId);
  const artifact = input.options.artifactStore.readPreparedRevision(
    authority.operation.child.conversation_id,
  );
  const artifactAuthority = artifact
    ? revisionManifestRecord(artifact.manifest, artifact.binding_authorities)
    : null;
  const visibility = input.options.artifactStore.revisionVisibility(
    authority.operation.child.conversation_id,
  );
  const expectedActionPlan = materializeConversationRevisionActionPlan(
    authority.operation.root_session_id,
    input.validated.deferred.revision_plan,
  );
  if (
    transition.operation_id !== input.validated.operationId ||
    !operation ||
    !plan ||
    !prepared ||
    !dispatch ||
    !artifact ||
    !artifactAuthority ||
    !visibility ||
    !same(source, prepared) ||
    !same(authority.operation, operation) ||
    !same(authority.revision_plan, plan) ||
    !same(plan, input.validated.deferred.revision_plan) ||
    !same(authority.proposal, input.validated.actionState.proposal) ||
    !same(authority.approval, input.validated.actionState.approval) ||
    !same(authority.action_plan, expectedActionPlan) ||
    !same(authority.dispatch, dispatch) ||
    !same(authority.operation_events, events.slice(0, authority.operation_events.length)) ||
    authority.operation_events.length !== 3 ||
    authority.operation.proposal_id !== input.validated.actionState.proposal.proposal_id ||
    authority.operation.proposal_digest !== input.validated.actionState.proposal.proposal_digest ||
    authority.operation.approval_id !== input.validated.actionState.approval.approval_id ||
    authority.operation.approval_digest !== input.validated.actionState.approval.approval_digest ||
    authority.operation.plan_digest !== input.validated.actionState.proposal.plan_digest ||
    authority.operation.authority_epoch !==
      input.validated.actionState.proposal.base.authority_epoch ||
    authority.operation.authority_head_digest !==
      input.validated.actionState.proposal.base.authority_head_digest ||
    authority.reservation.operation_id !== authority.operation.operation_id ||
    authority.reservation.proposal_id !== authority.operation.proposal_id ||
    authority.reservation.plan_digest !== authority.operation.plan_digest
  )
    throw new Error("published revision replay authority changed");
  if (
    visibility.operation_id !== authority.operation.operation_id ||
    visibility.manifest_record_digest !== artifactAuthority.digest ||
    artifact.manifest.conversation_id !== authority.operation.child.conversation_id ||
    artifact.manifest.revision_id !== authority.operation.child.revision_id ||
    artifact.manifest.parent_conversation_id !== authority.operation.parent.conversation_id ||
    artifact.manifest.parent_revision_id !== authority.operation.parent.revision_id
  )
    throw new Error("published revision artifact authority changed");
  validatePublishedRevisionReservation({
    lineage: input.options.home.lineage,
    reservation: authority.reservation,
    consumedAt: authority.operation.created_at,
  });
  validateCurrentLineage({
    options: input.options,
    operation: authority.operation,
    prepared: source,
  });
  return {
    childId: authority.operation.child.conversation_id,
    operation: structuredClone(authority.operation),
    revisionPlan: structuredClone(authority.revision_plan),
    reservation: structuredClone(authority.reservation),
    publicationVisible: matches.length === 1,
  };
}
