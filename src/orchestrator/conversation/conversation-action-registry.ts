import type {
  ActionApprovalChallengeRequestV1,
  ActionApprovalRequestV1,
  ActionCancelRequestV1,
  ActionCommitRequestV1,
  ActionProposalRequestV1,
  ActionRequestAuthorityV1,
  BrowserHostActionRequestV1,
} from "../../actions/index.js";
import {
  type ConversationActionDomainPlannerExecutorV1,
  ConversationActionTargetUnsupportedError,
} from "./conversation-action-domain.js";

function actionDomain(
  candidate: BrowserHostActionRequestV1,
): ConversationActionDomainPlannerExecutorV1["domain"] {
  return candidate.type.startsWith("conversation.") || candidate.type === "context.compact"
    ? "conversation"
    : "capability";
}

export class ConversationActionDomainRegistryV1 {
  private readonly handlers: readonly ConversationActionDomainPlannerExecutorV1[];

  constructor(handlers: readonly ConversationActionDomainPlannerExecutorV1[]) {
    this.handlers = [...handlers];
  }

  private forCandidate(candidate: BrowserHostActionRequestV1) {
    const domain = actionDomain(candidate);
    const handlers = this.handlers.filter(
      (candidateHandler) =>
        candidateHandler.domain === domain && candidateHandler.supports(candidate),
    );
    if (handlers.length === 0) throw new ConversationActionTargetUnsupportedError(candidate.type);
    if (handlers.length !== 1) throw new Error("overlapping conversation action domain handlers");
    return handlers[0] as ConversationActionDomainPlannerExecutorV1;
  }

  private async owner(conversationId: string, proposalId: string) {
    let owner: ConversationActionDomainPlannerExecutorV1 | null = null;
    for (const handler of this.handlers) {
      if (!(await handler.get(conversationId, proposalId))) continue;
      if (owner) throw new Error("duplicate conversation action proposal owner");
      owner = handler;
    }
    if (!owner) throw new ConversationActionTargetUnsupportedError(null);
    return owner;
  }

  propose(input: {
    conversation_id: string;
    request: ActionProposalRequestV1;
    authority: ActionRequestAuthorityV1;
  }) {
    return this.forCandidate(input.request.candidate).propose(input);
  }

  async get(conversationId: string, proposalId: string) {
    for (const handler of this.handlers) {
      const result = await handler.get(conversationId, proposalId);
      if (result) return result;
    }
    return null;
  }

  async pending(conversationId: string) {
    const rows = (
      await Promise.all(this.handlers.map((handler) => handler.pending(conversationId)))
    )
      .flat()
      .sort(
        (left, right) =>
          right.proposal.created_at.localeCompare(left.proposal.created_at) ||
          right.proposal.proposal_id.localeCompare(left.proposal.proposal_id),
      );
    for (let index = 1; index < rows.length; index += 1)
      if (rows[index - 1]?.proposal.proposal_id === rows[index]?.proposal.proposal_id)
        throw new Error("duplicate cross-domain action proposal");
    return rows;
  }

  async anchored(input: {
    conversation_id: string;
    revision_id: string;
    origin_event_id: string | null;
  }) {
    return (await Promise.all(this.handlers.map((handler) => handler.anchored(input))))
      .flat()
      .sort(
        (left, right) =>
          right.proposal.created_at.localeCompare(left.proposal.created_at) ||
          right.proposal.proposal_id.localeCompare(left.proposal.proposal_id),
      );
  }

  async events(conversationId: string, proposalId: string) {
    return (await this.owner(conversationId, proposalId)).events(conversationId, proposalId);
  }

  async subscribe(conversationId: string, proposalId: string, listener: () => void) {
    const handler = await this.owner(conversationId, proposalId);
    return handler.subscribe?.(conversationId, proposalId, listener) ?? null;
  }

  async challenge(input: {
    conversation_id: string;
    proposal_id: string;
    request: ActionApprovalChallengeRequestV1;
    authority: ActionRequestAuthorityV1;
  }) {
    return (await this.owner(input.conversation_id, input.proposal_id)).challenge(input);
  }

  async approve(input: {
    conversation_id: string;
    proposal_id: string;
    request: ActionApprovalRequestV1;
    authority: ActionRequestAuthorityV1;
  }) {
    return (await this.owner(input.conversation_id, input.proposal_id)).approve(input);
  }

  async commit(input: {
    conversation_id: string;
    proposal_id: string;
    request: ActionCommitRequestV1;
    authority: ActionRequestAuthorityV1;
  }) {
    return (await this.owner(input.conversation_id, input.proposal_id)).commit(input);
  }

  async cancel(input: {
    conversation_id: string;
    proposal_id: string;
    request: ActionCancelRequestV1;
    authority: ActionRequestAuthorityV1;
  }) {
    return (await this.owner(input.conversation_id, input.proposal_id)).cancel(input);
  }
}
