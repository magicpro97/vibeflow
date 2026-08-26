import {
  type ActionAuthorityResolverV1,
  ActionAuthorityStaleError,
  type ActionDispatchRecordV1,
  type ActionProposalV1,
  type DurableActionAuthorityReaderV1,
  deriveOperationId,
  materializeDispatchPreparationProof,
  materializeDomainPreparedProof,
  materializeDomainTerminalProof,
  materializeProposalPublicationProof,
  materializeReviewAuthorityProof,
} from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import type { CapabilityConversationProposalBaseV1 } from "../../orchestrator/conversation/conversation-action-service-types.js";
import type { ConversationCapabilityDispatchReservationStoreV1 } from "../../orchestrator/conversation/conversation-capability-dispatch-reservation.js";
import { ConversationRevisionConflictError } from "../../orchestrator/conversation/revision-errors.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import type { CapabilityFabricServiceV1 } from "../service.js";
import type { CapabilityActionObjectStoreV1 } from "./object-store.js";
import {
  assertCapabilityDomainActionBinding,
  readCapabilityDomainAuthorityEvidence,
  readCapabilityDomainPreparedEvidence,
} from "./operation-evidence.js";

const RETAINED_CAPABILITY_RUNTIME_ERROR_CODES: ReadonlySet<string> = new Set([
  "integrity-failure",
  "invalid-plan",
  "service-unavailable",
]);

function stale(error: unknown, now: string): never {
  if (error instanceof ConversationRevisionConflictError)
    throw new ActionAuthorityStaleError(now, "conversation-source-changed");
  if (!(error instanceof CapabilityRuntimeError)) throw error;
  if (!RETAINED_CAPABILITY_RUNTIME_ERROR_CODES.has(error.runtime_code))
    throw new ActionAuthorityStaleError(now, error.runtime_code);
  throw error;
}

function approvalExpiry(proposal: ActionProposalV1, now: string): string {
  return new Date(
    Math.min(Date.parse(proposal.expires_at), Date.parse(now) + 30 * 60_000),
  ).toISOString();
}

function dispatchApproval(dispatch: ActionDispatchRecordV1) {
  return {
    approval_id: dispatch.approval_id,
    approval_digest: dispatch.approval_digest,
    decided_at: dispatch.created_at,
  };
}

/** Shared ActionAuthorityStore resolver backed only by retained capability action objects and WAL. */
export class CapabilityActionAuthorityResolverV1 implements ActionAuthorityResolverV1 {
  constructor(
    readonly objects: CapabilityActionObjectStoreV1,
    readonly serviceFor: (scope: "project" | "user") => CapabilityFabricServiceV1,
    readonly conversation: {
      authority: { reader: DurableActionAuthorityReaderV1 };
      capabilityDispatches: ConversationCapabilityDispatchReservationStoreV1;
      resolveCapabilityActionRoot(conversationId: string): { root_session_id: string };
      resolveCapabilityProposalBase(input: {
        conversation_id: string;
        expected: import("../../actions/index.js").ExpectedActionSourceV1;
      }): CapabilityConversationProposalBaseV1;
    },
  ) {}

