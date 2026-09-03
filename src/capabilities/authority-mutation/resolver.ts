import {
  ACTION_OPERATION_STATE,
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ActionAuthorityStaleError,
  assertApproval,
  deriveOperationId,
  materializeDispatchPreparationProof,
  materializeDispatchRecord,
  materializeDomainPreparedProof,
  materializeDomainTerminalProof,
  materializeProposalPublicationProof,
  materializeReviewAuthorityProof,
} from "../../actions/index.js";
import type {
  ActionAuthorityResolverV1,
  ActionDispatchRecordV1,
  ActionProposalV1,
} from "../../actions/index.js";
import { canonicalJson } from "../../durability/index.js";
import { CapabilityValidationError } from "../wire/primitives.js";
import {
  assertCurrentOrdinaryAuthorityProposal,
  assertOrdinaryAuthorityOperationBinding,
} from "./binding.js";
import type { OrdinaryAuthorityDurableStoreV1 } from "./store.js";
import type {
  OrdinaryAuthorityMutationOptionsV1,
  OrdinaryAuthorityTerminalEvidenceV1,
} from "./types.js";

function approvalExpiry(
  proposal: ActionProposalV1,
  now: string,
  grantExpiry: string | null,
): string {
  return new Date(
    Math.min(
      Date.parse(proposal.expires_at),
      Date.parse(now) + 30 * 60_000,
      grantExpiry ? Date.parse(grantExpiry) : Number.POSITIVE_INFINITY,
    ),
  ).toISOString();
}

function stale<T>(now: string, callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    if (error instanceof CapabilityValidationError && error.path === "authority.stale")
      throw new ActionAuthorityStaleError(now, "authority-stale");
    throw error;
  }
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export class OrdinaryAuthorityActionResolverV1 implements ActionAuthorityResolverV1 {
  constructor(
    private readonly store: OrdinaryAuthorityDurableStoreV1,
    private readonly options: OrdinaryAuthorityMutationOptionsV1,
    private readonly terminalFor: (
      operationId: string,
    ) => OrdinaryAuthorityTerminalEvidenceV1 | null,
  ) {}

  private current(proposal: ActionProposalV1, now: string) {
    return stale(now, () =>
      assertCurrentOrdinaryAuthorityProposal({
        store: this.store,
        proposal,
        options: this.options,
        now,
      }),
    );
  }

  private dispatchBinding(
    proposal: ActionProposalV1,
    approval: import("../../actions/index.js").ActionApprovalV1,
    dispatch: ActionDispatchRecordV1,
  ) {
    const header = this.dispatchHeader(proposal, approval, dispatch);
    const closure = assertOrdinaryAuthorityOperationBinding({
      store: this.store,
      proposal,
      approval,
      header,
    });
    return { header, closure };
  }

  private dispatchHeader(
    proposal: ActionProposalV1,
    approval: import("../../actions/index.js").ActionApprovalV1,
    dispatch: ActionDispatchRecordV1,
  ) {
    assertApproval(proposal, approval);
    const header = this.store.readOperationHeader(dispatch.operation_id);
    if (!header) throw new Error("ordinary authority operation header is absent");
    const expected = materializeDispatchRecord(proposal, approval, header.header_digest);
    if (!exact(dispatch, expected) || dispatch.domain_header_digest !== header.header_digest)
      throw new Error("ordinary authority dispatch escaped its immutable header");
    return header;
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
      throw new Error("ordinary authority canonical request binding mismatch");
    this.current(proposal, now);
    return materializeProposalPublicationProof(
      proposal,
      canonical_request_digest,
      proposal.plan_digest,
      now,
    );
  };

  review: ActionAuthorityResolverV1["review"] = ({ proposal, authority, now }) => {
    const closure = this.current(proposal, now);
    return materializeReviewAuthorityProof(
      proposal,
      authority,
      now,
      approvalExpiry(proposal, now, closure.plan.automation_grant_binding?.expires_at ?? null),
    );
  };

  prevalidateDispatch: NonNullable<ActionAuthorityResolverV1["prevalidateDispatch"]> = ({
    proposal,
    approval,
    now,
  }) => {
    this.current(proposal, now);
    const operationId = deriveOperationId(proposal, approval.approval_id);
    const header = this.store.readOperationHeader(operationId);
    if (!header) throw new Error("ordinary authority operation is not prepared");
    assertOrdinaryAuthorityOperationBinding({ store: this.store, proposal, approval, header });
  };

  prepareDispatch: ActionAuthorityResolverV1["prepareDispatch"] = ({ proposal, approval, now }) => {
    this.current(proposal, now);
    const operationId = deriveOperationId(proposal, approval.approval_id);
    const header = this.store.readOperationHeader(operationId);
    if (!header) throw new Error("ordinary authority operation is not prepared");
    assertOrdinaryAuthorityOperationBinding({ store: this.store, proposal, approval, header });
    return materializeDispatchPreparationProof(proposal, approval, header.header_digest, now);
  };

  proveDomainPrepared: ActionAuthorityResolverV1["proveDomainPrepared"] = ({
    proposal,
    approval,
    dispatch,
  }) => {
    const { header } = this.dispatchBinding(proposal, approval, dispatch);
    const recorded = this.options.action_authority().getRecorded(proposal.proposal_id);
    if (
      !recorded ||
      recorded.state !== ACTION_OPERATION_STATE.COMMITTING ||
      recorded.operation_id !== dispatch.operation_id
    )
      throw new Error("ordinary authority domain preparation lacks committing Action authority");
    const preparedAt =
      recorded.events.at(-1)?.recorded_at ??
      (() => {
        throw new Error("ordinary authority committing event is absent");
      })();
    return materializeDomainPreparedProof(dispatch, header.header_digest, preparedAt);
  };

  resolveTerminal: ActionAuthorityResolverV1["resolveTerminal"] = ({
    proposal,
    approval,
    dispatch,
  }) => {
    const header = this.dispatchHeader(proposal, approval, dispatch);
    const terminal = this.terminalFor(dispatch.operation_id);
    if (!terminal) throw new Error("ordinary authority terminal evidence is absent");
    if (terminal.outcome === ACTION_OPERATION_STATE.SUCCEEDED)
      assertOrdinaryAuthorityOperationBinding({
        store: this.store,
        proposal,
        approval,
        header,
      });
    return materializeDomainTerminalProof(
      dispatch,
      terminal.outcome,
      terminal.domain_terminal_digest,
      terminal.recorded_at,
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
    const header = this.dispatchHeader(proposal, approval, dispatch);
    const terminal = this.terminalFor(dispatch.operation_id);
    if (
      !terminal ||
      terminal.outcome !== outcome ||
      terminal.domain_terminal_digest !== domain_terminal_digest ||
      terminal.recorded_at !== recorded_at
    )
      throw new Error("recorded ordinary authority terminal evidence changed");
    if (terminal.outcome === ACTION_OPERATION_STATE.SUCCEEDED)
      assertOrdinaryAuthorityOperationBinding({
        store: this.store,
        proposal,
        approval,
        header,
      });
    return materializeDomainTerminalProof(dispatch, outcome, domain_terminal_digest, recorded_at);
  };
}
