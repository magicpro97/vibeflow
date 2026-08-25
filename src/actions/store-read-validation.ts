import type { ActionAuthorityResolverV1 } from "./authority-proofs.js";
import { assertDomainTerminalProof } from "./authority-proofs.js";
import { actionIdempotencyKeyDigest, actionIdempotencyScopeDigest } from "./idempotency.js";
import type { ActionFilePersistence, ActionIdempotencyBindingV1 } from "./persistence.js";
import { materializeDispatchRecord } from "./records.js";
import { foldActionAuthority } from "./state.js";
import { assertDispatchHeaderRule, equalCanonical } from "./store-rules.js";
import type { ActionAuthoritySnapshotV1, ApprovalChallengeFrameV1 } from "./types.js";

export function readVerifiedActionSnapshot(
  files: ActionFilePersistence,
  resolver: ActionAuthorityResolverV1 | null,
  proposalId: string,
): ActionAuthoritySnapshotV1 | null {
  const events = files.readAuthority(proposalId);
  if (!events.length) return null;
  const snapshot = foldActionAuthority(events);
  const stored = files.readProposal(proposalId);
  if (!stored || !equalCanonical(stored, snapshot.proposal))
    throw new Error("action authority proposal closure is missing or mismatched");
  const visible = assertVisibleIdempotency(files, snapshot);
  assertConsumedChallenge(files, snapshot, visible);
  assertDispatchAndTerminal(files, resolver, snapshot);
  return snapshot;
}

/** Reads the concrete local WAL/dispatch closure without recursively consulting its domain. */
export function readRecordedActionSnapshot(
  files: ActionFilePersistence,
  proposalId: string,
): ActionAuthoritySnapshotV1 | null {
  const events = files.readAuthority(proposalId);
  if (!events.length) return null;
  const snapshot = foldActionAuthority(events);
  const stored = files.readProposal(proposalId);
  if (!stored || !equalCanonical(stored, snapshot.proposal))
    throw new Error("action authority proposal closure is missing or mismatched");
  const visible = assertVisibleIdempotency(files, snapshot);
  assertConsumedChallenge(files, snapshot, visible);
  assertDispatchAndTerminal(files, null, snapshot, false);
  return snapshot;
}

function assertVisibleIdempotency(
  files: ActionFilePersistence,
  snapshot: ActionAuthoritySnapshotV1,
): ActionIdempotencyBindingV1 {
  if (snapshot.proposal.producer_request_binding.kind !== "canonical-action-request")
    throw new Error("ordinary action authority has no canonical request binding");
  const chains = files.idempotencyChainsForProposal(snapshot.proposal.proposal_id);
  if (chains.length !== 1) throw new Error("action authority has no unique idempotency closure");
  const chain = chains[0];
  const prepared = chain?.[0];
  const visible = chain?.[1];
  if (
    chain?.length !== 2 ||
    prepared?.state !== "prepared" ||
    visible?.state !== "visible" ||
    visible.proposal_digest !== snapshot.proposal.proposal_digest ||
    visible.canonical_request_digest !== snapshot.proposal.producer_request_binding.digest ||
    visible.idempotency_key_digest !==
      actionIdempotencyKeyDigest(snapshot.proposal.idempotency_key) ||
    visible.authority_scope_digest !==
      actionIdempotencyScopeDigest(snapshot.proposal.action_root_locator) ||
    visible.created_at !== snapshot.proposal.created_at ||
    Date.parse(visible.retain_until) < Date.parse(snapshot.proposal.expires_at)
  )
    throw new Error("action authority idempotency closure is not visible or equal");
  return visible;
}

function assertConsumedChallenge(
  files: ActionFilePersistence,
  snapshot: ActionAuthoritySnapshotV1,
  visible: ActionIdempotencyBindingV1,
): void {
  const approval = snapshot.approval;
  if (!approval) return;
  const challenged =
    approval.challenge_class === "fresh-user-scope" ||
    approval.challenge_class === "public-literal";
  if (!challenged) {
    if (approval.challenge_digest !== null)
      throw new Error("unchallenged approval carries a challenge digest");
    return;
  }
  if (!approval.challenge_digest) throw new Error("challenged approval lacks a challenge digest");
  const matches = files.consumedChallengesByDigest(approval.challenge_digest);
  const frame = matches[0];
  if (matches.length !== 1 || !frame)
    throw new Error("approval consumed-challenge closure is missing or mismatched");
  assertConsumedChallengeMatchesVisible(snapshot, visible, frame);
}

export function assertConsumedChallengeMatchesVisible(
  snapshot: ActionAuthoritySnapshotV1,
  visible: ActionIdempotencyBindingV1,
  frame: ApprovalChallengeFrameV1,
): void {
  const approval = snapshot.approval;
  if (
    !approval ||
    frame.proposal_id !== snapshot.proposal.proposal_id ||
    frame.proposal_digest !== snapshot.proposal.proposal_digest ||
    frame.challenge_class !== approval.challenge_class ||
    frame.principal_digest !== visible.principal_digest ||
    frame.consumed_at !== approval.decided_at ||
    frame.approval_expires_at !== approval.expires_at ||
    !equalCanonical(frame.approval_decided_by, approval.decided_by)
  )
    throw new Error("approval consumed-challenge closure is missing or mismatched");
}

function assertDispatchAndTerminal(
  files: ActionFilePersistence,
  resolver: ActionAuthorityResolverV1 | null,
  snapshot: ActionAuthoritySnapshotV1,
  validateTerminal = true,
): void {
  const approval = snapshot.approval;
  if (!approval || approval.decision !== "approved") return;
  const operationId = snapshot.operation_id;
  if (!operationId) return;
  const dispatch = files.readDispatch(operationId);
  if (!dispatch) throw new Error("action operation dispatch closure is missing");
  const expected = materializeDispatchRecord(
    snapshot.proposal,
    approval,
    dispatch.domain_header_digest,
  );
  if (
    !equalCanonical(dispatch, expected) ||
    dispatch.dispatch_record_digest !== snapshot.dispatch_record_digest
  )
    throw new Error("action operation dispatch closure mismatches authority");
  assertDispatchHeaderRule(snapshot.proposal, dispatch.domain_header_digest);
  if (!snapshot.domain_terminal_digest) return;
  const terminalEvent = snapshot.events.at(-1);
  if (!terminalEvent || terminalEvent.payload.kind !== "state-transition")
    throw new Error("action terminal event is missing");
  if (!validateTerminal) return;
  if (!resolver) throw new Error("domain terminal authority resolver is required for read");
  const proof = resolver.validateRecordedTerminal({
    proposal: snapshot.proposal,
    approval,
    dispatch,
    outcome: snapshot.state as "succeeded" | "failed" | "needs_recovery",
    domain_terminal_digest: snapshot.domain_terminal_digest,
    recorded_at: terminalEvent.recorded_at,
  });
  assertDomainTerminalProof(proof, dispatch);
  if (
    proof.outcome !== snapshot.state ||
    proof.domain_terminal_digest !== snapshot.domain_terminal_digest ||
    proof.recorded_at !== terminalEvent.recorded_at
  )
    throw new Error("domain terminal authority does not match action mirror");
}