  private source(proposal: ActionProposalV1, now: string): CapabilityConversationProposalBaseV1 {
    try {
      if (
        proposal.action_root_locator.kind !== "conversation" ||
        !proposal.base.conversation_id ||
        !proposal.base.root_session_id ||
        proposal.base.capability_scope === null
      )
        throw new CapabilityRuntimeError(
          "conversation capability proposal root is incomplete",
          "authorization-mismatch",
        );
      const resolved = this.conversation.resolveCapabilityActionRoot(proposal.base.conversation_id);
      if (
        resolved.root_session_id !== proposal.base.root_session_id ||
        resolved.root_session_id !== proposal.action_root_locator.root_session_id
      )
        throw new CapabilityRuntimeError(
          "conversation capability proposal selected another action root",
          "authorization-mismatch",
        );
      if (
        proposal.base.revision_id === null ||
        proposal.base.last_seq === null ||
        proposal.base.conversation_lock_digest === null ||
        proposal.base.lineage_head_digest === null ||
        proposal.base.lineage_head_epoch === null
      )
        throw new CapabilityRuntimeError(
          "conversation capability proposal source is incomplete",
          "authorization-mismatch",
        );
      const source = this.conversation.resolveCapabilityProposalBase({
        conversation_id: proposal.base.conversation_id,
        expected: {
          mode: "writable-revision",
          conversation_id: proposal.base.conversation_id,
          revision_id: proposal.base.revision_id,
          last_seq: proposal.base.last_seq,
          conversation_lock_digest: proposal.base.conversation_lock_digest,
        },
      });
      if (
        source.root_session_id !== proposal.base.root_session_id ||
        source.lineage_head_digest !== proposal.base.lineage_head_digest ||
        source.lineage_head_epoch !== proposal.base.lineage_head_epoch
      )
        throw new ActionAuthorityStaleError(now, "conversation-source-changed");
      return source;
    } catch (error) {
      return stale(error, now);
    }
  }

  private current(proposal: ActionProposalV1, now: string) {
    const source = this.source(proposal, now);
    if (proposal.action_root_locator.kind !== "conversation")
      throw new Error("conversation capability locator changed after source validation");
    this.objects.roots.bind(proposal.action_root_locator, this.conversation.authority.reader);
    const graph = this.objects.readGraph(proposal);
    this.serviceFor(proposal.base.capability_scope as "project" | "user").revalidateGraph(graph);
    return { graph, source };
  }

  validateProposalPublication: ActionAuthorityResolverV1["validateProposalPublication"] = ({
    proposal,
    canonical_request_digest,
    now,
  }) => {
    if (
      proposal.producer_request_binding.kind !== "canonical-action-request" ||
      proposal.producer_request_binding.digest !== canonical_request_digest
    )
      throw new Error("capability proposal request binding mismatch");
    const { graph } = this.current(proposal, now);
    return materializeProposalPublicationProof(
      proposal,
      canonical_request_digest,
      graph.plan.execution_closure_digest,
      now,
    );
  };

  review: ActionAuthorityResolverV1["review"] = ({ proposal, authority, now }) => {
    this.current(proposal, now);
    return materializeReviewAuthorityProof(proposal, authority, now, approvalExpiry(proposal, now));
  };

  prevalidateDispatch: NonNullable<ActionAuthorityResolverV1["prevalidateDispatch"]> = ({
    proposal,
    now,
  }) => {
    this.current(proposal, now);
  };

  reserveDispatch: NonNullable<ActionAuthorityResolverV1["reserveDispatch"]> = (input) => {
    this.current(input.proposal, input.now);
    const producerParticipantId =
      input.proposal.requested_by.kind === "agent"
        ? input.proposal.requested_by.public_actor_id
        : null;
    if ((producerParticipantId === null) !== (input.producer_authority_digest == null))
      throw new Error("capability dispatch producer authority is incomplete");
    this.conversation.capabilityDispatches.claim({
      proposal: input.proposal,
      approval: input.approval,
      dispatch: input.dispatch,
      now: input.now,
      resolveSource: () => {
        const source = this.source(input.proposal, input.now);
        return {
          root_session_id: source.root_session_id,
          conversation_id: source.conversation_id,
          revision_id: source.revision_id,
          last_seq: source.last_seq,
          conversation_lock_digest: source.conversation_lock_digest,
          lineage_head_digest: source.lineage_head_digest,
          lineage_head_epoch: source.lineage_head_epoch,
          participant_binding_set_digest: source.participant_binding_set_digest,
          target_set_digest: digestV1("VF-ACTION-TARGET-SET\0v1\0", input.proposal.target_set),
          producer_participant_id: producerParticipantId,
          producer_request_binding_digest: input.proposal.producer_request_binding.digest,
          producer_host_tool_grant_digest: input.producer_authority_digest ?? null,
          capability_grant_digest: input.proposal.grant_digest,
        };
      },
    });
  };

