import {
  type ActionAuthorityResolverV1,
  ActionAuthorityStore,
  type ActionAuthorityStoreOptions,
  type ActionDispatchRecordV1,
  type ActionOperationDomainTerminalState,
  type ActionProposalResponseV1,
  type ActionRequestAuthorityV1,
  type ExpectedActionSourceV1,
  createDurableActionAuthorityReaderV1,
} from "../../actions/index.js";
import {
  ACTION_DECISION,
  type ActionApprovalChallengeClass,
  type ActionDecision,
} from "../../actions/public-action-contract.js";
import {
  ConversationActionAuthorityResolverV1,
  multiplexActionAuthorityResolvers,
} from "./conversation-action-authority-resolver.js";
import type {
  ContinueMessageActionPlanV1,
  ContinueMessageProposalPlanV1,
} from "./conversation-action-planner.js";
import type {
  ConversationActionReceiptStore,
  ConversationReceiptProposalPlanV1,
} from "./conversation-action-receipt-store.js";
import { ConversationActionServiceProjectionV1 } from "./conversation-action-service-projection.js";
import type {
  CapabilityConversationProposalBaseV1,
  SharedActionAuthorityFacadeV1,
} from "./conversation-action-service-types.js";
import type { AgentActionCandidateReviewPhaseV1 } from "./conversation-agent-action-candidate-contract.js";
import { ConversationCapabilityDispatchReservationStoreV1 } from "./conversation-capability-dispatch-reservation.js";
import type { ConversationRevisionStore } from "./revision-store.js";
export type {
  CapabilityConversationProposalBaseV1,
  SharedActionAuthorityFacadeV1,
} from "./conversation-action-service-types.js";

interface DomainPreparedAuthorityV1 {
  digest: string;
  recorded_at: string;
}

interface DomainTerminalAuthorityV1 extends DomainPreparedAuthorityV1 {
  outcome: ActionOperationDomainTerminalState;
}
export class ConversationActionService {
  private readonly store: ActionAuthorityStore;
  private readonly conversationResolver: ConversationActionAuthorityResolverV1;
  private capabilityResolver: ActionAuthorityResolverV1 | undefined;
  private capabilityProposalBaseResolver:
    | ((input: {
        conversation_id: string;
        expected: ExpectedActionSourceV1;
      }) => CapabilityConversationProposalBaseV1)
    | undefined;
  private capabilityActionRootResolver?: (conversationId: string) => { root_session_id: string };
  private agentProposalReviewValidator?: (input: {
    proposal: Parameters<ActionAuthorityResolverV1["review"]>[0]["proposal"];
    now: string;
    phase: AgentActionCandidateReviewPhaseV1;
    approval_id: string | null;
  }) => string;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly projection: ConversationActionServiceProjectionV1;
  private clockOverride: string | null = null;
  readonly authority: SharedActionAuthorityFacadeV1;
  readonly capabilityDispatches: ConversationCapabilityDispatchReservationStoreV1;

