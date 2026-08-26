import type { ActionProposalResponseV1, ActionProposalV1 } from "../../actions/index.js";
import type { StoredTraceEvent } from "../trace/types.js";
import { CapabilityConversationSourceStaleError } from "./capability-proposal-base.js";
import type { ConversationActionDomainRegistryV1 } from "./conversation-action-registry.js";
import {
  AGENT_ACTION_CANDIDATE_BARRIER_POINT,
  AGENT_ACTION_CANDIDATE_FAILURE_DISPOSITION,
  AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE,
  AGENT_ACTION_CANDIDATE_RECEIPT_STATE,
  AGENT_ACTION_CANDIDATE_REJECTION_CODE,
  AGENT_ACTION_CANDIDATE_SOURCE_LIFECYCLE,
  type AgentActionCandidateBarrierPointV1,
  type AgentActionCandidateReviewPhaseV1,
} from "./conversation-agent-action-candidate-contract.js";
import { ConversationAgentActionCandidateMaterializationLockV1 } from "./conversation-agent-action-candidate-materialization-lock.js";
import { projectCanonicalAgentActionCandidateReceipt } from "./conversation-agent-action-candidate-projection.js";
import {
  type DurableAgentActionCandidateMaterializedReceiptV1,
  materializeDurableAgentActionCandidateReceipt,
  materializeDurableAgentActionCandidateRejection,
} from "./conversation-agent-action-candidate-receipts.js";
import type { DurableAgentActionCandidateStageV1 } from "./conversation-agent-action-candidate-records.js";
import { recoverPreparedAgentActionWinners } from "./conversation-agent-action-candidate-recovery.js";
import {
  agentActionCandidateAuthority,
  agentActionCandidateGrantDigest,
  agentActionProposalRequest,
  isAgentActionCandidateGranted,
  isValidCompletedAgentActionOrigin,
  recoverExistingAgentActionProposal,
} from "./conversation-agent-action-candidate-request.js";
import { assertCurrentAgentActionProposalReviewSource } from "./conversation-agent-action-candidate-review.js";
import {
  type AgentActionCandidateMaterializationV1,
  type AgentActionCandidateRecordResultV1,
  stageAgentActionCandidate,
} from "./conversation-agent-action-candidate-stage.js";
import { ConversationAgentActionCandidateStoreV1 } from "./conversation-agent-action-candidate-store.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import {
  ConversationRevisionInactiveHeadError,
  ConversationRevisionNotStableTerminalError,
} from "./revision-errors.js";
import { resolveConversationLineageSource, resolveRevisionBase } from "./revision-source.js";
import type { ConversationManifest } from "./types.js";

export type {
  AgentActionCandidateDiagnosticV1,
  AgentActionCandidateMaterializationV1,
  AgentActionCandidateRecordResultV1,
} from "./conversation-agent-action-candidate-stage.js";

/**
 * Owns untrusted agent candidates until a stable terminal source exists. A schema-valid candidate
 * is first written to a private immutable stage bound to the future public response idempotency
 * key. Recovery only materializes it after finding that exact completed response in the durable
 * terminal journal. It never approves, commits, or mutates a target.
 */
