import {
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  EMPTY_PERMISSION_DIGEST,
} from "../../actions/index.js";
import type { MaterializedAgentBinding } from "../../agents/binding.js";
import { canonicalJsonBytes } from "../../durability/index.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { materializeContinueMessageAction } from "./conversation-action-planner.js";
import { rethrowTerminalMessageOverflow } from "./conversation-handoff-overflow.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { ConversationQueuedMessageDeliveryAuthorityV1 } from "./conversation-message-queue-runtime.js";
import { resumeActiveConversationRevision } from "./revision-active-resume.js";
import type { RevisionCrashPointV1 } from "./revision-crash-fault.js";
import { ConversationRevisionOperationExecutor } from "./revision-operation-executor.js";
import {
  deriveRevisionChildIdentity,
  materializeReleasedRevisionReservation,
  materializeRevisionOperation,
  materializeRevisionPreparationPlan,
  materializeRevisionReservation,
} from "./revision-planner.js";
import {
  findPublishedContinuation,
  revisionActionIdempotencyKey,
} from "./revision-publication-replay.js";
import { ConversationRevisionRequestSingleFlightV1 } from "./revision-request-singleflight.js";
import {
  type ResolvedRevisionBaseV1,
  buildRevisionHandoff,
  defaultConversationActionAuthority,
  materializeFreshRevisionBindings,
  materializeRevisionManifest,
  resolveRevisionBase,
  revisionBindingProjection,
  revisionManifestRecord,
} from "./revision-source.js";
import type { ConversationRuntime } from "./runtime.js";
import type {
  ConversationBinding,
  ConversationCreateResult,
  ConversationManifest,
  ConversationSnapshot,
  MessageRequest,
} from "./types.js";

export interface ConversationRevisionAuthorityOptions {
  runtime: ConversationRuntime;
  artifactStore: ConversationArtifactStore;
  artifactRoot: string;
  traceRoot: string;
  home: ConversationHomeAuthorities;
  now(): string;
  schedule(task: () => void): void;
  rehydrateBinding(
    binding: ConversationBinding,
    manifest: ConversationManifest,
  ): Promise<MaterializedAgentBinding>;
  executeConfigured(
    manifest: ConversationManifest,
    operationId: string,
  ): Promise<ConversationCreateResult>;
  revisionSettled(conversationId: string): void;
  revisionFault?(point: RevisionCrashPointV1): void;
}

function plusHour(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 60 * 60_000).toISOString();
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

/** Owns the revision reservation, WAL, head CAS, publication, and child activation closure. */
export class ConversationRevisionAuthority {
  private readonly requests = new ConversationRevisionRequestSingleFlightV1<{
    childId: string;
    proposalId: string;
    created: boolean;
  }>();
  private readonly executor: ConversationRevisionOperationExecutor;

  constructor(private readonly options: ConversationRevisionAuthorityOptions) {
    this.executor = new ConversationRevisionOperationExecutor(options);
  }

  continueMessage(
    conversationId: string,
    snapshot: ConversationSnapshot,
    request: MessageRequest & { target_participants: "all" | string[] },
    messageKey: string,
    authority?: ActionRequestAuthorityV1,
    queueDelivery?: ConversationQueuedMessageDeliveryAuthorityV1,
  ): Promise<string> {
    return this.continueMessageAction(
      conversationId,
      snapshot,
      request,
      messageKey,
      authority,
      undefined,
      queueDelivery,
    ).then((result) => result.childId);
  }

  continueMessageAction(
    conversationId: string,
    snapshot: ConversationSnapshot,
    request: MessageRequest & { target_participants: "all" | string[] },
    messageKey: string,
    authority?: ActionRequestAuthorityV1,
    expected?: ActionProposalRequestV1["expected"],
    queueDelivery?: ConversationQueuedMessageDeliveryAuthorityV1,
  ): Promise<{ childId: string; proposalId: string; created: boolean }> {
    const key = `${conversationId}\0${messageKey}`;
    return this.requests.run(key, () =>
      this.createRevision(
        conversationId,
        snapshot,
        request,
        messageKey,
        authority,
        expected,
        queueDelivery,
      ),
    );
  }