  assertDispatchReserved: NonNullable<ActionAuthorityResolverV1["assertDispatchReserved"]> = ({
    proposal,
    approval,
    dispatch,
  }) => {
    this.conversation.capabilityDispatches.assertActive(proposal, approval, dispatch);
  };

  prepareDispatch: ActionAuthorityResolverV1["prepareDispatch"] = ({ proposal, approval, now }) => {
    this.current(proposal, now);
    const operationId = deriveOperationId(proposal, approval.approval_id);
    const service = this.serviceFor(proposal.base.capability_scope as "project" | "user");
    const authority = service.options.actionAuthority;
    if (!authority) throw new Error("capability action authority is unavailable");
    const domain = readCapabilityDomainPreparedEvidence(
      service.options.storage,
      operationId,
      authority,
    );
    assertCapabilityDomainActionBinding({ proposal, approval, operationId, domain });
    return materializeDispatchPreparationProof(
      proposal,
      approval,
      domain.evidence.header_digest,
      now,
    );
  };

  proveDomainPrepared: ActionAuthorityResolverV1["proveDomainPrepared"] = ({
    proposal,
    dispatch,
  }) => {
    const service = this.serviceFor(proposal.base.capability_scope as "project" | "user");
    const authority = service.options.actionAuthority;
    if (!authority) throw new Error("capability action authority is unavailable");
    const domain = readCapabilityDomainPreparedEvidence(
      service.options.storage,
      dispatch.operation_id,
      authority,
    );
    assertCapabilityDomainActionBinding({
      proposal,
      approval: dispatchApproval(dispatch),
      operationId: dispatch.operation_id,
      domain,
    });
    if (dispatch.domain_header_digest !== domain.evidence.header_digest)
      throw new Error("capability prepared header changed after dispatch preparation");
    return materializeDomainPreparedProof(
      dispatch,
      domain.evidence.header_digest,
      domain.evidence.prepared_at,
    );
  };

  resolveTerminal: ActionAuthorityResolverV1["resolveTerminal"] = ({ proposal, dispatch }) => {
    const service = this.serviceFor(proposal.base.capability_scope as "project" | "user");
    const authority = service.options.actionAuthority;
    if (!authority) throw new Error("capability action authority is unavailable");
    const domain = readCapabilityDomainAuthorityEvidence(
      service.options.storage,
      dispatch.operation_id,
      authority,
    );
    assertCapabilityDomainActionBinding({
      proposal,
      approval: dispatchApproval(dispatch),
      operationId: dispatch.operation_id,
      domain,
    });
    if (dispatch.domain_header_digest !== domain.evidence.header_digest)
      throw new Error("capability terminal header changed after dispatch preparation");
    const terminal = domain.evidence.terminal;
    if (!terminal) throw new Error("capability operation terminal is absent");
    return materializeDomainTerminalProof(
      dispatch,
      terminal.outcome,
      terminal.domain_terminal_digest,
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
    const service = this.serviceFor(proposal.base.capability_scope as "project" | "user");
    const authority = service.options.actionAuthority;
    if (!authority) throw new Error("capability action authority is unavailable");
    const domain = readCapabilityDomainAuthorityEvidence(
      service.options.storage,
      dispatch.operation_id,
      authority,
    );
    assertCapabilityDomainActionBinding({
      proposal,
      approval: dispatchApproval(dispatch),
      operationId: dispatch.operation_id,
      domain,
    });
    if (dispatch.domain_header_digest !== domain.evidence.header_digest)
      throw new Error("recorded capability terminal header changed");
    const terminal = domain.evidence.terminal;
    if (
      !terminal ||
      terminal.outcome !== outcome ||
      terminal.domain_terminal_digest !== domain_terminal_digest ||
      terminal.recorded_at !== recorded_at
    )
      throw new Error("recorded capability terminal authority changed");
    return materializeDomainTerminalProof(dispatch, outcome, domain_terminal_digest, recorded_at);
  };
}