  constructor(
    actionRoot: string,
    private readonly now: () => string,
    private readonly revisions: ConversationRevisionStore,
    private readonly receipts: ConversationActionReceiptStore,
    challengeKey?: Uint8Array,
    capabilityResolver?: ActionAuthorityResolverV1,
    fault?: ActionAuthorityStoreOptions["fault"],
  ) {
    this.conversationResolver = new ConversationActionAuthorityResolverV1(revisions, receipts);
    this.capabilityDispatches = new ConversationCapabilityDispatchReservationStoreV1(actionRoot);
    this.capabilityResolver = capabilityResolver;
    this.store = new ActionAuthorityStore(actionRoot, {
      ...(challengeKey ? { hmac_key: challengeKey } : {}),
      ...(fault ? { fault } : {}),
      now: () => Date.parse(this.clockOverride ?? this.now()),
      authority_resolver: multiplexActionAuthorityResolvers(
        this.conversationResolver,
        () => this.capabilityResolver,
        () => this.agentProposalReviewValidator,
      ),
    });
    this.projection = new ConversationActionServiceProjectionV1(this.store, revisions, receipts);
    const authority: SharedActionAuthorityFacadeV1 = {
      reader: createDurableActionAuthorityReaderV1(this.store),
      createProposal: (input) => {
        const result = this.store.createProposal(input);
        this.notify(result.proposal.proposal_id);
        return result;
      },
      preparedProposal: (input) => this.store.preparedProposal(input),
      get: (proposalId) => this.store.get(proposalId),
      list: () => this.store.list(),
      listRecorded: () => this.store.listRecorded(),
      listPending: () => this.store.listPending(),
      assertMutationController: (input) => this.store.assertMutationController(input),
      issueChallenge: (input) => this.store.issueChallenge(input),
      decide: (input) => {
        const result = this.store.decide(input);
        this.notify(input.proposal_id);
        return result;
      },
      cancel: (input) => {
        const result = this.store.cancel(input);
        this.notify(input.proposal_id);
        return result;
      },
      prevalidateDispatch: (proposalId, approvalId) =>
        this.store.prevalidateDispatch(proposalId, approvalId),
      prepareDispatch: (proposalId, approvalId) =>
        this.store.prepareDispatch(proposalId, approvalId),
      reserveDispatch: (proposalId, approvalId) =>
        this.store.reserveDispatch(proposalId, approvalId),
      getDispatch: (operationId) => this.store.getDispatch(operationId),
      beginDispatch: (proposalId, approvalId) => {
        const result = this.store.beginDispatch(proposalId, approvalId);
        this.notify(proposalId);
        return result;
      },
      beginPreparedDispatch: (proposalId, approvalId, preparedAt) => {
        this.clockOverride = preparedAt;
        try {
          const dispatch = this.store.prepareDispatch(proposalId, approvalId);
          this.store.beginDispatch(proposalId, approvalId);
          this.notify(proposalId);
          return dispatch;
        } finally {
          this.clockOverride = null;
        }
      },
      prepareDomainDispatch: (proposalId, approvalId, preparedAt) => {
        this.clockOverride = preparedAt;
        try {
          return this.store.prepareDispatch(proposalId, approvalId);
        } finally {
          this.clockOverride = null;
        }
      },
      recordTerminal: (proposalId) => {
        const result = this.store.recordTerminal(proposalId);
        this.notify(proposalId);
        return result;
      },
      subscribe: (proposalId, listener) => this.subscribe(proposalId, listener),
    };
    this.authority = Object.freeze(authority);
    revisions.subscribe((operationId) => {
      const proposal = this.store.list().find((row) => row.operation_id === operationId);
      if (proposal) this.notify(proposal.proposal.proposal_id);
    });
  }

  registerCapabilityAuthorityResolver(resolver: ActionAuthorityResolverV1): void {
    if (this.capabilityResolver && this.capabilityResolver !== resolver)
      throw new Error("capability action authority resolver conflict");
    this.capabilityResolver = resolver;
  }

  registerAgentProposalReviewValidator(
    validator: (input: {
      proposal: Parameters<ActionAuthorityResolverV1["review"]>[0]["proposal"];
      now: string;
      phase: AgentActionCandidateReviewPhaseV1;
      approval_id: string | null;
    }) => string,
  ): void {
    if (this.agentProposalReviewValidator && this.agentProposalReviewValidator !== validator)
      throw new Error("agent proposal review validator conflict");
    this.agentProposalReviewValidator = validator;
  }

  registerCapabilityProposalBaseResolver(
    resolver: (input: {
      conversation_id: string;
      expected: ExpectedActionSourceV1;
    }) => CapabilityConversationProposalBaseV1,
  ): void {
    if (this.capabilityProposalBaseResolver && this.capabilityProposalBaseResolver !== resolver)
      throw new Error("capability proposal base resolver conflict");
    this.capabilityProposalBaseResolver = resolver;
  }

  resolveCapabilityProposalBase(input: {
    conversation_id: string;
    expected: ExpectedActionSourceV1;
  }): CapabilityConversationProposalBaseV1 {
    if (!this.capabilityProposalBaseResolver)
      throw new Error("capability proposal base resolver is absent");
    return structuredClone(this.capabilityProposalBaseResolver(structuredClone(input)));
  }

  registerCapabilityActionRootResolver(
    resolver: (conversationId: string) => { root_session_id: string },
  ): void {
    if (this.capabilityActionRootResolver && this.capabilityActionRootResolver !== resolver)
      throw new Error("capability action root resolver conflict");
    this.capabilityActionRootResolver = resolver;
  }