  private async createRevision(
    conversationId: string,
    snapshot: ConversationSnapshot,
    request: MessageRequest & { target_participants: "all" | string[] },
    messageKey: string,
    suppliedAuthority?: ActionRequestAuthorityV1,
    expected?: ActionProposalRequestV1["expected"],
    queueDelivery?: ConversationQueuedMessageDeliveryAuthorityV1,
  ): Promise<{ childId: string; proposalId: string; created: boolean }> {
    queueDelivery?.assertRequest(request, messageKey);
    const replay = findPublishedContinuation(
      this.options.home.publishedRevisionTransitions(),
      conversationId,
      request,
      messageKey,
    );
    if (replay) {
      queueDelivery?.bindChild(replay.childId);
      return replay;
    }
    if (this.options.runtime.operationId(conversationId) !== null)
      throw new Error("conversation still has live operation authority");
    const base = resolveRevisionBase({
      artifactRoot: this.options.artifactRoot,
      traceRoot: this.options.traceRoot,
      conversationId,
      home: this.options.home,
    });
    if (
      expected &&
      (expected.mode !== "writable-revision" ||
        expected.conversation_id !== base.parent.node.conversation_id ||
        expected.revision_id !== base.parent.node.revision_id ||
        expected.last_seq !== base.parent.source.journal_head.last_seq ||
        expected.conversation_lock_digest !== base.lock.lock_digest)
    )
      throw new Error("conversation proposal expected source is stale");
    if (base.reservation?.status === "active")
      return resumeActiveConversationRevision({
        base,
        request,
        messageKey,
        ...(queueDelivery ? { queueDelivery } : {}),
        options: this.options,
        executor: this.executor,
      });
    const claim = this.options.home.revisions.claimRequest({
      root_session_id: base.lineage.root_session_id,
      parent_conversation_id: base.parent.node.conversation_id,
      parent_revision_id: base.parent.node.revision_id,
      message_key: messageKey,
      created_at: this.options.now(),
    });
    const manifest = base.parent.source.manifest;
    const projection = revisionBindingProjection({
      manifest,
      authorities: base.parent.source.manifest_record.binding_authorities,
    });
    const revisionClaimEpoch = (base.reservation?.revision_claim_epoch ?? 0) + 1;
    const actionAuthority =
      suppliedAuthority ?? defaultConversationActionAuthority(base.lineage.root_session_id);
    const actionKey = revisionActionIdempotencyKey(messageKey, revisionClaimEpoch);
    let handoff: ReturnType<typeof buildRevisionHandoff>;
    try {
      handoff = buildRevisionHandoff({
        base,
        bindings: projection.publicBindings,
        snapshot,
      });
    } catch (error) {
      rethrowTerminalMessageOverflow({
        error,
        home: this.options.home,
        base,
        request,
        action_key: actionKey,
        authority: actionAuthority,
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
      revision_claim_epoch: revisionClaimEpoch,
      binding_delta_digest: projection.bindingDeltaDigest,
      resulting_binding_set_digest: projection.bindingSetDigest,
      handoff_selection_plan_digest: handoff.selection_plan.selection_digest,
      participant_starts: projection.participantStarts,
      created_at: claim.created_at,
      expires_at: plusHour(claim.created_at),
    });
    const planned = materializeContinueMessageAction({
      root_session_id: base.lineage.root_session_id,
      conversation_id: base.parent.node.conversation_id,
      revision_id: base.parent.node.revision_id,
      last_seq: base.parent.source.journal_head.last_seq,
      conversation_lock_digest: base.lock.lock_digest,
      head: base.head,
      request,
      message_key: actionKey,
      authority: actionAuthority,
      revision_plan: revisionPlan,
      created_at: claim.created_at,
    });
    const action = this.options.home.actions.proposal(planned, actionAuthority);
    const child = deriveRevisionChildIdentity({
      root_session_id: base.lineage.root_session_id,
      parent_conversation_id: base.parent.node.conversation_id,
      parent_revision_id: base.parent.node.revision_id,
      proposal_id: action.proposal.proposal_id,
      revision_claim_epoch: revisionClaimEpoch,
      revision_ordinal: base.parent.node.revision_ordinal + 1,
    });
    const operation = materializeRevisionOperation({
      operation_id: planned.operation_id,
      proposal_id: action.proposal.proposal_id,
      proposal_digest: action.proposal.proposal_digest,
      approval_id: action.approval.approval_id,
      approval_digest: action.approval.approval_digest,
      plan_digest: action.proposal.plan_digest,
      authority_epoch: action.proposal.base.authority_epoch,
      authority_head_digest: action.proposal.base.authority_head_digest,
      root_session_id: base.lineage.root_session_id,
      parent: base.parent.node,
      child,
      expected_head_digest: base.head.content_digest,
      expected_reservation_digest: base.reservation?.content_digest ?? null,
      expected_reservation_epoch: base.reservation?.reservation_epoch ?? 0,
      revision_claim_epoch: revisionClaimEpoch,
      expected_parent_last_seq: base.parent.source.journal_head.last_seq,
      expected_parent_lock_digest: base.lock.lock_digest,
      permission_digest: action.proposal.permission_digest,
      binding_set_digest: projection.bindingSetDigest,
      handoff_digest: handoff.handoff.digest,
      handoff_selection_digest: handoff.selection_plan.selection_digest,
      prompt_projection_digest: handoff.handoff.prompt_projection_digest,
      created_at: action.approval.decided_at,
    });
    const childManifest = materializeRevisionManifest({
      parent: manifest,
      child,
      operationId: operation.operation_id,
      createdAt: operation.created_at,
    });
    const materialized = await materializeFreshRevisionBindings({
      manifest: childManifest,
      rehydrate: this.options.rehydrateBinding,
    });
    if (!same(materialized.authorities, projection.intendedAuthorities))
      throw new Error("fresh revision binding authority changed during preparation");
    const manifestRecord = revisionManifestRecord(childManifest, materialized.authorities);
    const reservation = materializeRevisionReservation(operation);
    this.options.home.handoffs.write(
      handoff.handoff,
      handoff.selection_plan,
      handoff.omitted_public_event_artifacts,
    );
    this.options.home.revisions.writeHeader(operation, revisionPlan);
    try {
      this.options.home.lineage.commitReservation(base.reservation, reservation);
    } catch (error) {
      const current = this.options.home.lineage.readReservation(base.lineage.root_session_id);
      if (current?.content_digest !== reservation.content_digest) throw error;
    }
    const prepared = {
      operation,
      revisionPlan,
      reservation,
      actionPlan: planned.action_plan,
      proposal: action.proposal,
      approval: action.approval,
      manifest: childManifest,
      bindings: materialized.bindings,
      bindingAuthorities: materialized.authorities,
      manifestRecordDigest: manifestRecord.digest,
      handoff: handoff.handoff,
      sharedPrompt: handoff.shared_prompt_bytes.toString("utf8"),
      request,
      messageKey,
      runtimeOperationId: queueDelivery?.operationId ?? operation.operation_id,
      queueDelivery: queueDelivery ?? null,
      priorPublished: base.published,
    };
    try {
      await this.executor.execute(prepared, base.head);
      return {
        childId: operation.child.conversation_id,
        proposalId: operation.proposal_id,
        created: true,
      };
    } catch (error) {
      const currentHead = this.options.home.lineage.readHead(base.lineage.root_session_id);
      const current = this.options.home.lineage.readReservation(base.lineage.root_session_id);
      if (
        currentHead?.updated_by_operation_id === operation.operation_id &&
        currentHead.active?.conversation_id === operation.child.conversation_id
      ) {
        await this.options.runtime.abandon(
          operation.child.conversation_id,
          "revision execution already published",
        );
        return {
          childId: operation.child.conversation_id,
          proposalId: operation.proposal_id,
          created: false,
        };
      }
      if (
        currentHead?.content_digest === base.head.content_digest &&
        current?.content_digest === reservation.content_digest
      ) {
        this.executor.abandon(prepared, "preparation_failed");
        this.options.home.lineage.commitReservation(
          current,
          materializeReleasedRevisionReservation(current, operation.created_at),
        );
        this.options.revisionSettled(base.lineage.root_session_id);
      }
      throw error;
    }
  }
}
