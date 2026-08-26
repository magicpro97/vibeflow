import {
  type ActionApprovalChallengeRequestV1,
  type ActionApprovalChallengeResponseV1,
  type ActionApprovalRequestV1,
  type ActionApprovalResponseV1,
  type ActionCancelRequestV1,
  type ActionCommitRequestV1,
  ActionConflictError,
  type ActionMutationResponseV1,
  type ActionOperationEventV1,
  type ActionProposalRequestV1,
  type ActionProposalResponseV1,
  type ActionRequestAuthorityV1,
  type BrowserHostActionRequestV1,
  type HostActionKind,
} from "../../actions/index.js";
import type { ConversationActionService } from "./conversation-action-service.js";
import type { ConversationReceiptActionAuthority } from "./conversation-receipt-action-authority.js";
import { ConversationReceiptCandidateUnavailableError } from "./conversation-receipt-errors.js";
import { isConversationRevisionMutation } from "./revision-action-manifest.js";
import {
  ConversationHandoffTooLargeError,
  ConversationRevisionCandidateInvalidError,
  ConversationRevisionConflictError,
} from "./revision-errors.js";
import { ConversationInvalidTargetParticipantError } from "./service-errors.js";
import type { ConversationOrchestrator } from "./service.js";

export interface ConversationActionProposalContextV1 {
  conversation_id: string;
  request: ActionProposalRequestV1;
  authority: ActionRequestAuthorityV1;
}

interface ProposalMutationContextV1<T> {
  conversation_id: string;
  proposal_id: string;
  request: T;
  authority: ActionRequestAuthorityV1;
}

export interface ConversationActionDomainPlannerExecutorV1 {
  readonly domain: "conversation" | "capability";
  recover?(): Promise<void>;
  supports(candidate: BrowserHostActionRequestV1): boolean;
  candidateFailureDisposition(error: unknown): "reject" | "retry";
  propose(
    context: ConversationActionProposalContextV1,
  ): Promise<{ created: boolean; response: ActionProposalResponseV1 }>;
  get(conversationId: string, proposalId: string): Promise<ActionProposalResponseV1 | null>;
  pending(conversationId: string): Promise<ActionProposalResponseV1[]>;
  anchored(input: {
    conversation_id: string;
    revision_id: string;
    origin_event_id: string | null;
  }): Promise<ActionProposalResponseV1[]>;
  events(conversationId: string, proposalId: string): Promise<ActionOperationEventV1[] | null>;
  subscribe?(conversationId: string, proposalId: string, listener: () => void): (() => void) | null;
  challenge(
    context: ProposalMutationContextV1<ActionApprovalChallengeRequestV1>,
  ): Promise<ActionApprovalChallengeResponseV1>;
  approve(
    context: ProposalMutationContextV1<ActionApprovalRequestV1>,
  ): Promise<ActionApprovalResponseV1>;
  commit(
    context: ProposalMutationContextV1<ActionCommitRequestV1>,
  ): Promise<ActionMutationResponseV1>;
  cancel(
    context: ProposalMutationContextV1<ActionCancelRequestV1>,
  ): Promise<ActionMutationResponseV1>;
}

export class ConversationActionTargetUnsupportedError extends Error {
  readonly code = "target_unsupported" as const;
  constructor(readonly action_type: HostActionKind | null) {
    super("No installed domain handler supports this action target.");
    this.name = "ConversationActionTargetUnsupportedError";
  }
}

function owned(
  actions: ConversationActionService,
  conversationId: string,
  proposalId: string,
): ActionProposalResponseV1 | null {
  const view = actions.view(proposalId);
  const snapshot = actions.get(proposalId);
  return snapshot?.proposal.domain === "conversation" &&
    snapshot.proposal.base.conversation_id === conversationId
    ? view
    : null;
}

