import { canonicalJsonBytes, digestV1 } from "../durability/index.js";
import { assertDigest, assertTimestamp } from "./record-primitives.js";
import { assertProposal } from "./records.js";
import type { ActionProposalV1 } from "./types.js";

export interface ProposalPublicationProofV1 {
  schema_version: "1.0";
  proposal_id: string;
  proposal_digest: string;
  canonical_request_digest: string;
  producer_request_binding_digest: string;
  action_root_locator_digest: string;
  plan_digest: string;
  execution_object_closure_digest: string | null;
  target_set_digest: string;
  package_pin_set_digest: string;
  source_authority_set_digest: string;
  adapter_set_digest: string;
  policy_digest: string;
  grant_digest: string;
  permission_digest: string;
  authority_epoch: number;
  authority_head_digest: string;
  referenced_closure_digest: string;
  checked_at: string;
  proof_digest: string;
}

export function materializeProposalPublicationProof(
  proposal: ActionProposalV1,
  canonicalRequestDigest: string,
  referencedClosureDigest: string,
  checkedAt: string,
): ProposalPublicationProofV1 {
  assertProposal(proposal);
  assertDigest(canonicalRequestDigest, "$.publication_proof.canonical_request_digest");
  assertDigest(referencedClosureDigest, "$.publication_proof.referenced_closure_digest");
  const preimage = {
    schema_version: "1.0" as const,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    canonical_request_digest: canonicalRequestDigest,
    producer_request_binding_digest: digestV1(
      "VF-ACTION-PRODUCER-REQUEST-BINDING\0v1\0",
      proposal.producer_request_binding,
    ),
    action_root_locator_digest: digestV1(
      "VF-ACTION-ROOT-LOCATOR\0v1\0",
      proposal.action_root_locator,
    ),
    plan_digest: proposal.plan_digest,
    execution_object_closure_digest: proposal.execution_object_closure_digest,
    target_set_digest: digestV1("VF-ACTION-TARGET-SET\0v1\0", proposal.target_set),
    package_pin_set_digest: digestV1("VF-ACTION-PACKAGE-PIN-SET\0v1\0", proposal.package_pins),
    source_authority_set_digest: proposal.source_authority_set_digest,
    adapter_set_digest: proposal.adapter_set_digest,
    policy_digest: proposal.policy_digest,
    grant_digest: proposal.grant_digest,
    permission_digest: proposal.permission_digest,
    authority_epoch: proposal.base.authority_epoch,
    authority_head_digest: proposal.base.authority_head_digest,
    referenced_closure_digest: referencedClosureDigest,
    checked_at: checkedAt,
  };
  return {
    ...preimage,
    proof_digest: digestV1("VF-ACTION-PROPOSAL-PUBLICATION-PROOF\0v1\0", preimage),
  };
}

export function assertProposalPublicationProof(
  proof: ProposalPublicationProofV1,
  proposal: ActionProposalV1,
  canonicalRequestDigest: string,
  now: string,
): void {
  const expected = materializeProposalPublicationProof(
    proposal,
    canonicalRequestDigest,
    proof.referenced_closure_digest,
    proof.checked_at,
  );
  if (proof.checked_at !== now || !canonicalJsonBytes(proof).equals(canonicalJsonBytes(expected)))
    throw new Error("proposal publication proof mismatch");
  assertTimestamp(proof.checked_at, "$.publication_proof.checked_at");
}
