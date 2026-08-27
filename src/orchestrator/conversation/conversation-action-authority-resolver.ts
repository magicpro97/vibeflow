import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  type ActionAuthorityResolverV1,
  ActionAuthorityStaleError,
  type ActionOperationDomainTerminalState,
  deriveOperationId,
  materializeDispatchPreparationProof,
  materializeDomainPreparedProof,
  materializeDomainTerminalProof,
  materializeProposalPublicationProof,
  materializeReviewAuthorityProof,
} from "../../actions/index.js";
import {
  ACTION_DOMAIN,
  ACTOR_KIND,
  type ActionDomain,
} from "../../actions/public-action-contract.js";
import { isAgentProposalBrowserController } from "../../actions/store-rules.js";
import { digestV1 } from "../../durability/index.js";
import { conversationActionAuthorityHead } from "./conversation-action-planner.js";
import type { ConversationActionReceiptStore } from "./conversation-action-receipt-store.js";
import {
  AGENT_ACTION_CANDIDATE_REVIEW_PHASE,
  type AgentActionCandidateReviewPhaseV1,
} from "./conversation-agent-action-candidate-contract.js";
import type { ConversationRevisionStore } from "./revision-store.js";

interface PreparedAuthorityV1 {
  digest: string;
  recorded_at: string;
}

interface TerminalAuthorityV1 extends PreparedAuthorityV1 {
  outcome: ActionOperationDomainTerminalState;
}

export class ConversationActionAuthorityResolverV1 implements ActionAuthorityResolverV1 {
  private readonly headers = new Map<string, string>();
  private readonly prepared = new Map<string, PreparedAuthorityV1>();
  private readonly terminals = new Map<string, TerminalAuthorityV1>();

  constructor(
    private readonly revisions: ConversationRevisionStore,
    private readonly receipts: ConversationActionReceiptStore,
  ) {}

  bindHeader(proposalId: string, headerDigest: string): void {
    const existing = this.headers.get(proposalId);
    if (existing && existing !== headerDigest) throw new Error("action domain header conflict");
    this.headers.set(proposalId, headerDigest);
  }

  bindPrepared(operationId: string, prepared: PreparedAuthorityV1): void {
    this.prepared.set(operationId, structuredClone(prepared));
  }

  bindTerminal(operationId: string, terminal: TerminalAuthorityV1): void {
    this.terminals.set(operationId, structuredClone(terminal));
  }

  private controlTarget(proposalId: string): string | null {
    const action = this.receipts.readPlan(proposalId)?.native_plan.action;
    return action &&
      [
        HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION,
        HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION,
        HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION,
      ].some((candidate) => candidate === action.type) &&
      "revision_operation_id" in action
      ? action.revision_operation_id
      : null;
  }

  private controlTerminal(proposalId: string, actionOperationId: string) {
    const target = this.controlTarget(proposalId);
    if (!target) return null;
    for (const event of this.revisions.readEvents(target)) {
      if (!("action_terminals" in event.payload)) continue;
      const terminal = event.payload.action_terminals.find(
        (row) => row.action_operation_id === actionOperationId,
      );
      if (terminal)
        return {
          outcome: terminal.outcome,
          digest: event.event_digest,
          recorded_at: event.recorded_at,
        };
    }
    return null;
  }

  private revisionTerminal(proposalId: string, actionOperationId: string) {
    const direct = this.revisions.readOperation(actionOperationId);
    const published = this.revisions
      .publishedTransitions()
      .find(
        (input) =>
          (input.authority as { proposal?: { proposal_id?: string } }).proposal?.proposal_id ===
          proposalId,
      );
    const authority = published?.authority as { operation?: { operation_id?: string } } | undefined;
    const target =
      direct?.proposal_id === proposalId && direct.operation_id === actionOperationId
        ? direct.operation_id
        : authority?.operation?.operation_id;
    if (!target) return null;
    for (const event of this.revisions.readEvents(target)) {
      if (!("action_terminals" in event.payload)) continue;
      const terminal = event.payload.action_terminals.find(
        (row) => row.action_operation_id === actionOperationId,
      );
      if (terminal)
        return {
          outcome: terminal.outcome,
          digest: event.event_digest,
          recorded_at: event.recorded_at,
        };
    }
    return null;
  }

