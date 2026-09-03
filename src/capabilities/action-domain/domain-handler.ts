import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  ACTION_ROOT_LOCATOR_KIND,
  type ActionApprovalChallengeRequestV1,
  type ActionApprovalRequestV1,
  type ActionCancelRequestV1,
  type ActionCommitRequestV1,
  ActionConflictError,
  type ActionProposalResponseV1,
  type BrowserHostActionRequestV1,
  isActionOperationDispatchBeginState,
  isActionOperationDomainTerminalState,
  isActionOperationProposalOpenState,
  projectActionSnapshot,
} from "../../actions/index.js";
import {
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
} from "../../actions/public-action-contract.js";
import {
  CAPABILITY_PLAN_STATUS,
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityRuntimeErrorCodeV1,
  type CapabilityScope,
} from "../../core/capability-contract.js";
import type {
  ConversationActionDomainPlannerExecutorV1,
  ConversationActionProposalContextV1,
} from "../../orchestrator/conversation/conversation-action-domain.js";
import { ConversationActionTargetUnsupportedError } from "../../orchestrator/conversation/conversation-action-domain.js";
import type { ConversationActionService } from "../../orchestrator/conversation/conversation-action-service.js";
import type { LegacyAdoptInspectionRequestV1 } from "../legacy/types.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import type { CapabilityHostActionV1 } from "../planning/types.js";
import type { CapabilityRuntimeFactoryV1 } from "../runtime-factory.js";
import { CapabilityActionAuthorityResolverV1 } from "./authority-resolver.js";
import {
  type CapabilityConversationActionDomainOptionsV1,
  CapabilityConversationDispatchRuntimeV1,
} from "./conversation-dispatch-runtime.js";
import {
  assertConversationCapabilityTargets,
  isCapabilityAction,
  materializeConversationCapabilityAction,
} from "./conversation-target-authority.js";
import type { CapabilityActionObjectStoreV1 } from "./object-store.js";
import { projectCapabilityActionEvents, projectCapabilityActionSnapshot } from "./projection.js";
import { materializeCapabilityConversationProposal } from "./proposal.js";

type MutationContextV1<T> = {
  conversation_id: string;
  proposal_id: string;
  request: T;
  authority: import("../../actions/index.js").ActionRequestAuthorityV1;
};

export type { CapabilityConversationActionDomainOptionsV1 } from "./conversation-dispatch-runtime.js";

