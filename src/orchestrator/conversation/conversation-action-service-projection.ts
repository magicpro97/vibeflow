import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  type ActionAuthorityStore,
  isActionOperationProposalOpenState,
} from "../../actions/index.js";
import { ACTION_DOMAIN } from "../../actions/public-action-contract.js";
import {
  projectConversationActionSnapshot,
  projectConversationReceiptEvents,
  projectRevisionActionEvents,
} from "./conversation-action-projection.js";
import type { ConversationActionReceiptStore } from "./conversation-action-receipt-store.js";
import type { ConversationRevisionStore } from "./revision-store.js";

/** Read-only public projection over the shared durable Action authority. */
export class ConversationActionServiceProjectionV1 {
  constructor(
    private readonly store: ActionAuthorityStore,
    private readonly revisions: ConversationRevisionStore,
    private readonly receipts: ConversationActionReceiptStore,
  ) {}

  private revisionEventsFor(proposalId: string, operationId: string | null) {
    const action = this.receipts.readPlan(proposalId)?.native_plan.action;
    const target =
      action &&
      [
        HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION,
        HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION,
        HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION,
      ].some((candidate) => candidate === action.type) &&
      "revision_operation_id" in action
        ? action.revision_operation_id
        : operationId;
    return target ? this.revisions.readEvents(target) : [];
  }

  view(proposalId: string) {
    const snapshot = this.store.get(proposalId);
    if (!snapshot) return null;
    const events = this.revisionEventsFor(proposalId, snapshot.operation_id);
    return projectConversationActionSnapshot(snapshot, events, this.receipts.read(proposalId));
  }

  events(proposalId: string) {
    const snapshot = this.store.get(proposalId);
    if (!snapshot) return null;
    const events = this.revisionEventsFor(proposalId, snapshot.operation_id);
    const receipt = this.receipts.read(proposalId);
    return receipt
      ? projectConversationReceiptEvents(snapshot, receipt)
      : projectRevisionActionEvents(snapshot, events);
  }

  pending(conversationId: string) {
    return this.store
      .list()
      .filter(
        (snapshot) =>
          isActionOperationProposalOpenState(snapshot.state) &&
          snapshot.proposal.domain === ACTION_DOMAIN.CONVERSATION &&
          snapshot.proposal.base.conversation_id === conversationId,
      )
      .map((snapshot) =>
        projectConversationActionSnapshot(
          snapshot,
          this.revisionEventsFor(snapshot.proposal.proposal_id, snapshot.operation_id),
          this.receipts.read(snapshot.proposal.proposal_id),
        ),
      );
  }

  anchored(input: {
    conversation_id: string;
    revision_id: string;
    origin_event_id: string | null;
  }) {
    return this.store
      .list()
      .filter(
        ({ proposal }) =>
          proposal.domain === ACTION_DOMAIN.CONVERSATION &&
          proposal.base.conversation_id === input.conversation_id &&
          proposal.base.revision_id === input.revision_id &&
          proposal.origin_event_id === input.origin_event_id,
      )
      .map((snapshot) =>
        projectConversationActionSnapshot(
          snapshot,
          this.revisionEventsFor(snapshot.proposal.proposal_id, snapshot.operation_id),
          this.receipts.read(snapshot.proposal.proposal_id),
        ),
      );
  }
}