  validateProposalPublication: ActionAuthorityResolverV1["validateProposalPublication"] = ({
    proposal,
    canonical_request_digest,
    now,
  }) =>
    materializeProposalPublicationProof(
      proposal,
      canonical_request_digest,
      digestV1("VF-CONVERSATION-ACTION-PUBLICATION-CLOSURE\0v1\0", {
        schema_version: "1.0",
        proposal_id: proposal.proposal_id,
        plan_digest: proposal.plan_digest,
        conversation_lock_digest: proposal.base.conversation_lock_digest,
        lineage_head_digest: proposal.base.lineage_head_digest,
      }),
      now,
    );

  review: ActionAuthorityResolverV1["review"] = ({ proposal, authority, now }) => {
    const root = proposal.base.root_session_id;
    if (!root) throw new Error("conversation action root is absent");
    if (proposal.requested_by.kind === ACTOR_KIND.AGENT) {
      if (!isAgentProposalBrowserController(proposal, authority))
        throw new ActionAuthorityStaleError(now, "controller-changed");
    } else {
      const current = conversationActionAuthorityHead({ root_session_id: root, authority });
      if (
        current.authority_epoch !== proposal.base.authority_epoch ||
        current.authority_head_digest !== proposal.base.authority_head_digest
      )
        throw new ActionAuthorityStaleError(now, "authority-changed");
    }
    return materializeReviewAuthorityProof(
      proposal,
      authority,
      now,
      new Date(
        Math.min(Date.parse(proposal.expires_at), Date.parse(now) + 30 * 60_000),
      ).toISOString(),
    );
  };

  prepareDispatch: ActionAuthorityResolverV1["prepareDispatch"] = ({ proposal, approval, now }) => {
    const operationId = deriveOperationId(proposal, approval.approval_id);
    const receiptPlan = this.receipts.readPlan(proposal.proposal_id);
    const header =
      this.headers.get(proposal.proposal_id) ??
      this.revisions.readOperation(operationId)?.header_digest;
    const control = this.controlTarget(proposal.proposal_id) !== null;
    if ((!header && !receiptPlan) || (control && !header))
      throw new Error("conversation operation preparation is absent");
    return materializeDispatchPreparationProof(
      proposal,
      approval,
      receiptPlan && !control ? null : (header as string),
      now,
    );
  };

  proveDomainPrepared: ActionAuthorityResolverV1["proveDomainPrepared"] = ({
    proposal,
    dispatch,
  }) => {
    const receiptPlan = this.receipts.readPlan(proposal.proposal_id);
    const first = this.revisions.readEvents(dispatch.operation_id)[0];
    const prepared =
      this.prepared.get(dispatch.operation_id) ??
      (receiptPlan
        ? { digest: receiptPlan.record_digest, recorded_at: dispatch.created_at }
        : undefined) ??
      (first ? { digest: first.event_digest, recorded_at: first.recorded_at } : undefined);
    if (!prepared) throw new Error("revision operation sequence zero is absent");
    return materializeDomainPreparedProof(dispatch, prepared.digest, prepared.recorded_at);
  };

  resolveTerminal: ActionAuthorityResolverV1["resolveTerminal"] = ({ proposal, dispatch }) => {
    const receipt = this.receipts.read(proposal.proposal_id);
    const terminal =
      this.terminals.get(dispatch.operation_id) ??
      this.controlTerminal(proposal.proposal_id, dispatch.operation_id) ??
      this.revisionTerminal(proposal.proposal_id, dispatch.operation_id) ??
      (receipt
        ? {
            outcome: receipt.outcome,
            digest: receipt.receipt_digest,
            recorded_at: receipt.recorded_at,
          }
        : undefined);
    if (!terminal) throw new Error("revision operation terminal is absent");
    return materializeDomainTerminalProof(
      dispatch,
      terminal.outcome,
      terminal.digest,
      terminal.recorded_at,
    );
  };

