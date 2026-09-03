import {
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_ROOT_LOCATOR_KIND,
  type ActionAuthorityResolverV1,
  ActionAuthorityStaleError,
  type ActionDispatchRecordV1,
  type ActionProposalV1,
  deriveOperationId,
  materializeDispatchPreparationProof,
  materializeDomainPreparedProof,
  materializeDomainTerminalProof,
  materializeProposalPublicationProof,
  materializeReviewAuthorityProof,
} from "../../actions/index.js";
import type { CapabilityActionObjectStoreV1 } from "../../capabilities/action-domain/object-store.js";
import {
  assertCapabilityDomainActionBinding,
  readCapabilityDomainAuthorityEvidence,
  readCapabilityDomainPreparedEvidence,
} from "../../capabilities/action-domain/operation-evidence.js";
import { CapabilityRuntimeError } from "../../capabilities/operations/errors.js";
import type { CapabilityFabricServiceV1 } from "../../capabilities/service.js";
import {
  CAPABILITY_RUNTIME_ERROR_CODE,
  type CapabilityScope,
  isCapabilityScope,
} from "../../core/capability-contract.js";

const NON_STALE_RUNTIME_ERROR_CODES = Object.freeze([
  CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
  CAPABILITY_RUNTIME_ERROR_CODE.INVALID_PLAN,
  CAPABILITY_RUNTIME_ERROR_CODE.SERVICE_UNAVAILABLE,
] as const);

function stale(error: unknown, now: string): never {
  if (
    error instanceof CapabilityRuntimeError &&
    !NON_STALE_RUNTIME_ERROR_CODES.some((code) => code === error.runtime_code)
  )
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

function proposalCapabilityScope(proposal: ActionProposalV1): CapabilityScope {
  const scope = proposal.base.capability_scope;
  if (!isCapabilityScope(scope))
    throw new CapabilityRuntimeError(
      "standalone capability proposal scope is invalid",
      CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
    );
  return scope;
}

export class StandaloneCapabilityActionAuthorityResolver implements ActionAuthorityResolverV1 {
  constructor(
    private readonly objects: CapabilityActionObjectStoreV1,
    private readonly serviceFor: (scope: CapabilityScope) => CapabilityFabricServiceV1,
  ) {}

  private current(proposal: ActionProposalV1, now: string) {
    try {
      if (
        proposal.action_root_locator.kind !== ACTION_ROOT_LOCATOR_KIND.CAPABILITY ||
        proposal.base.capability_scope === null ||
        proposal.base.capability_scope !== proposal.action_root_locator.scope
      )
        throw new CapabilityRuntimeError(
          "standalone capability proposal root is incomplete",
          CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH,
        );
      const graph = this.objects.readGraph(proposal);
      this.serviceFor(proposal.base.capability_scope).revalidateGraph(graph);
      return graph;
    } catch (error) {
      return stale(error, now);
    }
  }

  validateProposalPublication: ActionAuthorityResolverV1["validateProposalPublication"] = ({
    proposal,
    canonical_request_digest,
    now,
  }) => {
    if (
      proposal.producer_request_binding.kind !==
        ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST ||
      proposal.producer_request_binding.digest !== canonical_request_digest
    )
      throw new Error("capability proposal request binding mismatch");
    const graph = this.current(proposal, now);
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

  prepareDispatch: ActionAuthorityResolverV1["prepareDispatch"] = ({ proposal, approval, now }) => {
    this.current(proposal, now);
    const operationId = deriveOperationId(proposal, approval.approval_id);
    const service = this.serviceFor(proposalCapabilityScope(proposal));
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
    const service = this.serviceFor(proposalCapabilityScope(proposal));
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
    const service = this.serviceFor(proposalCapabilityScope(proposal));
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
    const service = this.serviceFor(proposalCapabilityScope(proposal));
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
