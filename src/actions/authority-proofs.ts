import { canonicalJsonBytes, digestV1 } from "../durability/index.js";
import type { ProposalPublicationProofV1 } from "./proposal-publication-proof.js";
import { assertDigest, assertTimestamp } from "./record-primitives.js";
import { assertApproval, assertProposal } from "./records.js";
import { exactObject } from "./strict-json.js";
import type {
  ActionApprovalV1,
  ActionDispatchRecordV1,
  ActionOperationState,
  ActionProposalV1,
  ActionRequestAuthorityV1,
  ChallengeClass,
} from "./types.js";

export interface ReviewAuthorityProofV1 {
  schema_version: "1.0";
  proposal_id: string;
  proposal_digest: string;
  principal_digest: string;
  authority_scope_digest: string;
  control_session_digest: string;
  csrf_epoch_digest: string;
  plan_digest: string;
  adapter_set_digest: string;
  target_set_digest: string;
  package_pin_set_digest: string;
  source_authority_set_digest: string;
  policy_digest: string;
  grant_digest: string;
  permission_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
  required_challenge_class: ChallengeClass;
  checked_at: string;
  approval_expires_at: string;
  proof_digest: string;
}

export interface DispatchPreparationProofV1 {
  schema_version: "1.0";
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  plan_digest: string;
  execution_object_closure_digest: string | null;
  domain_header_digest: string | null;
  checked_at: string;
  proof_digest: string;
}

export interface DomainPreparedProofV1 {
  schema_version: "1.0";
  operation_id: string;
  dispatch_record_digest: string;
  domain_prepared_record_digest: string;
  prepared_at: string;
  proof_digest: string;
}

export interface DomainTerminalProofV1 {
  schema_version: "1.0";
  operation_id: string;
  dispatch_record_digest: string;
  outcome: Extract<ActionOperationState, "succeeded" | "failed" | "needs_recovery">;
  domain_terminal_digest: string;
  recorded_at: string;
  proof_digest: string;
}

export interface ActionAuthorityResolverV1 {
  validateProposalPublication(input: {
    proposal: ActionProposalV1;
    canonical_request_digest: string;
    now: string;
  }): ProposalPublicationProofV1;
  review(input: {
    proposal: ActionProposalV1;
    authority: ActionRequestAuthorityV1;
    decision: "approved" | "denied";
    now: string;
  }): ReviewAuthorityProofV1;
  prepareDispatch(input: {
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    now: string;
  }): DispatchPreparationProofV1;
  proveDomainPrepared(input: {
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    dispatch: ActionDispatchRecordV1;
  }): DomainPreparedProofV1;
  resolveTerminal(input: {
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    dispatch: ActionDispatchRecordV1;
    current_state: "committing" | "needs_recovery";
  }): DomainTerminalProofV1;
  validateRecordedTerminal(input: {
    proposal: ActionProposalV1;
    approval: ActionApprovalV1;
    dispatch: ActionDispatchRecordV1;
    outcome: DomainTerminalProofV1["outcome"];
    domain_terminal_digest: string;
    recorded_at: string;
  }): DomainTerminalProofV1;
}

export class ActionAuthorityStaleError extends Error {
  constructor(
    readonly recorded_at: string,
    readonly reason_code: string,
  ) {
    super("live action authority no longer matches the immutable proposal");
    this.name = "ActionAuthorityStaleError";
    assertTimestamp(recorded_at, "$.authority_stale.recorded_at");
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(reason_code))
      throw new Error("invalid stale authority reason code");
  }
}

export function requiredChallengeClass(
  proposal: ActionProposalV1,
  authority: ActionRequestAuthorityV1,
): ChallengeClass {
  if (proposal.action.type === "authority.repair")
    return proposal.base.authority_binding_mode === "recovery-checkpoint"
      ? "recovery-tty"
      : "normal-confirm";
  if (proposal.action.type === "conversation.publish_suspected_literal") return "public-literal";
  if (authority.actor.credential_class === "automation-grant") return "automation-grant";
  if (
    proposal.base.capability_scope === "user" ||
    proposal.target_set.some((target) => target.target.scope === "user")
  )
    return "fresh-user-scope";
  return "normal-confirm";
}

export function materializeReviewAuthorityProof(
  proposal: ActionProposalV1,
  authority: ActionRequestAuthorityV1,
  checkedAt: string,
  approvalExpiresAt: string,
): ReviewAuthorityProofV1 {
  assertProposal(proposal);
  const preimage = {
    schema_version: "1.0" as const,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    principal_digest: authority.principal_digest,
    authority_scope_digest: authority.authority_scope_digest,
    control_session_digest: authority.control_session_digest,
    csrf_epoch_digest: authority.csrf_epoch_digest,
    plan_digest: proposal.plan_digest,
    adapter_set_digest: proposal.adapter_set_digest,
    target_set_digest: digestV1("VF-ACTION-TARGET-SET\0v1\0", proposal.target_set),
    package_pin_set_digest: digestV1("VF-ACTION-PACKAGE-PIN-SET\0v1\0", proposal.package_pins),
    source_authority_set_digest: proposal.source_authority_set_digest,
    policy_digest: proposal.policy_digest,
    grant_digest: proposal.grant_digest,
    permission_digest: proposal.permission_digest,
    authority_epoch: proposal.base.authority_epoch,
    authority_head_digest: proposal.base.authority_head_digest,
    required_challenge_class: requiredChallengeClass(proposal, authority),
    checked_at: checkedAt,
    approval_expires_at: approvalExpiresAt,
  };
  return {
    ...preimage,
    proof_digest: digestV1("VF-ACTION-REVIEW-AUTHORITY-PROOF\0v1\0", preimage),
  };
}

