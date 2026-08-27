import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  ACTION_OPERATION_STATE,
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  type ActionAuthorityResolverV1,
  type ActionDispatchRecordV1,
  type ActionProposalV1,
  deriveOperationId,
  materializeDispatchPreparationProof,
  materializeDomainPreparedProof,
  materializeDomainTerminalProof,
  materializeProposalPublicationProof,
  materializeReviewAuthorityProof,
} from "../../actions/index.js";
import { ACTION_ROOT_LOCATOR_KIND } from "../../actions/protocol-contract.js";
import { canonicalJson } from "../../durability/index.js";
import { OrdinaryAuthorityRepairActionObjectStoreV1 } from "./action-object-store.js";
import { assertAuthorityRepairClosure } from "./closure-records.js";
import { AUTHORITY_REPAIR_BINDING_MODE, AUTHORITY_REPAIR_TERMINAL_STATE } from "./contract.js";
import { authorityRepairActionPlanDigest } from "./digests.js";
import type { AuthorityRepairOperationStoreV1 } from "./operation-store.js";
import type { AuthorityRepairProductionRegistryV1 } from "./production-registry.js";
import { materializeAuthorityRepairOperation } from "./records.js";
import type { AuthorityRepairActionObjectClosureV1 } from "./types.js";

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function approvalExpiry(proposal: ActionProposalV1, now: string): string {
  return new Date(
    Math.min(Date.parse(proposal.expires_at), Date.parse(now) + 30 * 60_000),
  ).toISOString();
}

function terminalOutcome(state: string): "succeeded" | "failed" | "needs_recovery" {
  if (state === AUTHORITY_REPAIR_TERMINAL_STATE.VERIFIED) return ACTION_OPERATION_STATE.SUCCEEDED;
  if (state === AUTHORITY_REPAIR_TERMINAL_STATE.FAILED) return ACTION_OPERATION_STATE.FAILED;
  if (state === AUTHORITY_REPAIR_TERMINAL_STATE.NEEDS_RECOVERY)
    return ACTION_OPERATION_STATE.NEEDS_RECOVERY;
  throw new Error("authority repair operation has no terminal domain state");
}

/** Ordinary current-authority resolver. It cannot resolve or admit recovery-bootstrap objects. */
export class AuthorityRepairOrdinaryActionResolverV1 implements ActionAuthorityResolverV1 {
  private readonly objects: OrdinaryAuthorityRepairActionObjectStoreV1;

  constructor(
    readonly actionRoot: string,
    readonly locator: Exclude<
      import("../../actions/types.js").PrivateActionRootLocatorV1,
      { kind: typeof ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP }
    >,
    readonly registry: AuthorityRepairProductionRegistryV1,
    readonly operations: AuthorityRepairOperationStoreV1,
  ) {
    this.objects = new OrdinaryAuthorityRepairActionObjectStoreV1(actionRoot, locator);
  }

  private resolved(proposal: ActionProposalV1): AuthorityRepairActionObjectClosureV1 {
    if (
      proposal.action.type !== HOST_ACTION_KIND.AUTHORITY_REPAIR ||
      proposal.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.RECOVERY_BOOTSTRAP ||
      !exact(proposal.action_root_locator, this.locator)
    )
      throw new Error("ordinary authority repair proposal escaped its selected action root");
    const objects = this.objects.read({
      binding_digest: proposal.action.plan.repair_authorization_binding_digest,
      plan_digest: proposal.action.plan.plan_digest,
      action_plan_digest: proposal.plan_digest,
    });
    const closure = this.registry.resolve(objects);
    assertAuthorityRepairClosure(closure);
    if (
      closure.authorization.mode !== AUTHORITY_REPAIR_BINDING_MODE.CURRENT ||
      !exact(closure.plan, proposal.action.plan) ||
      !exact(closure.action_plan.action_root_locator, proposal.action_root_locator) ||
      authorityRepairActionPlanDigest(closure.action_plan) !== proposal.plan_digest ||
      this.registry.ownerRoot(closure.plan) !== this.actionRoot
    )
      throw new Error("ordinary repair proposal no longer resolves its immutable closure");
    return closure;
  }

