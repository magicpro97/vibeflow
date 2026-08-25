import {
  type ActionAuthorityResolverV1,
  ActionAuthorityStore,
  type ActionDispatchRecordV1,
  type ActionOperationEventV1,
  type ActionProposalResponseV1,
  type ActionRequestAuthorityV1,
  type DurableActionAuthorityReaderV1,
  type ExpectedActionSourceV1,
  createDurableActionAuthorityReaderV1,
} from "../../actions/index.js";
import {
  ConversationActionAuthorityResolverV1,
  multiplexActionAuthorityResolvers,
} from "./conversation-action-authority-resolver.js";
import type {
  ContinueMessageActionPlanV1,
  ContinueMessageProposalPlanV1,
} from "./conversation-action-planner.js";
import {
  projectConversationActionSnapshot,
  projectConversationReceiptEvents,
  projectRevisionActionEvents,
} from "./conversation-action-projection.js";
import type {
  ConversationActionReceiptStore,
  ConversationReceiptProposalPlanV1,
} from "./conversation-action-receipt-store.js";
import type { ConversationRevisionStore } from "./revision-store.js";

interface DomainPreparedAuthorityV1 {
  digest: string;
  recorded_at: string;
}

interface DomainTerminalAuthorityV1 extends DomainPreparedAuthorityV1 {
  outcome: "succeeded" | "failed" | "needs_recovery";
}

export interface SharedActionAuthorityFacadeV1 {
  readonly reader: DurableActionAuthorityReaderV1;
  createProposal: ActionAuthorityStore["createProposal"];
  get: ActionAuthorityStore["get"];
  list: ActionAuthorityStore["list"];
  listPending: ActionAuthorityStore["listPending"];
  issueChallenge: ActionAuthorityStore["issueChallenge"];
  decide: ActionAuthorityStore["decide"];
  cancel: ActionAuthorityStore["cancel"];
  prepareDispatch: ActionAuthorityStore["prepareDispatch"];
  getDispatch: ActionAuthorityStore["getDispatch"];
  beginDispatch: ActionAuthorityStore["beginDispatch"];
  beginPreparedDispatch(
    proposalId: string,
    approvalId: string,
    preparedAt: string,
  ): ActionDispatchRecordV1;
  recordTerminal: ActionAuthorityStore["recordTerminal"];
  subscribe(proposalId: string, listener: () => void): (() => void) | null;
}

export interface CapabilityConversationProposalBaseV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  last_seq: number;
  conversation_lock_digest: string;
  lineage_head_digest: string;
  lineage_head_epoch: number;
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
  private readonly listeners = new Map<string, Set<() => void>>();
  private clockOverride: string | null = null;
  readonly authority: SharedActionAuthorityFacadeV1;

  constructor(
    actionRoot: string,
    private readonly now: () => string,
    private readonly revisions: ConversationRevisionStore,
    private readonly receipts: ConversationActionReceiptStore,
    challengeKey?: Uint8Array,
    capabilityResolver?: ActionAuthorityResolverV1,
  ) {
    this.conversationResolver = new ConversationActionAuthorityResolverV1(revisions, receipts);
    this.capabilityResolver = capabilityResolver;
    this.store = new ActionAuthorityStore(actionRoot, {
      ...(challengeKey ? { hmac_key: challengeKey } : {}),
      now: () => Date.parse(this.clockOverride ?? this.now()),
      authority_resolver: multiplexActionAuthorityResolvers(
        this.conversationResolver,
        () => this.capabilityResolver,
      ),
    });
    const authority: SharedActionAuthorityFacadeV1 = {
      reader: createDurableActionAuthorityReaderV1(this.store),
      createProposal: (input) => {
        const result = this.store.createProposal(input);
        this.notify(result.proposal.proposal_id);
        return result;
      },
      get: (proposalId) => this.store.get(proposalId),
      list: () => this.store.list(),
      listPending: () => this.store.listPending(),
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
      prepareDispatch: (proposalId, approvalId) =>
        this.store.prepareDispatch(proposalId, approvalId),
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
        decision: "approved",
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

  private revisionEventsFor(proposalId: string, operationId: string | null) {
    const action = this.receipts.readPlan(proposalId)?.native_plan.action;
    const target =
      action &&
      [
        "conversation.abandon_revision_operation",
        "conversation.retry_revision_operation",
        "conversation.reconcile_revision_operation",
      ].includes(action.type) &&
      "revision_operation_id" in action
        ? action.revision_operation_id
        : operationId;
    return target ? this.revisions.readEvents(target) : [];
  }

  view(proposalId: string): ActionProposalResponseV1 | null {
    const snapshot = this.store.get(proposalId);
    if (!snapshot) return null;
    const events = this.revisionEventsFor(proposalId, snapshot.operation_id);
    return projectConversationActionSnapshot(snapshot, events, this.receipts.read(proposalId));
  }

  events(proposalId: string): ActionOperationEventV1[] | null {
    const snapshot = this.store.get(proposalId);
    if (!snapshot) return null;
    const events = this.revisionEventsFor(proposalId, snapshot.operation_id);
    const receipt = this.receipts.read(proposalId);
    return receipt
      ? projectConversationReceiptEvents(snapshot, receipt)
      : projectRevisionActionEvents(snapshot, events);
  }

  pending(conversationId: string): ActionProposalResponseV1[] {
    return this.store
      .list()
      .filter(
        (snapshot) =>
          (snapshot.state === "pending_review" || snapshot.state === "approved") &&
          snapshot.proposal.domain === "conversation" &&
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
  }): ActionProposalResponseV1[] {
    return this.store
      .list()
      .filter(
        ({ proposal }) =>
          proposal.domain === "conversation" &&
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

  challenge(input: {
    proposal_id: string;
    proposal_digest: string;
    challenge_class: "fresh-user-scope" | "public-literal";
    authority: ActionRequestAuthorityV1;
  }) {
    return this.authority.issueChallenge(input);
  }

  decide(input: {
    proposal_id: string;
    proposal_digest: string;
    authority: ActionRequestAuthorityV1;
    decision: "approved" | "denied";
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
