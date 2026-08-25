import {
  type ActionApprovalChallengeRequestV1,
  type ActionApprovalRequestV1,
  type ActionCancelRequestV1,
  type ActionCommitRequestV1,
  ActionConflictError,
  type ActionProposalResponseV1,
  type BrowserHostActionRequestV1,
  projectActionSnapshot,
  validateInternalHostAction,
} from "../../actions/index.js";
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
import type { CapabilityActionObjectStoreV1 } from "./object-store.js";
import { projectCapabilityActionEvents, projectCapabilityActionSnapshot } from "./projection.js";
import { materializeCapabilityConversationProposal } from "./proposal.js";

type MutationContextV1<T> = {
  conversation_id: string;
  proposal_id: string;
  request: T;
  authority: import("../../actions/index.js").ActionRequestAuthorityV1;
};

type BrowserCapabilityActionV1 = Extract<
  BrowserHostActionRequestV1,
  { type: `capability.${string}` }
>;

function isCapability(
  candidate: BrowserHostActionRequestV1,
): candidate is BrowserCapabilityActionV1 {
  return candidate.type.startsWith("capability.");
}

function directAction(candidate: BrowserHostActionRequestV1): CapabilityHostActionV1 {
  if (!isCapability(candidate)) throw new ConversationActionTargetUnsupportedError(candidate.type);
  return validateInternalHostAction(candidate) as CapabilityHostActionV1;
}

/** Browser/conversation capability domain over the same durable ActionAuthorityStore. */
export class CapabilityConversationActionDomainV1
  implements ConversationActionDomainPlannerExecutorV1
{
  readonly domain = "capability" as const;
  readonly objects: CapabilityActionObjectStoreV1;
  readonly resolver: CapabilityActionAuthorityResolverV1;

  constructor(
    readonly runtime: CapabilityRuntimeFactoryV1,
    readonly actions: ConversationActionService,
  ) {
    this.objects = runtime.actionObjects;
    this.resolver = new CapabilityActionAuthorityResolverV1(
      this.objects,
      (scope) => runtime.service(scope),
      actions,
    );
    actions.registerCapabilityAuthorityResolver(this.resolver);
  }

  supports(candidate: BrowserHostActionRequestV1): boolean {
    return isCapability(candidate);
  }

  inspectAdoptCandidates(input: {
    conversation_id: string;
    request: LegacyAdoptInspectionRequestV1;
    authority: import("../../actions/index.js").ActionRequestAuthorityV1;
  }) {
    const selected = this.actions.resolveCapabilityActionRoot(input.conversation_id);
    const locator = {
      kind: "conversation" as const,
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
      kind: "conversation" as const,
      root_session_id: conversation.root_session_id,
    };
    this.runtime.bindActionAuthority(locator, this.actions.authority.reader);
    const candidate = context.request.candidate;
    if (!isCapability(candidate))
      throw new ConversationActionTargetUnsupportedError(candidate.type);
    const service = this.runtime.service(candidate.scope);
    const action: CapabilityHostActionV1 =
      candidate.type === "capability.adopt"
        ? {
            type: "capability.adopt",
            scope: candidate.scope,
            candidate: service.resolveAdoptCandidate(candidate, {
              scope: candidate.scope,
              action_root_locator: locator,
            }),
          }
        : directAction(candidate);
    const graph = service.prepareIntentGraph({
      schema_version: "1.0",
      action,
      planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
      action_root_locator: locator,
      request_authority: context.authority,
    });
    const { plan } = graph;
    if (plan.status !== "planned")
      throw new CapabilityRuntimeError(
        plan.status === "no-op"
          ? "capability intent is already satisfied"
          : "capability intent requires user or external action",
        "action-required",
      );
    const status = service.options.storage.readStatus();
    if ((status.lock?.content_digest ?? null) !== plan.base_lock_digest)
      throw new CapabilityRuntimeError(
        "capability base changed during proposal",
        "scope-base-stale",
      );
    const materialized = materializeCapabilityConversationProposal({
      request: context.request,
      authority: context.authority,
      conversation,
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
    return this.view(conversationId, proposalId);
  }

  async pending(conversationId: string) {
    return this.actions.authority
      .list()
      .filter(
        (row) =>
          (row.state === "pending_review" || row.state === "approved") &&
          this.owned(row, conversationId),
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
    const scope = snapshot.proposal.base.capability_scope as "project" | "user";
    const service = this.runtime.service(scope);
    const authority = service.options.actionAuthority;
    if (!authority)
      throw new CapabilityRuntimeError("action authority is unavailable", "service-unavailable");
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
    let snapshot = this.snapshot(context.conversation_id, context.proposal_id);
    if (!snapshot) throw new ConversationActionTargetUnsupportedError(null);
    if (
      snapshot.proposal.proposal_digest !== context.request.proposal_digest ||
      snapshot.approval?.approval_id !== context.request.approval_id
    )
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal or approval authority changed.",
        context.proposal_id,
      );
    if (["succeeded", "failed", "needs_recovery"].includes(snapshot.state))
      return { schema_version: "1.0" as const, operation: this.project(snapshot).operation };
    if (!snapshot.approval) throw new Error("capability proposal approval is absent");
    const graph = this.objects.readGraph(snapshot.proposal);
    const service = this.runtime.service(graph.plan.scope);
    const prepared = service.prepareApproved({
      schema_version: "1.0",
      graph,
      proposal: snapshot.proposal,
      approval: snapshot.approval,
    });
    if (!("result" in prepared)) {
      this.actions.authority.beginPreparedDispatch(
        context.proposal_id,
        context.request.approval_id,
        prepared.prepared_at,
      );
      service.executePrepared(prepared.operation_id);
    }
    this.actions.authority.recordTerminal(context.proposal_id);
    snapshot = this.snapshot(context.conversation_id, context.proposal_id);
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
    return { schema_version: "1.0" as const, operation: this.project(snapshot).operation };
  }

  private snapshot(conversationId: string, proposalId: string) {
    const snapshot = this.actions.authority.get(proposalId);
    if (!snapshot || !this.owned(snapshot, conversationId)) return null;
    const locator = snapshot.proposal.action_root_locator;
    const resolved = this.actions.resolveCapabilityActionRoot(conversationId);
    if (
      locator.kind !== "conversation" ||
      locator.root_session_id !== resolved.root_session_id ||
      snapshot.proposal.base.root_session_id !== resolved.root_session_id
    )
      throw new CapabilityRuntimeError(
        "conversation capability proposal selected another action root",
        "authorization-mismatch",
      );
    this.runtime.bindActionAuthority(locator, this.actions.authority.reader);
    return snapshot;
  }

  private view(conversationId: string, proposalId: string): ActionProposalResponseV1 | null {
    const snapshot = this.snapshot(conversationId, proposalId);
    return snapshot ? this.project(snapshot) : null;
  }

  private require(conversationId: string, proposalId: string): ActionProposalResponseV1 {
    const response = this.view(conversationId, proposalId);
    if (!response) throw new ConversationActionTargetUnsupportedError(null);
    return response;
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
      throw new CapabilityRuntimeError("action authority is unavailable", "service-unavailable");
    return projectCapabilityActionSnapshot(snapshot, service.options.storage, authority);
  }
}