  private current(proposal: ActionProposalV1): AuthorityRepairActionObjectClosureV1 {
    const closure = this.resolved(proposal);
    this.registry.assertCurrent(closure);
    return closure;
  }

  private dispatchBinding(
    proposal: ActionProposalV1,
    approval: import("../../actions/types.js").ActionApprovalV1,
    dispatch: ActionDispatchRecordV1,
  ) {
    const closure = this.resolved(proposal);
    const operation = materializeAuthorityRepairOperation(proposal, approval);
    const stored = this.operations.readHeader(operation.operation_id);
    if (
      !stored ||
      !exact(stored, operation) ||
      dispatch.operation_id !== operation.operation_id ||
      dispatch.domain_header_digest !== operation.header_digest
    )
      throw new Error("ordinary repair dispatch escaped its immutable operation header");
    return { closure, operation };
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
      throw new Error("ordinary repair canonical request binding mismatch");
    const closure = this.current(proposal);
    return materializeProposalPublicationProof(
      proposal,
      canonical_request_digest,
      authorityRepairActionPlanDigest(closure.action_plan),
      now,
    );
  };

  review: ActionAuthorityResolverV1["review"] = ({ proposal, authority, now }) => {
    this.current(proposal);
    return materializeReviewAuthorityProof(proposal, authority, now, approvalExpiry(proposal, now));
  };

  prevalidateDispatch: NonNullable<ActionAuthorityResolverV1["prevalidateDispatch"]> = ({
    proposal,
    approval,
  }) => {
    this.current(proposal);
    const operation = materializeAuthorityRepairOperation(proposal, approval);
    const stored = this.operations.readHeader(operation.operation_id);
    if (!stored || !exact(stored, operation))
      throw new Error("ordinary repair operation is not durably prepared");
  };

  prepareDispatch: ActionAuthorityResolverV1["prepareDispatch"] = ({ proposal, approval, now }) => {
    this.current(proposal);
    const operation = materializeAuthorityRepairOperation(proposal, approval);
    const stored = this.operations.readHeader(operation.operation_id);
    if (!stored || !exact(stored, operation))
      throw new Error("ordinary repair operation is not durably prepared");
    return materializeDispatchPreparationProof(proposal, approval, operation.header_digest, now);
  };

  proveDomainPrepared: ActionAuthorityResolverV1["proveDomainPrepared"] = ({
    proposal,
    approval,
    dispatch,
  }) => {
    const { operation } = this.dispatchBinding(proposal, approval, dispatch);
    return materializeDomainPreparedProof(dispatch, operation.header_digest, operation.created_at);
  };

  resolveTerminal: ActionAuthorityResolverV1["resolveTerminal"] = ({
    proposal,
    approval,
    dispatch,
  }) => {
    const { operation } = this.dispatchBinding(proposal, approval, dispatch);
    const event = this.operations.fold(operation.operation_id).events.at(-1);
    if (!event) throw new Error("ordinary repair terminal evidence is absent");
    return materializeDomainTerminalProof(
      dispatch,
      terminalOutcome(event.state),
      event.event_digest,
      event.recorded_at,
    );
  };

  validateRecordedTerminal: ActionAuthorityResolverV1["validateRecordedTerminal"] = ({
    proposal,
    approval,
    dispatch,
    outcome,
    domain_terminal_digest,
    recorded_at,
  }) => {
    const { operation } = this.dispatchBinding(proposal, approval, dispatch);
    const event = this.operations.fold(operation.operation_id).events.at(-1);
    if (
      !event ||
      terminalOutcome(event.state) !== outcome ||
      event.event_digest !== domain_terminal_digest ||
      event.recorded_at !== recorded_at
    )
      throw new Error("recorded ordinary repair terminal evidence changed");
    return materializeDomainTerminalProof(dispatch, outcome, domain_terminal_digest, recorded_at);
  };
}
