import { canonicalJsonBytes } from "../../durability/index.js";
import { conversationLockDigest } from "./catalog-lock.js";
import { materializeConversationRevisionActionPlan } from "./conversation-action-planner.js";
import { contextHandoffSharedPromptBytes } from "./handoff-selection.js";
import { validatePublishedRevisionTransition } from "./lineage-published-transition.js";
import type { RevisionReservationRecordV1 } from "./lineage-reservation.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";
import {
  applyConversationRevisionMutation,
  revisionMessageRequest,
} from "./revision-action-manifest.js";
import type { ConversationRevisionAuthorityOptions } from "./revision-authority.js";
import { RevisionCrashFaultError, runRevisionCrashFault } from "./revision-crash-fault.js";
import {
  type DeferredRevisionCommitInputV1,
  type ValidatedDeferredRevisionCommitV1,
  validateDeferredRevisionCommit,
} from "./revision-deferred-validation.js";
import type { ConversationRevisionOperationExecutor } from "./revision-operation-executor.js";
import {
  deriveRevisionChildIdentity,
  materializeReleasedRevisionReservation,
  materializeRevisionOperation,
  materializeRevisionReservation,
} from "./revision-planner.js";
import type { DeferredRevisionProposalStore } from "./revision-proposal-store.js";
import {
  materializeFreshRevisionBindings,
  materializeRevisionManifest,
  resolveRevisionBase,
  revisionBindingProjection,
  revisionManifestRecord,
} from "./revision-source.js";

export type { DeferredRevisionCommitInputV1 } from "./revision-deferred-validation.js";

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

function validateSource(
  base: ReturnType<typeof resolveRevisionBase>,
  plan: RevisionPreparationPlanV1,
): void {
  if (
    plan.expected_head_digest !== base.head.content_digest ||
    plan.expected_parent_last_seq !== base.parent.source.journal_head.last_seq
  )
    throw new Error("deferred revision source changed before commit");
  const reservation = base.reservation;
  if (reservation?.status === "active") {
    const priorClaimEpoch = plan.revision_claim_epoch - 1;
    const expectedLock = conversationLockDigest(
      base.lineage.root_session_id,
      base.parent.source,
      priorClaimEpoch,
    );
    if (
      plan.expected_parent_lock_digest !== expectedLock ||
      reservation.revision_claim_epoch !== plan.revision_claim_epoch ||
      reservation.previous_reservation_digest !== plan.expected_reservation_digest ||
      reservation.reservation_epoch !== plan.expected_reservation_epoch + 1
    )
      throw new Error("active revision reservation does not resume the approved plan");
    return;
  }
  if (
    plan.expected_parent_lock_digest !== base.lock.lock_digest ||
    plan.expected_reservation_digest !== (reservation?.content_digest ?? null) ||
    plan.expected_reservation_epoch !== (reservation?.reservation_epoch ?? 0)
  )
    throw new Error("deferred revision source changed before commit");
}

