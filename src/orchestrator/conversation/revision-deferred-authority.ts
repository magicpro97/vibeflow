import type { ActionProposalRequestV1, ActionRequestAuthorityV1 } from "../../actions/index.js";
import type { ConversationRevisionAuthorityOptions } from "./revision-authority.js";
import {
  type DeferredRevisionCommitInputV1,
  commitDeferredRevision,
} from "./revision-deferred-commit.js";
import { prepareDeferredRevisionProposal } from "./revision-deferred-proposal.js";
import {
  type ValidatedDeferredRevisionCommitV1,
  type ValidatedPublishedRevisionReplayV1,
  findValidatedPublishedRevisionReplay,
  validateDeferredRevisionCommit,
} from "./revision-deferred-validation.js";
import { foldRevisionOperation } from "./revision-fold.js";
import { ConversationRevisionOperationExecutor } from "./revision-operation-executor.js";
import { DeferredRevisionProposalStore } from "./revision-proposal-store.js";
import { reconcilePublishedRevisionReservation } from "./revision-reservation-reconciliation.js";
import {
  reconcilePublishedRevisionStartTerminal,
  recoverInterruptedPublishedRevisionStart,
} from "./revision-start-finalizer.js";
import { RevisionStartOwnerAuthority } from "./revision-start-owner.js";
import type { ConversationSnapshot } from "./types.js";

export class ConversationDeferredRevisionAuthority {
  private readonly executor: ConversationRevisionOperationExecutor;
  private readonly proposals: DeferredRevisionProposalStore;
  private readonly startOwners: RevisionStartOwnerAuthority;
  private readonly inFlight = new Map<string, Promise<{ childId: string }>>();

  constructor(private readonly options: ConversationRevisionAuthorityOptions) {
    this.executor = new ConversationRevisionOperationExecutor(options);
    this.proposals = new DeferredRevisionProposalStore(options.artifactRoot);
    this.startOwners = new RevisionStartOwnerAuthority(options.artifactRoot);
  }

  proposeAction(input: {
    conversationId: string;
    snapshot: ConversationSnapshot;
    request: ActionProposalRequestV1;
    authority: ActionRequestAuthorityV1;
  }): Promise<{ created: boolean; proposalId: string }> {
    return prepareDeferredRevisionProposal({
      options: this.options,
      proposals: this.proposals,
      ...input,
    });
  }

  proposeContinuation(input: {
    conversationId: string;
    snapshot: ConversationSnapshot;
    request: ActionProposalRequestV1;
    authority: ActionRequestAuthorityV1;
  }): Promise<{ created: boolean; proposalId: string }> {
    if (input.request.candidate.type !== "conversation.continue_message")
      throw new Error("deferred revision proposal is not a continuation");
    return this.proposeAction(input);
  }

  commitAction(input: DeferredRevisionCommitInputV1): Promise<{ childId: string }> {
    const validated = validateDeferredRevisionCommit({
      options: this.options,
      proposals: this.proposals,
      commit: input,
    });
    const existing = this.inFlight.get(input.proposalId);
    if (existing) return existing;
    const running = this.commit(input, validated);
    this.inFlight.set(input.proposalId, running);
    const clear = () => {
      if (this.inFlight.get(input.proposalId) === running) this.inFlight.delete(input.proposalId);
    };
    void running.then(clear, clear);
    return running;
  }

  commitContinuation(input: DeferredRevisionCommitInputV1): Promise<{ childId: string }> {
    const action = this.options.home.actions.get(input.proposalId)?.proposal.action;
    if (action && action.type !== "conversation.continue_message")
      throw new Error("deferred revision proposal is not a continuation");
    return this.commitAction(input);
  }

  private async reconcilePublished(
    replay: ValidatedPublishedRevisionReplayV1,
    validated: ValidatedDeferredRevisionCommitV1,
  ): Promise<void> {
    const proposalId = validated.actionState.proposal.proposal_id;
    const startState = foldRevisionOperation(
      replay.operation,
      this.options.home.revisions.readEvents(replay.operation.operation_id),
    ).state;
    if (!["published", "starting"].includes(startState)) {
      this.options.home.revisions.publish(replay.operation.operation_id);
      this.options.artifactStore.publishRevision(
        replay.childId,
        replay.operation.operation_id,
        replay.operation.created_at,
      );
      reconcilePublishedRevisionReservation({
        lineage: this.options.home.lineage,
        reservation: replay.reservation,
        consumedAt: replay.operation.created_at,
      });
      reconcilePublishedRevisionStartTerminal({
        operation: replay.operation,
        proposalId,
        home: this.options.home,
      });
      return;
    }
    const owner = this.options.runtime.operationOwnerState(
      replay.childId,
      replay.operation.operation_id,
    );
    if (owner === "conversation_mismatch")
      throw new Error("published revision child live authority changed");
    if (owner === "local" || owner === "same_process_live") return;
    if (this.startOwners.status(replay.operation.operation_id) !== "dead") return;
    await recoverInterruptedPublishedRevisionStart({
      operation: replay.operation,
      revisionPlan: replay.revisionPlan,
      reservation: replay.reservation,
      proposalId,
      runtime: this.options.runtime,
      home: this.options.home,
      artifactStore: this.options.artifactStore,
      startOwners: this.startOwners,
    });
  }

  private async commit(
    input: DeferredRevisionCommitInputV1,
    validated: ValidatedDeferredRevisionCommitV1,
  ): Promise<{ childId: string }> {
    const replay = findValidatedPublishedRevisionReplay({ options: this.options, validated });
    if (replay) {
      await this.reconcilePublished(replay, validated);
      return { childId: replay.childId };
    }
    const committed = await commitDeferredRevision({
      options: this.options,
      executor: this.executor,
      proposals: this.proposals,
      commit: input,
      validated,
    });
    if (committed.reconcilePublished) {
      const published = findValidatedPublishedRevisionReplay({ options: this.options, validated });
      if (published) await this.reconcilePublished(published, validated);
    }
    return { childId: committed.childId };
  }
}