  resolveCapabilityActionRoot(conversationId: string): { root_session_id: string } {
    if (!this.capabilityActionRootResolver)
      throw new Error("capability action root resolver is absent");
    return structuredClone(this.capabilityActionRootResolver(conversationId));
  }

  private notify(proposalId: string): void {
    for (const listener of [...(this.listeners.get(proposalId) ?? [])]) {
      try {
        listener();
      } catch {
        // A browser subscriber cannot affect durable action authority.
      }
    }
  }

  subscribe(proposalId: string, listener: () => void): (() => void) | null {
    if (!this.store.get(proposalId)) return null;
    let listeners = this.listeners.get(proposalId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(proposalId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(proposalId);
    };
  }

  proposal(plan: ContinueMessageActionPlanV1, authority: ActionRequestAuthorityV1) {
    const created = this.create(plan, authority);
    const current = this.store.get(created.proposal.proposal_id);
    if (!current) throw new Error("durable conversation action proposal is absent");
    if (current.approval) return { proposal: created.proposal, approval: current.approval };
    this.clockOverride = plan.approval.decided_at;
    try {
      const approval = this.store.decide({
        proposal_id: created.proposal.proposal_id,
        proposal_digest: created.proposal.proposal_digest,
        authority,
        decision: ACTION_DECISION.APPROVED,
        challenge_id: null,
        challenge_response: null,
      });
      return { proposal: created.proposal, approval };
    } finally {
      this.clockOverride = null;
    }
  }

  create(
    plan: ContinueMessageProposalPlanV1 | ConversationReceiptProposalPlanV1,
    authority: ActionRequestAuthorityV1,
  ) {
    this.clockOverride = plan.proposal.created_at;
    try {
      return this.authority.createProposal({
        authority,
        canonical_request: plan.canonical_request,
        proposal: plan.proposal,
      });
    } finally {
      this.clockOverride = null;
    }
  }

  bindHeader(proposalId: string, headerDigest: string): void {
    this.conversationResolver.bindHeader(proposalId, headerDigest);
  }

  dispatch(
    proposalId: string,
    approvalId: string,
    prepared: DomainPreparedAuthorityV1,
  ): ActionDispatchRecordV1 {
    this.clockOverride = prepared.recorded_at;
    try {
      const dispatch = this.authority.prepareDispatch(proposalId, approvalId);
      this.conversationResolver.bindPrepared(dispatch.operation_id, prepared);
      this.authority.beginDispatch(proposalId, approvalId);
      return dispatch;
    } finally {
      this.clockOverride = null;
    }
  }

  terminal(proposalId: string, operationId: string, terminal: DomainTerminalAuthorityV1): void {
    this.conversationResolver.bindTerminal(operationId, terminal);
    this.clockOverride = terminal.recorded_at;
    try {
      this.authority.recordTerminal(proposalId);
    } finally {
      this.clockOverride = null;
    }
  }

  get(proposalId: string) {
    return this.authority.get(proposalId);
  }

  view(proposalId: string): ActionProposalResponseV1 | null {
    return this.projection.view(proposalId);
  }

  events(proposalId: string) {
    return this.projection.events(proposalId);
  }

  pending(conversationId: string): ActionProposalResponseV1[] {
    return this.projection.pending(conversationId);
  }
  anchored(input: {
    conversation_id: string;
    revision_id: string;
    origin_event_id: string | null;
  }): ActionProposalResponseV1[] {
    return this.projection.anchored(input);
  }

  challenge(input: {
    proposal_id: string;
    proposal_digest: string;
    challenge_class: ActionApprovalChallengeClass;
    authority: ActionRequestAuthorityV1;
  }) {
    return this.authority.issueChallenge(input);
  }
  decide(input: {
    proposal_id: string;
    proposal_digest: string;
    authority: ActionRequestAuthorityV1;
    decision: ActionDecision;
    challenge_id: string | null;
    challenge_response: string | null;
  }) {
    const approval = this.authority.decide(input);
    const view = this.view(input.proposal_id);
    if (!view) throw new Error("approved conversation action disappeared");
    return { approval, view };
  }

  cancel(input: {
    proposal_id: string;
    proposal_digest: string;
    authority: ActionRequestAuthorityV1;
    reason: string | null;
  }): ActionProposalResponseV1 {
    this.authority.cancel(input);
    const view = this.view(input.proposal_id);
    if (!view) throw new Error("canceled conversation action disappeared");
    return view;
  }
}