/** Browser/conversation capability domain over the same durable ActionAuthorityStore. */
export class CapabilityConversationActionDomainV1
  implements ConversationActionDomainPlannerExecutorV1
{
  readonly domain = "capability" as const;
  readonly objects: CapabilityActionObjectStoreV1;
  readonly resolver: CapabilityActionAuthorityResolverV1;
  private readonly dispatchRuntime: CapabilityConversationDispatchRuntimeV1;

  constructor(
    readonly runtime: CapabilityRuntimeFactoryV1,
    readonly actions: ConversationActionService,
    options: CapabilityConversationActionDomainOptionsV1 = {},
  ) {
    this.objects = runtime.actionObjects;
    this.resolver = new CapabilityActionAuthorityResolverV1(
      this.objects,
      (scope) => runtime.service(scope),
      actions,
    );
    actions.registerCapabilityAuthorityResolver(this.resolver);
    this.dispatchRuntime = new CapabilityConversationDispatchRuntimeV1(runtime, actions, options);
  }

  recover(): Promise<void> {
    return this.dispatchRuntime.recover();
  }

  supports(candidate: BrowserHostActionRequestV1): boolean {
    return isCapabilityAction(candidate);
  }

  candidateFailureDisposition(error: unknown): "reject" | "retry" {
    const deterministic: ReadonlySet<CapabilityRuntimeErrorCodeV1> = new Set([
      CAPABILITY_RUNTIME_ERROR_CODE.ACTION_REQUIRED,
      CAPABILITY_RUNTIME_ERROR_CODE.PACKAGE_NOT_FOUND,
      CAPABILITY_RUNTIME_ERROR_CODE.AMBIGUOUS_PACKAGE,
      CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN,
      CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_BASE_STALE,
    ]);
    return error instanceof CapabilityRuntimeError && deterministic.has(error.runtime_code)
      ? "reject"
      : "retry";
  }

  inspectAdoptCandidates(input: {
    conversation_id: string;
    request: LegacyAdoptInspectionRequestV1;
    authority: import("../../actions/index.js").ActionRequestAuthorityV1;
  }) {
    const selected = this.actions.resolveCapabilityActionRoot(input.conversation_id);
    const locator = {
      kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
      root_session_id: selected.root_session_id,
    };
    this.runtime.bindActionAuthority(locator, this.actions.authority.reader);
    return this.runtime.service(input.request.scope).adoptInspect(input.request, {
      principal_digest: input.authority.principal_digest,
      action_root_locator: locator,
    });
  }

  async propose(context: ConversationActionProposalContextV1) {
    const conversation = this.actions.resolveCapabilityProposalBase({
      conversation_id: context.conversation_id,
      expected: context.request.expected,
    });
    const locator = {
      kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
      root_session_id: conversation.root_session_id,
    };
    this.runtime.bindActionAuthority(locator, this.actions.authority.reader);
    const candidate = context.request.candidate;
    if (!isCapabilityAction(candidate))
      throw new ConversationActionTargetUnsupportedError(candidate.type);
    const service = this.runtime.service(candidate.scope);
    const action: CapabilityHostActionV1 =
      candidate.type === HOST_ACTION_KIND.CAPABILITY_ADOPT
        ? {
            type: HOST_ACTION_KIND.CAPABILITY_ADOPT,
            scope: candidate.scope,
            candidate: service.resolveAdoptCandidate(candidate, {
              scope: candidate.scope,
              action_root_locator: locator,
            }),
          }
        : materializeConversationCapabilityAction(candidate, conversation);
    const graph = service.prepareIntentGraph({
      schema_version: "1.0",
      action,
      planning_options: {
        mode: ACTION_PLANNING_MODE.DURABLE,
        network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
      },
      action_root_locator: locator,
      request_authority: context.authority,
    });
    const { plan } = graph;
    if (plan.status !== CAPABILITY_PLAN_STATUS.PLANNED)
      throw new CapabilityRuntimeError(
        plan.status === CAPABILITY_PLAN_STATUS.NO_OP
          ? "capability intent is already satisfied"
          : "capability intent requires user or external action",
        CAPABILITY_RUNTIME_ERROR_CODE.ACTION_REQUIRED,
      );
    const status = service.options.storage.readStatus();
    if ((status.lock?.content_digest ?? null) !== plan.base_lock_digest)
      throw new CapabilityRuntimeError(
        "capability base changed during proposal",
        CAPABILITY_RUNTIME_ERROR_CODE.SCOPE_BASE_STALE,
      );
    const currentConversation = this.actions.resolveCapabilityProposalBase({
      conversation_id: context.conversation_id,
      expected: context.request.expected,
    });
    assertConversationCapabilityTargets(action, currentConversation);
    const materialized = materializeCapabilityConversationProposal({
      request: context.request,
      authority: context.authority,
      conversation: currentConversation,
      action,
      graph,
      base_lock: status.lock,
    });
    this.objects.persistGraph(graph);
    const created = this.actions.authority.createProposal({
      authority: context.authority,
      canonical_request: materialized.canonical_request,
      proposal: materialized.proposal,
    });
    const response = this.view(context.conversation_id, created.proposal.proposal_id);
    if (!response) throw new Error("published capability proposal is absent");
    return { created: created.created, response };
  }

  async get(conversationId: string, proposalId: string) {
    return this.ownedView(conversationId, proposalId);
  }

  async pending(conversationId: string) {
    return this.actions.authority
      .list()
      .filter(
        (row) => isActionOperationProposalOpenState(row.state) && this.owned(row, conversationId),
      )
      .map((row) => this.project(row));
  }

  async anchored(input: {
    conversation_id: string;
    revision_id: string;
    origin_event_id: string | null;
  }) {
    return this.actions.authority
      .list()
      .filter(
        (row) =>
          this.owned(row, input.conversation_id) &&
          row.proposal.base.revision_id === input.revision_id &&
          row.proposal.origin_event_id === input.origin_event_id,
      )
      .map((row) => this.project(row));
  }

  async events(conversationId: string, proposalId: string) {
    const snapshot = this.snapshot(conversationId, proposalId);
    if (!snapshot) return null;
    const scope = snapshot.proposal.base.capability_scope as CapabilityScope;
    const service = this.runtime.service(scope);
    const authority = service.options.actionAuthority;
    if (!authority)
      throw new CapabilityRuntimeError(
        "action authority is unavailable",
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
    return projectCapabilityActionEvents(snapshot, service.options.storage, authority);
  }

  subscribe(conversationId: string, proposalId: string, listener: () => void) {
    return this.snapshot(conversationId, proposalId)
      ? this.actions.authority.subscribe(proposalId, listener)
      : null;
  }

  async challenge(context: MutationContextV1<ActionApprovalChallengeRequestV1>) {
    this.require(context.conversation_id, context.proposal_id);
    return this.actions.authority.issueChallenge({
      proposal_id: context.proposal_id,
      proposal_digest: context.request.proposal_digest,
      challenge_class: context.request.challenge_class,
      authority: context.authority,
    });
  }

  async approve(context: MutationContextV1<ActionApprovalRequestV1>) {
    this.require(context.conversation_id, context.proposal_id);
    const approval = this.actions.authority.decide({
      proposal_id: context.proposal_id,
      proposal_digest: context.request.proposal_digest,
      authority: context.authority,
      decision: context.request.decision,
      challenge_id: context.request.challenge_id,
      challenge_response: context.request.challenge_response,
    });
    const response = this.require(context.conversation_id, context.proposal_id);
    return {
      schema_version: "1.0" as const,
      approval: response.approval as NonNullable<typeof response.approval>,
      operation: response.operation,
    };
  }

  async commit(context: MutationContextV1<ActionCommitRequestV1>) {
    let snapshot = this.ownedSnapshot(context.conversation_id, context.proposal_id);
    if (!snapshot) throw new ConversationActionTargetUnsupportedError(null);
    const locator = snapshot.proposal.action_root_locator;
    if (
      locator.kind !== ACTION_ROOT_LOCATOR_KIND.CONVERSATION ||
      locator.root_session_id !== snapshot.proposal.base.root_session_id
    )
      throw new CapabilityRuntimeError(
        "conversation capability proposal selected another action root",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    this.runtime.bindActionAuthority(locator, this.actions.authority.reader);
    if (
      snapshot.proposal.proposal_digest !== context.request.proposal_digest ||
      snapshot.approval?.approval_id !== context.request.approval_id
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
    if (isActionOperationDomainTerminalState(snapshot.state)) {
      this.dispatchRuntime.releaseTerminal(snapshot);
      return { schema_version: "1.0" as const, operation: this.project(snapshot).operation };
    }
    if (!isActionOperationDispatchBeginState(snapshot.state)) {
      this.dispatchRuntime.releaseAborted(snapshot);
      throw new ActionConflictError(
        "stale_proposal",
        "Capability proposal can no longer enter committing.",
        context.proposal_id,
      );
    }
    if (!snapshot.approval) throw new Error("capability proposal approval is absent");
    snapshot = await this.dispatchRuntime.execute(snapshot, context.request.approval_id);
    if (!snapshot) throw new Error("committed capability proposal disappeared");
    const projected = this.project(snapshot).operation;
    return { schema_version: "1.0" as const, operation: projected };
  }

  async cancel(context: MutationContextV1<ActionCancelRequestV1>) {
    this.require(context.conversation_id, context.proposal_id);
    const snapshot = this.actions.authority.cancel({
      proposal_id: context.proposal_id,
      proposal_digest: context.request.proposal_digest,
      authority: context.authority,
      reason: context.request.reason,
    });
    this.dispatchRuntime.releaseAborted(snapshot);
    return { schema_version: "1.0" as const, operation: this.project(snapshot).operation };
  }

  private snapshot(conversationId: string, proposalId: string) {
    const snapshot = this.actions.authority.get(proposalId);
    if (!snapshot || !this.owned(snapshot, conversationId)) return null;
    const locator = snapshot.proposal.action_root_locator;
    const resolved = this.actions.resolveCapabilityActionRoot(conversationId);
    if (
      locator.kind !== ACTION_ROOT_LOCATOR_KIND.CONVERSATION ||
      locator.root_session_id !== resolved.root_session_id ||
      snapshot.proposal.base.root_session_id !== resolved.root_session_id
    )
      throw new CapabilityRuntimeError(
        "conversation capability proposal selected another action root",
        CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
      );
    this.runtime.bindActionAuthority(locator, this.actions.authority.reader);
    return snapshot;
  }

  private view(conversationId: string, proposalId: string): ActionProposalResponseV1 | null {
    const snapshot = this.snapshot(conversationId, proposalId);
    return snapshot ? this.project(snapshot) : null;
  }

  private require(conversationId: string, proposalId: string): ActionProposalResponseV1 {
    const response = this.ownedView(conversationId, proposalId);
    if (!response) throw new ConversationActionTargetUnsupportedError(null);
    return response;
  }

  private ownedView(conversationId: string, proposalId: string): ActionProposalResponseV1 | null {
    const snapshot = this.ownedSnapshot(conversationId, proposalId);
    return snapshot ? this.project(snapshot) : null;
  }

  private ownedSnapshot(conversationId: string, proposalId: string) {
    const snapshot = this.actions.authority.get(proposalId);
    return snapshot && this.owned(snapshot, conversationId) ? snapshot : null;
  }

  private owned(
    snapshot: import("../../actions/index.js").ActionAuthoritySnapshotV1,
    conversationId: string,
  ): boolean {
    return (
      snapshot.proposal.domain === "capability" &&
      snapshot.proposal.base.conversation_id === conversationId
    );
  }

  private project(snapshot: import("../../actions/index.js").ActionAuthoritySnapshotV1) {
    const scope = snapshot.proposal.base.capability_scope;
    if (!scope) return projectActionSnapshot(snapshot);
    const service = this.runtime.service(scope);
    const authority = service.options.actionAuthority;
    if (!authority)
      throw new CapabilityRuntimeError(
        "action authority is unavailable",
        CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
      );
    return projectCapabilityActionSnapshot(snapshot, service.options.storage, authority);
  }
}