/** Replays or executes one approved revision proposal from its immutable preparation. */
export async function commitDeferredRevision(input: {
  options: ConversationRevisionAuthorityOptions;
  executor: ConversationRevisionOperationExecutor;
  proposals: DeferredRevisionProposalStore;
  commit: DeferredRevisionCommitInputV1;
  validated?: ValidatedDeferredRevisionCommitV1;
}): Promise<{ childId: string; reconcilePublished: boolean }> {
  const validated =
    input.validated ??
    validateDeferredRevisionCommit({
      options: input.options,
      proposals: input.proposals,
      commit: input.commit,
    });
  const { actionState, deferred, operationId, action } = validated;
  const storedOperation = input.options.home.revisions.readOperation(operationId);
  const storedPlan = input.options.home.revisions.readPlan(operationId);
  const preparedTransition = input.options.home.revisions.readPreparedTransition(operationId);
  if (storedOperation && storedPlan && preparedTransition) {
    const prepared = validatePublishedRevisionTransition(preparedTransition);
    const preparedAuthority = prepared.authority as {
      operation: typeof storedOperation;
      revision_plan: RevisionPreparationPlanV1;
      proposal: typeof actionState.proposal;
      approval: NonNullable<typeof actionState.approval>;
      reservation: RevisionReservationRecordV1;
      operation_events: unknown;
    };
    const storedEvents = input.options.home.revisions.readEvents(operationId);
    if (
      !same(preparedAuthority.operation, storedOperation) ||
      !same(preparedAuthority.revision_plan, storedPlan) ||
      !same(storedPlan, deferred.revision_plan) ||
      !same(preparedAuthority.proposal, actionState.proposal) ||
      !same(preparedAuthority.approval, actionState.approval) ||
      !same(preparedAuthority.operation_events, storedEvents)
    )
      throw new Error("prepared revision publication authority changed");
    const committedHead = input.options.home.lineage.readHead(storedOperation.root_session_id);
    if (committedHead && same(committedHead, prepared.committed_head)) {
      const visibility = input.options.artifactStore.revisionVisibility(
        storedOperation.child.conversation_id,
      );
      const record = input.options.artifactStore.readPreparedRevision(
        storedOperation.child.conversation_id,
      );
      const manifestAuthority = record
        ? revisionManifestRecord(record.manifest, record.binding_authorities)
        : null;
      const reservation = input.options.home.lineage.readReservation(
        storedOperation.root_session_id,
      );
      if (
        !visibility ||
        !record ||
        !manifestAuthority ||
        visibility.operation_id !== storedOperation.operation_id ||
        visibility.manifest_record_digest !== manifestAuthority.digest ||
        !same(record, manifestAuthority.record) ||
        record.manifest.conversation_id !== storedOperation.child.conversation_id ||
        record.manifest.revision_id !== storedOperation.child.revision_id ||
        record.manifest.parent_conversation_id !== storedOperation.parent.conversation_id ||
        record.manifest.parent_revision_id !== storedOperation.parent.revision_id ||
        !same(reservation, preparedAuthority.reservation)
      )
        throw new Error("committed revision publication closure changed");
      return { childId: storedOperation.child.conversation_id, reconcilePublished: true };
    }
  }
  const base = resolveRevisionBase({
    artifactRoot: input.options.artifactRoot,
    traceRoot: input.options.traceRoot,
    conversationId: input.commit.conversationId,
    home: input.options.home,
  });
  const plan = deferred.revision_plan;
  validateSource(base, plan);
  const child = deriveRevisionChildIdentity({
    root_session_id: base.lineage.root_session_id,
    parent_conversation_id: base.parent.node.conversation_id,
    parent_revision_id: base.parent.node.revision_id,
    proposal_id: actionState.proposal.proposal_id,
    revision_claim_epoch: plan.revision_claim_epoch,
    revision_ordinal: base.parent.node.revision_ordinal + 1,
  });
  const handoff = input.options.home.handoffs.read(deferred.handoff_digest);
  if (!handoff) throw new Error("deferred revision handoff is absent");
  const target = applyConversationRevisionMutation({
    parent: base.parent.source.manifest,
    action,
    idempotencyKey: actionState.proposal.idempotency_key,
  });
  const targetBindings = await materializeFreshRevisionBindings({
    manifest: target,
    rehydrate: input.options.rehydrateBinding,
  });
  const projection = revisionBindingProjection({
    manifest: target,
    previousManifest: base.parent.source.manifest,
    authorities: targetBindings.authorities,
  });
  if (
    projection.bindingSetDigest !== plan.resulting_binding_set_digest ||
    projection.bindingDeltaDigest !== plan.binding_delta_digest ||
    !same(handoff.bindings, projection.publicBindings)
  )
    throw new Error("deferred revision binding plan changed");
  const expectedOperation = materializeRevisionOperation({
    operation_id: operationId,
    proposal_id: actionState.proposal.proposal_id,
    proposal_digest: actionState.proposal.proposal_digest,
    approval_id: actionState.approval.approval_id,
    approval_digest: actionState.approval.approval_digest,
    plan_digest: actionState.proposal.plan_digest,
    authority_epoch: actionState.proposal.base.authority_epoch,
    authority_head_digest: actionState.proposal.base.authority_head_digest,
    root_session_id: base.lineage.root_session_id,
    parent: base.parent.node,
    child,
    expected_head_digest: plan.expected_head_digest,
    expected_reservation_digest: plan.expected_reservation_digest,
    expected_reservation_epoch: plan.expected_reservation_epoch,
    revision_claim_epoch: plan.revision_claim_epoch,
    expected_parent_last_seq: plan.expected_parent_last_seq,
    expected_parent_lock_digest: plan.expected_parent_lock_digest,
    permission_digest: actionState.proposal.permission_digest,
    binding_set_digest: projection.bindingSetDigest,
    handoff_digest: handoff.digest,
    handoff_selection_digest: handoff.handoff_selection_digest,
    prompt_projection_digest: handoff.prompt_projection_digest,
    created_at: actionState.approval.decided_at,
  });
  if (storedOperation && !same(storedOperation, expectedOperation))
    throw new Error("stored revision operation disagrees with approved plan");
  const operation = storedOperation ?? expectedOperation;
  const childManifest = materializeRevisionManifest({
    parent: base.parent.source.manifest,
    target,
    child,
    operationId,
    createdAt: operation.created_at,
  });
  const bindings = await materializeFreshRevisionBindings({
    manifest: childManifest,
    rehydrate: input.options.rehydrateBinding,
  });
  if (!same(bindings.authorities, projection.intendedAuthorities))
    throw new Error("deferred revision binding authority changed");
  const record = revisionManifestRecord(childManifest, bindings.authorities);
  const expectedReservation = materializeRevisionReservation(operation);
  const reservation =
    base.reservation?.status === "active" ? base.reservation : expectedReservation;
  if (!same(reservation, expectedReservation))
    throw new Error("active revision reservation belongs to another operation");
  input.options.home.revisions.writeHeader(operation, plan);
  if (base.reservation?.status !== "active")
    input.options.home.lineage.commitReservation(base.reservation, reservation);
  runRevisionCrashFault(input.options.revisionFault, "after-reservation-active");
  const prepared = {
    operation,
    revisionPlan: plan,
    reservation,
    actionPlan: materializeConversationRevisionActionPlan(base.lineage.root_session_id, plan),
    proposal: actionState.proposal,
    approval: actionState.approval,
    manifest: childManifest,
    bindings: bindings.bindings,
    bindingAuthorities: bindings.authorities,
    manifestRecordDigest: record.digest,
    handoff,
    sharedPrompt: contextHandoffSharedPromptBytes(handoff.prompt_projection).toString("utf8"),
    request: revisionMessageRequest(action),
    messageKey: actionState.proposal.idempotency_key,
    runtimeOperationId: operation.operation_id,
    queueDelivery: null,
    priorPublished: base.published,
  };
  try {
    const executed = await input.executor.execute(prepared, base.head);
    return { childId: child.conversation_id, reconcilePublished: !executed.committedHere };
  } catch (error) {
    if (error instanceof RevisionCrashFaultError) throw error;
    const head = input.options.home.lineage.readHead(base.lineage.root_session_id);
    const current = input.options.home.lineage.readReservation(base.lineage.root_session_id);
    if (
      head?.updated_by_operation_id === operation.operation_id &&
      head.active?.conversation_id === child.conversation_id
    )
      return { childId: child.conversation_id, reconcilePublished: true };
    if (head?.content_digest === base.head.content_digest && same(current, reservation)) {
      input.executor.abandon(prepared, "preparation_failed");
      input.options.home.lineage.commitReservation(
        reservation,
        materializeReleasedRevisionReservation(reservation, input.options.now()),
      );
      input.options.revisionSettled(base.lineage.root_session_id);
    }
    throw error;
  }
}
