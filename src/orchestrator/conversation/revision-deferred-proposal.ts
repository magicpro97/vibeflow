import {
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  EMPTY_PERMISSION_DIGEST,
} from "../../actions/index.js";
import { materializeConversationRevisionProposal } from "./conversation-action-planner.js";
import { rethrowWithOversizedCandidate } from "./conversation-handoff-overflow.js";
import {
  applyConversationRevisionMutation,
  isConversationRevisionMutation,
} from "./revision-action-manifest.js";
import type { ConversationRevisionAuthorityOptions } from "./revision-authority.js";
import { ConversationRevisionConflictError } from "./revision-errors.js";
import { materializeRevisionPreparationPlan } from "./revision-planner.js";
import type { DeferredRevisionProposalStore } from "./revision-proposal-store.js";
import {
  buildRevisionHandoff,
  materializeFreshRevisionBindings,
  resolveRevisionBase,
  revisionBindingProjection,
} from "./revision-source.js";
import type { ConversationSnapshot } from "./types.js";

function plusHour(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 60 * 60_000).toISOString();
}

function assertExpected(
  request: ActionProposalRequestV1,
  base: ReturnType<typeof resolveRevisionBase>,
): void {
  const expected = request.expected;
  if (
    expected.mode !== "writable-revision" ||
    expected.conversation_id !== base.parent.node.conversation_id ||
    expected.revision_id !== base.parent.node.revision_id ||
    expected.last_seq !== base.parent.source.journal_head.last_seq ||
    expected.conversation_lock_digest !== base.lock.lock_digest
  )
    throw new ConversationRevisionConflictError("conversation proposal expected source is stale");
}

/** Creates durable review authority without claiming a revision or starting a child. */
export async function prepareDeferredRevisionProposal(input: {
  options: ConversationRevisionAuthorityOptions;
  proposals: DeferredRevisionProposalStore;
  conversationId: string;
  snapshot: ConversationSnapshot;
  request: ActionProposalRequestV1;
  authority: ActionRequestAuthorityV1;
}): Promise<{ created: boolean; proposalId: string }> {
  const action = input.request.candidate;
  if (!isConversationRevisionMutation(action))
    throw new Error("deferred action is not a conversation revision mutation");
  if (input.options.runtime.operationId(input.conversationId) !== null)
    throw new ConversationRevisionConflictError("conversation still has live operation authority");
  const base = resolveRevisionBase({
    artifactRoot: input.options.artifactRoot,
    traceRoot: input.options.traceRoot,
    conversationId: input.conversationId,
    home: input.options.home,
  });
  assertExpected(input.request, base);
  if (base.reservation?.status === "active")
    throw new ConversationRevisionConflictError("conversation has an active revision reservation");
  const claim = input.options.home.revisions.claimRequest({
    root_session_id: base.lineage.root_session_id,
    parent_conversation_id: base.parent.node.conversation_id,
    parent_revision_id: base.parent.node.revision_id,
    message_key: input.request.idempotency_key,
    created_at: input.options.now(),
  });
  const target = applyConversationRevisionMutation({
    parent: base.parent.source.manifest,
    action,
    idempotencyKey: input.request.idempotency_key,
  });
  const materialized = await materializeFreshRevisionBindings({
    manifest: target,
    rehydrate: input.options.rehydrateBinding,
  });
  const projection = revisionBindingProjection({
    manifest: target,
    previousManifest: base.parent.source.manifest,
    authorities: materialized.authorities,
  });
  let handoff: ReturnType<typeof buildRevisionHandoff>;
  try {
    handoff = buildRevisionHandoff({
      base,
      bindings: projection.publicBindings,
      snapshot: input.snapshot,
    });
  } catch (error) {
    rethrowWithOversizedCandidate({
      error,
      home: input.options.home,
      request: input.request,
      authority: input.authority,
      created_at: claim.created_at,
    });
  }
  const revisionPlan = materializeRevisionPreparationPlan({
    root_session_id: base.lineage.root_session_id,
    parent: base.parent.node,
    expected_head_digest: base.head.content_digest,
    expected_head_epoch: base.head.head_epoch,
    expected_reservation_digest: base.reservation?.content_digest ?? null,
    expected_reservation_epoch: base.reservation?.reservation_epoch ?? 0,
    expected_parent_last_seq: base.parent.source.journal_head.last_seq,
    expected_parent_lock_digest: base.lock.lock_digest,
    permission_digest: EMPTY_PERMISSION_DIGEST,
    revision_claim_epoch: (base.reservation?.revision_claim_epoch ?? 0) + 1,
    binding_delta_digest: projection.bindingDeltaDigest,
    resulting_binding_set_digest: projection.bindingSetDigest,
    handoff_selection_plan_digest: handoff.selection_plan.selection_digest,
    participant_starts: projection.participantStarts,
    created_at: claim.created_at,
    expires_at: plusHour(claim.created_at),
  });
  const planned = materializeConversationRevisionProposal({
    root_session_id: base.lineage.root_session_id,
    conversation_id: base.parent.node.conversation_id,
    revision_id: base.parent.node.revision_id,
    last_seq: base.parent.source.journal_head.last_seq,
    conversation_lock_digest: base.lock.lock_digest,
    head: base.head,
    action,
    anchor_event_id: input.request.anchor_event_id,
    message_key: input.request.idempotency_key,
    authority: input.authority,
    revision_plan: revisionPlan,
    created_at: claim.created_at,
  });
  input.options.home.handoffs.write(
    handoff.handoff,
    handoff.selection_plan,
    handoff.omitted_public_event_artifacts,
  );
  input.proposals.write({
    proposal_id: planned.proposal.proposal_id,
    proposal_digest: planned.proposal.proposal_digest,
    revision_plan: revisionPlan,
    handoff_digest: handoff.handoff.digest,
  });
  const created = input.options.home.actions.create(planned, input.authority);
  return { created: created.created, proposalId: created.proposal.proposal_id };
}
