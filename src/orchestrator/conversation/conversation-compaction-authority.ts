import {
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  type BrowserHostActionRequestV1,
  type JsonValue,
  deriveOperationId,
} from "../../actions/index.js";
import type { TraceStore } from "../trace/store.js";
import type { TraceCorrelation } from "../trace/types.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import { conversationLockDigest } from "./catalog-lock.js";
import {
  materializeConversationActionBinding,
  materializeConversationActionReceipt,
} from "./conversation-action-receipt-store.js";
import {
  prepareConversationCompactionArtifacts,
  verifyConversationCompactionArtifacts,
} from "./conversation-compaction-artifacts.js";
import {
  findConversationCompactionEvent,
  sameCompactionValue,
  sortedCompactionFacts,
} from "./conversation-compaction-helpers.js";
import {
  type ContextCompactionPlanV1,
  constructContextCompaction,
} from "./conversation-compaction-plan.js";
import { compactionSourceAuthorityMatches } from "./conversation-compaction-source-authority.js";
import { resolveCompactionSourceEvents } from "./conversation-compaction-source.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { assertReceiptSource } from "./conversation-receipt-native-plans.js";
import { materializeConversationReceiptProposal } from "./conversation-receipt-planner.js";
import { handoffSourcePublicHeadDigest } from "./handoff-selection.js";
import type { ConversationLineageService } from "./lineage-service.js";
import { revisionPublicTranscript } from "./revision-source.js";

type CompactionCandidate = Extract<BrowserHostActionRequestV1, { type: "context.compact" }>;

function isCompaction(candidate: BrowserHostActionRequestV1): candidate is CompactionCandidate {
  return candidate.type === "context.compact";
}

export class ConversationCompactionAuthority {
  constructor(
    private readonly options: {
      lineages: ConversationLineageService;
      home: ConversationHomeAuthorities;
      traceStore: TraceStore;
      artifactStore: ConversationArtifactStore;
      fault?(point: "after-artifacts-durable" | "after-trace-append"): void;
    },
  ) {}

  async propose(input: {
    conversation_id: string;
    request: ActionProposalRequestV1;
    authority: ActionRequestAuthorityV1;
  }) {
    const request = input.request.candidate;
    if (!isCompaction(request)) throw new Error("not a context compaction request");
    const resolved = this.options.lineages.resolve(input.conversation_id);
    assertReceiptSource(resolved, input.request);
    const candidate = this.options.home.oversizedHandoffs.readCandidate(
      request.oversized_candidate_id,
      request.oversized_candidate_digest,
    );
    if (!candidate) throw new Error("oversized handoff candidate is absent");
    const rejected = this.options.home.oversizedHandoffs.readRejected(candidate);
    if (
      candidate.source.conversation_id !== resolved.requested.node.conversation_id ||
      candidate.source.revision_id !== resolved.requested.node.revision_id ||
      candidate.source.last_seq !== resolved.requested.source.journal_head.last_seq ||
      candidate.source.lock_digest !== input.request.expected.conversation_lock_digest
    )
      throw new Error("oversized handoff candidate source changed");
    const sourceTranscript = revisionPublicTranscript(resolved.lineage, resolved.requested);
    if (
      handoffSourcePublicHeadDigest(candidate.source, [
        ...sourceTranscript.messages,
        ...sourceTranscript.responses,
      ]) !== candidate.source_public_head_digest ||
      conversationLockDigest(
        resolved.lineage.root_session_id,
        resolved.requested.source,
        resolved.revision_claim_epoch,
      ) !== candidate.source.lock_digest
    )
      throw new Error("oversized handoff public source binding changed");
    const createdAt = this.options.home.now();
    const constructed = constructContextCompaction({
      root_session_id: resolved.lineage.root_session_id,
      candidate,
      rejected,
      compaction_input: request.compaction_input,
      created_at: createdAt,
      projected_omitted_events: resolveCompactionSourceEvents({
        artifacts: this.options.artifactStore,
        resolved,
        rejected,
        omissionBytes: (reference) =>
          this.options.home.handoffs.readOmission(reference.content_sha256),
      }),
    });
    const planned = materializeConversationReceiptProposal({
      source: {
        root_session_id: resolved.lineage.root_session_id,
        conversation_id: resolved.requested.node.conversation_id,
        revision_id: resolved.requested.node.revision_id,
        last_seq: resolved.requested.source.journal_head.last_seq,
        conversation_lock_digest: candidate.source.lock_digest,
        head: resolved.head,
      },
      request: input.request,
      action: {
        type: "context.compact",
        oversized_candidate: candidate,
        profile: "vf-public-compaction/1",
        compaction_input: structuredClone(request.compaction_input),
      },
      authority: input.authority,
      effect_binding: constructed.plan as unknown as JsonValue,
      native_step: { kind: "context-compaction", digest: constructed.plan.plan_digest },
      created_at: createdAt,
    });
    this.options.home.actionReceipts.writePlan(planned.proposal_plan);
    const created = this.options.home.actions.create(planned.proposal_plan, input.authority);
    return { created: created.created, proposal_id: created.proposal.proposal_id };
  }