  validateRecordedTerminal: ActionAuthorityResolverV1["validateRecordedTerminal"] = ({
    proposal,
    dispatch,
    outcome,
    domain_terminal_digest,
    recorded_at,
  }) => {
    const receipt = this.receipts.read(proposal.proposal_id);
    const control = this.controlTerminal(proposal.proposal_id, dispatch.operation_id);
    const revision = this.revisionTerminal(proposal.proposal_id, dispatch.operation_id);
    const expected = receipt
      ? {
          outcome: receipt.outcome,
          digest: receipt.receipt_digest,
          recorded_at: receipt.recorded_at,
        }
      : (control ?? revision);
    if (
      !expected ||
      expected.outcome !== outcome ||
      expected.digest !== domain_terminal_digest ||
      expected.recorded_at !== recorded_at
    )
      throw new Error("recorded conversation terminal authority changed");
    return materializeDomainTerminalProof(dispatch, outcome, domain_terminal_digest, recorded_at);
  };
}

export function multiplexActionAuthorityResolvers(
  conversation: ActionAuthorityResolverV1,
  capability: () => ActionAuthorityResolverV1 | undefined,
  agentReview: () =>
    | ((input: {
        proposal: Parameters<ActionAuthorityResolverV1["review"]>[0]["proposal"];
        now: string;
        phase: AgentActionCandidateReviewPhaseV1;
        approval_id: string | null;
      }) => string)
    | undefined,
): ActionAuthorityResolverV1 {
  const selected = (domain: ActionDomain) => {
    if (domain === ACTION_DOMAIN.CONVERSATION) return conversation;
    const resolver = capability();
    if (!resolver) throw new Error("capability action authority resolver is unavailable");
    return resolver;
  };
  const validateAgentSource = (input: {
    proposal: Parameters<ActionAuthorityResolverV1["review"]>[0]["proposal"];
    now: string;
    phase: AgentActionCandidateReviewPhaseV1;
    approval_id: string | null;
  }): string | null => {
    if (input.proposal.requested_by.kind !== ACTOR_KIND.AGENT) return null;
    const validate = agentReview();
    if (!validate) throw new Error("agent proposal review source validator is absent");
    return validate(input);
  };
  return {
    validateProposalPublication: (input) =>
      selected(input.proposal.domain).validateProposalPublication(input),
    review: (input) => {
      validateAgentSource({
        ...input,
        phase: AGENT_ACTION_CANDIDATE_REVIEW_PHASE.REVIEW,
        approval_id: null,
      });
      return selected(input.proposal.domain).review(input);
    },
    prevalidateDispatch: (input) => {
      validateAgentSource({
        ...input,
        phase: AGENT_ACTION_CANDIDATE_REVIEW_PHASE.DISPATCH,
        approval_id: input.approval.approval_id,
      });
      selected(input.proposal.domain).prevalidateDispatch?.(input);
    },
    prepareDispatch: (input) => {
      validateAgentSource({
        ...input,
        phase: AGENT_ACTION_CANDIDATE_REVIEW_PHASE.DISPATCH,
        approval_id: input.approval.approval_id,
      });
      return selected(input.proposal.domain).prepareDispatch(input);
    },
    reserveDispatch: (input) => {
      const producerAuthorityDigest = validateAgentSource({
        ...input,
        phase: AGENT_ACTION_CANDIDATE_REVIEW_PHASE.DISPATCH,
        approval_id: input.approval.approval_id,
      });
      const reserve = selected(input.proposal.domain).reserveDispatch;
      if (!reserve) throw new Error("selected action domain has no dispatch reservation authority");
      reserve({ ...input, producer_authority_digest: producerAuthorityDigest });
    },
    assertDispatchReserved: (input) =>
      selected(input.proposal.domain).assertDispatchReserved?.(input),
    proveDomainPrepared: (input) => selected(input.proposal.domain).proveDomainPrepared(input),
    resolveTerminal: (input) => selected(input.proposal.domain).resolveTerminal(input),
    validateRecordedTerminal: (input) =>
      selected(input.proposal.domain).validateRecordedTerminal(input),
  };
}