export function assertReviewAuthorityProof(
  proof: ReviewAuthorityProofV1,
  proposal: ActionProposalV1,
  authority: ActionRequestAuthorityV1,
  now: string,
): void {
  exactObject(
    proof,
    [
      "schema_version",
      "proposal_id",
      "proposal_digest",
      "principal_digest",
      "authority_scope_digest",
      "control_session_digest",
      "csrf_epoch_digest",
      "plan_digest",
      "adapter_set_digest",
      "target_set_digest",
      "package_pin_set_digest",
      "source_authority_set_digest",
      "policy_digest",
      "grant_digest",
      "permission_digest",
      "authority_epoch",
      "authority_head_digest",
      "required_challenge_class",
      "checked_at",
      "approval_expires_at",
      "proof_digest",
    ],
    [],
    "$.review_proof",
  );
  const expected = materializeReviewAuthorityProof(
    proposal,
    authority,
    proof.checked_at,
    proof.approval_expires_at,
  );
  if (proof.checked_at !== now || !equalProof(proof, expected))
    throw new Error("review authority proof mismatch");
  const checked = assertTimestamp(proof.checked_at, "$.review_proof.checked_at");
  const expires = assertTimestamp(proof.approval_expires_at, "$.review_proof.approval_expires_at");
  if (expires <= checked || expires > Date.parse(proposal.expires_at))
    throw new Error("review authority proof expiry is invalid");
}

export function materializeDispatchPreparationProof(
  proposal: ActionProposalV1,
  approval: ActionApprovalV1,
  domainHeaderDigest: string | null,
  checkedAt: string,
): DispatchPreparationProofV1 {
  assertApproval(proposal, approval);
  const preimage = {
    schema_version: "1.0" as const,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    approval_id: approval.approval_id,
    approval_digest: approval.approval_digest,
    plan_digest: proposal.plan_digest,
    execution_object_closure_digest: proposal.execution_object_closure_digest,
    domain_header_digest: domainHeaderDigest,
    checked_at: checkedAt,
  };
  return {
    ...preimage,
    proof_digest: digestV1("VF-ACTION-DISPATCH-PREPARATION-PROOF\0v1\0", preimage),
  };
}

export function assertDispatchPreparationProof(
  proof: DispatchPreparationProofV1,
  proposal: ActionProposalV1,
  approval: ActionApprovalV1,
  now: string,
): void {
  const expected = materializeDispatchPreparationProof(
    proposal,
    approval,
    proof.domain_header_digest,
    proof.checked_at,
  );
  if (proof.checked_at !== now || !equalProof(proof, expected))
    throw new Error("dispatch preparation proof mismatch");
  assertTimestamp(proof.checked_at, "$.dispatch_proof.checked_at");
  if (proof.domain_header_digest !== null)
    assertDigest(proof.domain_header_digest, "$.dispatch_proof.domain_header_digest");
}

export function materializeDomainPreparedProof(
  dispatch: ActionDispatchRecordV1,
  domainPreparedRecordDigest: string,
  preparedAt: string,
): DomainPreparedProofV1 {
  const preimage = {
    schema_version: "1.0" as const,
    operation_id: dispatch.operation_id,
    dispatch_record_digest: dispatch.dispatch_record_digest,
    domain_prepared_record_digest: domainPreparedRecordDigest,
    prepared_at: preparedAt,
  };
  return { ...preimage, proof_digest: digestV1("VF-ACTION-DOMAIN-PREPARED-PROOF\0v1\0", preimage) };
}

export function assertDomainPreparedProof(
  proof: DomainPreparedProofV1,
  dispatch: ActionDispatchRecordV1,
): void {
  const expected = materializeDomainPreparedProof(
    dispatch,
    proof.domain_prepared_record_digest,
    proof.prepared_at,
  );
  if (!equalProof(proof, expected)) throw new Error("domain prepared proof mismatch");
  assertDigest(
    proof.domain_prepared_record_digest,
    "$.domain_prepared_proof.domain_prepared_record_digest",
  );
  assertTimestamp(proof.prepared_at, "$.domain_prepared_proof.prepared_at");
}

export function materializeDomainTerminalProof(
  dispatch: ActionDispatchRecordV1,
  outcome: DomainTerminalProofV1["outcome"],
  domainTerminalDigest: string,
  recordedAt: string,
): DomainTerminalProofV1 {
  const preimage = {
    schema_version: "1.0" as const,
    operation_id: dispatch.operation_id,
    dispatch_record_digest: dispatch.dispatch_record_digest,
    outcome,
    domain_terminal_digest: domainTerminalDigest,
    recorded_at: recordedAt,
  };
  return { ...preimage, proof_digest: digestV1("VF-ACTION-DOMAIN-TERMINAL-PROOF\0v1\0", preimage) };
}

export function assertDomainTerminalProof(
  proof: DomainTerminalProofV1,
  dispatch: ActionDispatchRecordV1,
): void {
  if (!new Set(["succeeded", "failed", "needs_recovery"]).has(proof.outcome))
    throw new Error("domain terminal proof outcome is invalid");
  const expected = materializeDomainTerminalProof(
    dispatch,
    proof.outcome,
    proof.domain_terminal_digest,
    proof.recorded_at,
  );
  if (!equalProof(proof, expected)) throw new Error("domain terminal proof mismatch");
  assertDigest(proof.domain_terminal_digest, "$.domain_terminal_proof.domain_terminal_digest");
  assertTimestamp(proof.recorded_at, "$.domain_terminal_proof.recorded_at");
}

function equalProof(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}