  private correlation(
    proposalId: string,
    operationId: string,
    manifest: {
      workflow_id: string;
      conversation_id: string;
      revision_id: string;
      run_id: string;
    },
  ): TraceCorrelation {
    const suffix = proposalId.slice("vf-proposal-".length, "vf-proposal-".length + 32);
    return {
      workflow_id: manifest.workflow_id,
      conversation_id: manifest.conversation_id,
      revision_id: manifest.revision_id,
      run_id: manifest.run_id,
      turn_id: `compaction-turn-${suffix}`,
      operation_id: operationId,
      attempt_id: `compaction-attempt-${suffix}`,
    };
  }

  async commit(proposalId: string): Promise<void> {
    const snapshot = this.options.home.actions.get(proposalId);
    const stored = this.options.home.actionReceipts.readPlan(proposalId);
    const action = snapshot?.proposal.action;
    if (!snapshot?.approval || !stored || action?.type !== "context.compact")
      throw new Error("context compaction approval is absent");
    const operationId =
      snapshot.operation_id ?? deriveOperationId(snapshot.proposal, snapshot.approval.approval_id);
    const terminal = this.options.home.actionReceipts.read(proposalId);
    if (terminal) {
      this.options.home.actions.terminal(proposalId, operationId, {
        outcome: terminal.outcome,
        digest: terminal.receipt_digest,
        recorded_at: terminal.recorded_at,
      });
      this.options.home.lineageMutations.release({
        kind: "context-compaction",
        proposal: snapshot.proposal,
        approval: snapshot.approval,
        outcome: terminal.outcome === "succeeded" ? "succeeded" : "aborted",
        terminal_digest: terminal.receipt_digest,
        now: terminal.recorded_at,
      });
      return;
    }
    const candidate = this.options.home.oversizedHandoffs.readCandidate(
      action.oversized_candidate.candidate_id,
      action.oversized_candidate.candidate_digest,
    );
    if (!candidate || !sameCompactionValue(candidate, action.oversized_candidate))
      throw new Error("context compaction candidate changed");
    const rejected = this.options.home.oversizedHandoffs.readRejected(candidate);
    const plan = stored.native_plan.effect_binding as unknown as ContextCompactionPlanV1;
    const construction = constructContextCompaction({
      root_session_id: stored.native_plan.root_session_id,
      candidate,
      rejected,
      compaction_input: action.compaction_input,
      created_at: plan.created_at,
      projected_omitted_events: resolveCompactionSourceEvents({
        artifacts: this.options.artifactStore,
        resolved: this.options.lineages.resolve(candidate.source.conversation_id),
        rejected,
        omissionBytes: (reference) =>
          this.options.home.handoffs.readOmission(reference.content_sha256),
      }),
    });
    if (!sameCompactionValue(plan, construction.plan))
      throw new Error("context compaction plan changed");
    const resolved = this.options.lineages.resolve(candidate.source.conversation_id);
    const publicTranscript = revisionPublicTranscript(resolved.lineage, resolved.requested);
    const publicHead = handoffSourcePublicHeadDigest(candidate.source, [
      ...publicTranscript.messages,
      ...publicTranscript.responses,
    ]);
    const existing = await findConversationCompactionEvent(
      this.options.traceStore,
      candidate.source.conversation_id,
      proposalId,
    );
    if (
      !existing &&
      (!compactionSourceAuthorityMatches({
        proposalId,
        candidate,
        construction,
        resolved,
      }) ||
        publicHead !== candidate.source_public_head_digest ||
        resolved.requested.node.revision_id !== candidate.source.revision_id)
    )
      throw new Error("context compaction source head changed");
    const prepared = prepareConversationCompactionArtifacts({
      artifacts: this.options.artifactStore,
      conversation_id: candidate.source.conversation_id,
      proposal_id: proposalId,
      construction,
    });
    const currentMutation = this.options.home.lineageMutations.current(
      resolved.lineage.root_session_id,
    );
    try {
      if (!existing || currentMutation?.proposal_id === proposalId)
        this.options.home.lineageMutations.claim({
          kind: "context-compaction",
          proposal: snapshot.proposal,
          approval: snapshot.approval,
          now: snapshot.approval.decided_at,
          resolveSource: () => {
            const current = this.options.lineages.resolve(candidate.source.conversation_id);
            const transcript = revisionPublicTranscript(current.lineage, current.requested);
            const currentPublicHead = handoffSourcePublicHeadDigest(candidate.source, [
              ...transcript.messages,
              ...transcript.responses,
            ]);
            if (
              !compactionSourceAuthorityMatches({
                proposalId,
                candidate,
                construction,
                resolved: current,
              }) ||
              currentPublicHead !== candidate.source_public_head_digest ||
              current.requested.node.revision_id !== candidate.source.revision_id
            )
              throw new Error("context compaction source head changed");
            return {
              root_session_id: current.lineage.root_session_id,
              conversation_id: current.requested.node.conversation_id,
              revision_id: current.requested.node.revision_id,
              last_seq: candidate.source.last_seq,
              conversation_lock_digest: candidate.source.lock_digest,
              lineage_head_digest: current.head.content_digest,
              lineage_head_epoch: current.head.head_epoch,
            };
          },
        });
    } catch (error) {
      for (const artifact of prepared.preparations.reverse()) artifact.rollback();
      throw error;
    }
    const dispatch = (() => {
      try {
        return this.options.home.actions.dispatch(proposalId, snapshot.approval.approval_id, {
          digest: stored.record_digest,
          recorded_at: snapshot.approval.decided_at,
        });
      } catch (error) {
        for (const artifact of prepared.preparations.reverse()) artifact.rollback();
        this.options.home.lineageMutations.release({
          kind: "context-compaction",
          proposal: snapshot.proposal,
          approval: snapshot.approval,
          outcome: "aborted",
          terminal_digest: snapshot.proposal.proposal_digest,
          now: this.options.home.now(),
        });
        throw error;
      }
    })();
    try {
      for (const artifact of prepared.preparations) artifact.commit();
    } catch (error) {
      for (const artifact of prepared.preparations.reverse()) artifact.rollback();
      throw error;
    }
    verifyConversationCompactionArtifacts({
      artifacts: this.options.artifactStore,
      conversation_id: candidate.source.conversation_id,
      construction,
      omitted_refs: prepared.omitted_refs,
      compaction_ref: prepared.compaction_ref,
    });
    this.options.fault?.("after-artifacts-durable");
    let event = existing;
    if (!event) {
      event = await this.options.traceStore.append(
        this.correlation(proposalId, dispatch.operation_id, resolved.requested.source.manifest),
        {
          idempotency_key: `action-context-compaction:${proposalId}`,
          event: {
            type: "artifact_created",
            payload: {
              artifact_id: construction.artifact_id,
              artifact_type: "compaction",
              ref: prepared.compaction_ref,
            },
          },
        },
        null,
        candidate.source.last_seq,
      );
    } else if (
      event.event.type !== "artifact_created" ||
      event.event.payload.artifact_type !== "compaction" ||
      event.event.payload.artifact_id !== construction.artifact_id ||
      event.event.payload.ref !== prepared.compaction_ref
    ) {
      throw new Error("context compaction replay event changed");
    }
    if (!event) throw new Error("context compaction event is absent");
    this.options.fault?.("after-trace-append");
    const after = this.options.lineages.resolve(candidate.source.conversation_id);
    const expected = materializeConversationActionBinding({
      action_type: "context.compact",
      plan_digest: snapshot.proposal.plan_digest,
      phase: "expected",
      facts: sortedCompactionFacts([
        {
          kind: "public-trace-head",
          identity: `trace:${candidate.source.revision_id}`,
          content_digest: candidate.source_public_head_digest,
        },
        {
          kind: "content-object",
          identity: `content:${construction.artifact_id}`,
          content_digest: construction.artifact.content_digest,
        },
      ]),
    });
    const observed = materializeConversationActionBinding({
      action_type: "context.compact",
      plan_digest: snapshot.proposal.plan_digest,
      phase: "observed",
      facts: sortedCompactionFacts([
        {
          kind: "public-trace-head",
          identity: `trace:${candidate.source.revision_id}`,
          content_digest: after.requested.source.journal_head.record_digest,
        },
        {
          kind: "content-object",
          identity: `content:${construction.artifact_id}`,
          content_digest: construction.artifact.content_digest,
        },
      ]),
    });
    const receipt = materializeConversationActionReceipt({
      operation_id: dispatch.operation_id,
      proposal_id: proposalId,
      approval_id: snapshot.approval.approval_id,
      action_type: "context.compact",
      plan_digest: snapshot.proposal.plan_digest,
      expected_authority_binding_digest: expected.binding_digest,
      observed_authority_binding_digest: observed.binding_digest,
      outcome: "succeeded",
      reason_code: null,
      recorded_at: event.ts,
    });
    this.options.home.actionReceipts.writeBinding(expected);
    this.options.home.actionReceipts.writeBinding(observed);
    this.options.home.actionReceipts.append(receipt);
    this.options.home.actions.terminal(proposalId, dispatch.operation_id, {
      outcome: "succeeded",
      digest: receipt.receipt_digest,
      recorded_at: receipt.recorded_at,
    });
    this.options.home.lineageMutations.release({
      kind: "context-compaction",
      proposal: snapshot.proposal,
      approval: snapshot.approval,
      outcome: "succeeded",
      terminal_digest: receipt.receipt_digest,
      now: receipt.recorded_at,
    });
  }
}