export class ConversationAgentActionCandidateAuthorityV1 {
  private readonly store: ConversationAgentActionCandidateStoreV1;
  private readonly materialization: ConversationAgentActionCandidateMaterializationLockV1;
  private actions: ConversationActionDomainRegistryV1 | null = null;
  private recovery: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: {
      artifactRoot: string;
      traceRoot: string;
      home: ConversationHomeAuthorities;
      barrier?: (input: {
        point: AgentActionCandidateBarrierPointV1;
        conversation_id: string;
      }) => Promise<void>;
    },
  ) {
    this.store = new ConversationAgentActionCandidateStoreV1(input.artifactRoot);
    this.materialization = new ConversationAgentActionCandidateMaterializationLockV1(
      input.artifactRoot,
    );
  }

  bind(actions: ConversationActionDomainRegistryV1): void {
    if (this.actions && this.actions !== actions)
      throw new Error("agent action candidate registry binding conflict");
    this.actions = actions;
    actions.bindCandidateRecovery((conversationId) => this.flush(conversationId));
    this.recovery = this.recover();
    // Durable stages remain authoritative when a terminal source or domain is temporarily absent.
    // Every bootstrap retries them; callers may also await/retry recovery explicitly.
    void this.recovery.catch(() => undefined);
  }

  awaitRecovery(): Promise<void> {
    return this.recovery;
  }

  stage(input: {
    manifest: ConversationManifest;
    participant_id: string;
    response_idempotency_key: string;
    candidate: unknown;
  }): AgentActionCandidateRecordResultV1 {
    return stageAgentActionCandidate({
      ...this.input,
      store: this.store,
      actions: this.actions,
      ...input,
    });
  }

  private canonicalReceiptProjection(
    stage: DurableAgentActionCandidateStageV1,
    receipt: DurableAgentActionCandidateMaterializedReceiptV1,
  ): Promise<ActionProposalResponseV1> {
    return projectCanonicalAgentActionCandidateReceipt({
      home: this.input.home,
      actions: this.actions,
      stage,
      receipt,
    });
  }

  assertReviewSource(
    proposal: ActionProposalV1,
    now: string,
    phase: AgentActionCandidateReviewPhaseV1,
    approvalId: string | null,
  ): string {
    return assertCurrentAgentActionProposalReviewSource({
      ...this.input,
      store: this.store,
      proposal,
      now,
      phase,
      approval_id: approvalId,
    });
  }

  async materializations(conversationId: string): Promise<AgentActionCandidateMaterializationV1[]> {
    const rows: AgentActionCandidateMaterializationV1[] = [];
    for (const stage of this.store.stagesForConversation(conversationId)) {
      const receipt = this.store.readReceipt(stage.record_digest);
      rows.push(
        receipt?.state === AGENT_ACTION_CANDIDATE_RECEIPT_STATE.MATERIALIZED
          ? {
              record_digest: stage.record_digest,
              state: AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE.MATERIALIZED,
              proposal: await this.canonicalReceiptProjection(stage, receipt),
              rejection_code: null,
            }
          : receipt?.state === AGENT_ACTION_CANDIDATE_RECEIPT_STATE.REJECTED
            ? {
                record_digest: stage.record_digest,
                state: AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE.REJECTED,
                proposal: null,
                rejection_code: receipt.rejection_code,
              }
            : {
                record_digest: stage.record_digest,
                state: AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE.PENDING,
                proposal: null,
                rejection_code: null,
              },
      );
    }
    return rows;
  }

  private async flushStage(
    stage: DurableAgentActionCandidateStageV1,
    base: ReturnType<typeof resolveRevisionBase>,
  ): Promise<void> {
    const actions = this.actions;
    if (!actions) throw new Error("agent action candidate registry is not bound");
    const existingReceipt = this.store.readReceipt(stage.record_digest);
    if (existingReceipt) {
      if (existingReceipt.state === AGENT_ACTION_CANDIDATE_RECEIPT_STATE.REJECTED) return;
      await this.canonicalReceiptProjection(stage, existingReceipt);
      return;
    }
    if (
      base.parent.source.journal_head.lifecycle !==
      AGENT_ACTION_CANDIDATE_SOURCE_LIFECYCLE.COMPLETED
    ) {
      this.store.writeReceipt(
        materializeDurableAgentActionCandidateRejection({
          record_digest: stage.record_digest,
          rejection_code: AGENT_ACTION_CANDIDATE_REJECTION_CODE.TERMINAL_NOT_COMPLETED,
        }),
      );
      return;
    }
    if (stage.revision_id !== base.parent.node.revision_id) {
      this.store.writeReceipt(
        materializeDurableAgentActionCandidateRejection({
          record_digest: stage.record_digest,
          rejection_code: AGENT_ACTION_CANDIDATE_REJECTION_CODE.SOURCE_CHANGED,
        }),
      );
      return;
    }
    if (
      !isAgentActionCandidateGranted(base.parent.source.manifest, stage.participant_id) ||
      agentActionCandidateGrantDigest(base.parent.source.manifest, stage.participant_id) !==
        stage.grant_digest
    ) {
      this.store.writeReceipt(
        materializeDurableAgentActionCandidateRejection({
          record_digest: stage.record_digest,
          rejection_code: AGENT_ACTION_CANDIDATE_REJECTION_CODE.GRANT_REVOKED,
        }),
      );
      return;
    }
    const origins = base.parent.source.journal_records
      .map(({ stored_event: event }) => event)
      .filter(
        (event) =>
          event.idempotency_key === stage.response_idempotency_key &&
          isValidCompletedAgentActionOrigin(
            base.parent.source.manifest,
            stage.participant_id,
            event,
            stage.response_idempotency_key,
          ),
      );
    if (origins.length === 0) {
      this.store.writeReceipt(
        materializeDurableAgentActionCandidateRejection({
          record_digest: stage.record_digest,
          rejection_code: AGENT_ACTION_CANDIDATE_REJECTION_CODE.ORIGIN_RESPONSE_ABSENT,
        }),
      );
      return;
    }
    if (origins.length !== 1)
      throw new Error("candidate has no unique completed public response origin");
    const origin = origins[0] as StoredTraceEvent;
    const authority = agentActionCandidateAuthority(
      base.lineage.root_session_id,
      stage.participant_id,
      stage.grant_digest,
    );
    const request = agentActionProposalRequest(stage, origin, base);
    let proposed: ActionProposalResponseV1 | null = null;
    try {
      proposed = (
        await actions.propose({
          conversation_id: stage.conversation_id,
          request,
          authority,
        })
      ).response;
    } catch (error) {
      proposed = await recoverExistingAgentActionProposal({
        home: this.input.home,
        actions,
        conversation_id: stage.conversation_id,
        participant_id: stage.participant_id,
        request,
        authority,
      });
      if (!proposed) {
        if (error instanceof CapabilityConversationSourceStaleError) {
          this.store.writeReceipt(
            materializeDurableAgentActionCandidateRejection({
              record_digest: stage.record_digest,
              rejection_code: AGENT_ACTION_CANDIDATE_REJECTION_CODE.SOURCE_CHANGED,
            }),
          );
          return;
        }
        if (
          actions.candidateFailureDisposition(stage.candidate, error) ===
          AGENT_ACTION_CANDIDATE_FAILURE_DISPOSITION.RETRY
        )
          throw error;
        this.store.writeReceipt(
          materializeDurableAgentActionCandidateRejection({
            record_digest: stage.record_digest,
            rejection_code: AGENT_ACTION_CANDIDATE_REJECTION_CODE.CANDIDATE_NOT_ACTIONABLE,
          }),
        );
        return;
      }
    }
    await this.finishMaterialization(stage, proposed, origin.event_id);
  }

  private async finishMaterialization(
    stage: DurableAgentActionCandidateStageV1,
    proposed: ActionProposalResponseV1,
    originEventId: string,
  ): Promise<void> {
    if (
      proposed.proposal.origin_event_id !== originEventId ||
      proposed.proposal.proposal_id !== proposed.operation.proposal_id ||
      proposed.proposal.proposal_digest !== proposed.operation.proposal_digest
    )
      throw new Error("agent action proposal projection is not origin-bound");
    await this.input.barrier?.({
      point: AGENT_ACTION_CANDIDATE_BARRIER_POINT.AFTER_PROPOSAL_MATERIALIZED,
      conversation_id: stage.conversation_id,
    });
    this.store.writeReceipt(
      materializeDurableAgentActionCandidateReceipt({
        record_digest: stage.record_digest,
        origin_response_event_id: originEventId,
        proposal_id: proposed.proposal.proposal_id,
        proposal_digest: proposed.proposal.proposal_digest,
      }),
    );
  }

  private async flushLocked(conversationId: string): Promise<void> {
    if (!this.actions) throw new Error("agent action candidate registry is not bound");
    const queued: DurableAgentActionCandidateStageV1[] = [];
    for (const stage of this.store.stagesForConversation(conversationId)) {
      const receipt = this.store.readReceipt(stage.record_digest);
      if (receipt?.state === AGENT_ACTION_CANDIDATE_RECEIPT_STATE.MATERIALIZED)
        await this.canonicalReceiptProjection(stage, receipt);
      else if (!receipt) queued.push(stage);
    }
    if (!queued.length) return;
    const source = resolveConversationLineageSource({
      artifactRoot: this.input.artifactRoot,
      traceRoot: this.input.traceRoot,
      conversationId,
      home: this.input.home,
    });
    await recoverPreparedAgentActionWinners({
      stages: queued,
      source,
      home: this.input.home,
      actions: this.actions,
      finish: (stage, proposal, origin) => this.finishMaterialization(stage, proposal, origin),
    });
    const remaining = queued.filter((stage) => !this.store.readReceipt(stage.record_digest));
    if (!remaining.length) return;
    let base: ReturnType<typeof resolveRevisionBase>;
    try {
      base = resolveRevisionBase({
        artifactRoot: this.input.artifactRoot,
        traceRoot: this.input.traceRoot,
        conversationId,
        home: this.input.home,
      });
    } catch (error) {
      if (error instanceof ConversationRevisionNotStableTerminalError) return;
      if (error instanceof ConversationRevisionInactiveHeadError) {
        for (const stage of remaining)
          this.store.writeReceipt(
            materializeDurableAgentActionCandidateRejection({
              record_digest: stage.record_digest,
              rejection_code: AGENT_ACTION_CANDIDATE_REJECTION_CODE.SOURCE_CHANGED,
            }),
          );
        return;
      }
      throw error;
    }
    const failures: unknown[] = [];
    for (const stage of remaining) {
      try {
        await this.flushStage(stage, base);
      } catch (error) {
        // No stage or valid proposal is deleted/rejected here. The immutable pending stage is the
        // retry authority for this and subsequent process lifetimes.
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "agent action candidate materialization remains pending");
  }

  flush(conversationId: string): Promise<void> {
    return this.materialization.run(conversationId, () => this.flushLocked(conversationId));
  }

  async recover(): Promise<void> {
    const failures: unknown[] = [];
    for (const conversationId of this.store.conversationIds()) {
      try {
        await this.flush(conversationId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "one or more durable agent action candidates remain pending",
      );
  }
}