/** Real revision-backed conversation action handler. Unsupported kinds never fake success. */
export class ConversationRevisionActionDomainV1
  implements ConversationActionDomainPlannerExecutorV1
{
  readonly domain = "conversation" as const;

  constructor(
    private readonly service: Pick<
      ConversationOrchestrator,
      "proposeConversationAction" | "commitConversationAction"
    >,
    private readonly actions: ConversationActionService,
    private readonly receipts?: ConversationReceiptActionAuthority,
  ) {}

  supports(candidate: BrowserHostActionRequestV1): boolean {
    return isConversationRevisionMutation(candidate) || Boolean(this.receipts?.supports(candidate));
  }

  async recover(): Promise<void> {
    this.receipts?.recoverCanceledLineageMutations();
  }

  candidateFailureDisposition(error: unknown): "reject" | "retry" {
    return error instanceof ConversationRevisionCandidateInvalidError ||
      error instanceof ConversationRevisionConflictError ||
      error instanceof ConversationHandoffTooLargeError ||
      error instanceof ConversationInvalidTargetParticipantError ||
      error instanceof ConversationReceiptCandidateUnavailableError
      ? "reject"
      : "retry";
  }

  async propose(context: ConversationActionProposalContextV1) {
    const candidate = context.request.candidate;
    const result = isConversationRevisionMutation(candidate)
      ? await this.service.proposeConversationAction(
          context.conversation_id,
          context.request,
          context.authority,
        )
      : await this.receipts?.propose({
          conversation_id: context.conversation_id,
          request: context.request,
          authority: context.authority,
        });
    if (!result) throw new ConversationActionTargetUnsupportedError(candidate.type);
    const proposalId = "proposalId" in result ? result.proposalId : result.proposal_id;
    const response = owned(this.actions, context.conversation_id, proposalId);
    if (!response) throw new Error("published conversation action proposal is absent");
    return { created: result.created, response };
  }

  async get(conversationId: string, proposalId: string) {
    return owned(this.actions, conversationId, proposalId);
  }

  async pending(conversationId: string) {
    return this.actions.pending(conversationId);
  }

  async anchored(input: {
    conversation_id: string;
    revision_id: string;
    origin_event_id: string | null;
  }) {
    return this.actions.anchored(input);
  }

  async events(conversationId: string, proposalId: string) {
    return owned(this.actions, conversationId, proposalId) ? this.actions.events(proposalId) : null;
  }

  subscribe(conversationId: string, proposalId: string, listener: () => void) {
    return owned(this.actions, conversationId, proposalId)
      ? this.actions.subscribe(proposalId, listener)
      : null;
  }

  async challenge(context: ProposalMutationContextV1<ActionApprovalChallengeRequestV1>) {
    if (!owned(this.actions, context.conversation_id, context.proposal_id))
      throw new ConversationActionTargetUnsupportedError(null);
    return this.actions.challenge({
      proposal_id: context.proposal_id,
      proposal_digest: context.request.proposal_digest,
      challenge_class: context.request.challenge_class,
      authority: context.authority,
    });
  }

  async approve(context: ProposalMutationContextV1<ActionApprovalRequestV1>) {
    if (!owned(this.actions, context.conversation_id, context.proposal_id))
      throw new ConversationActionTargetUnsupportedError(null);
    const result = this.actions.decide({
      proposal_id: context.proposal_id,
      proposal_digest: context.request.proposal_digest,
      authority: context.authority,
      decision: context.request.decision,
      challenge_id: context.request.challenge_id,
      challenge_response: context.request.challenge_response,
    });
    const approval = result.view.approval;
    if (!approval) throw new Error("action approval projection is absent");
    return { schema_version: "1.0" as const, approval, operation: result.view.operation };
  }

  async commit(context: ProposalMutationContextV1<ActionCommitRequestV1>) {
    const view = owned(this.actions, context.conversation_id, context.proposal_id);
    if (!view) throw new ConversationActionTargetUnsupportedError(null);
    if (
      view.proposal.proposal_digest !== context.request.proposal_digest ||
      view.approval?.approval_id !== context.request.approval_id
    )
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal or approval authority changed.",
        context.proposal_id,
      );
    this.actions.authority.assertMutationController({
      proposal_id: context.proposal_id,
      proposal_digest: context.request.proposal_digest,
      authority: context.authority,
    });
    const snapshot = this.actions.get(context.proposal_id);
    if (!snapshot) throw new Error("approved conversation action authority is absent");
    const action = snapshot.proposal.action;
    const revisionReplay = isConversationRevisionMutation(action);
    if (
      ["succeeded", "failed", "needs_recovery"].includes(view.operation.state) &&
      !(revisionReplay && view.operation.state === "needs_recovery")
    )
      return { schema_version: "1.0" as const, operation: view.operation };
    if (revisionReplay)
      await this.service.commitConversationAction({
        conversationId: context.conversation_id,
        proposalId: context.proposal_id,
        proposalDigest: context.request.proposal_digest,
        approvalId: context.request.approval_id,
        authority: context.authority,
      });
    else if (this.receipts?.supports(action))
      await this.receipts.commit({ proposal_id: context.proposal_id });
    else throw new ConversationActionTargetUnsupportedError(action.type);
    const committed = owned(this.actions, context.conversation_id, context.proposal_id);
    if (!committed) throw new Error("committed conversation action disappeared");
    return { schema_version: "1.0" as const, operation: committed.operation };
  }

  async cancel(context: ProposalMutationContextV1<ActionCancelRequestV1>) {
    if (!owned(this.actions, context.conversation_id, context.proposal_id))
      throw new ConversationActionTargetUnsupportedError(null);
    const view = this.actions.cancel({
      proposal_id: context.proposal_id,
      proposal_digest: context.request.proposal_digest,
      authority: context.authority,
      reason: context.request.reason,
    });
    this.receipts?.releaseCanceledLineageMutation(context.proposal_id);
    return { schema_version: "1.0" as const, operation: view.operation };
  }
}
