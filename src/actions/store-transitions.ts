import type { ProcessLock } from "../durability/index.js";
import {
  type ActionAuthorityResolverV1,
  ActionAuthorityStaleError,
  type ReviewAuthorityProofV1,
  assertReviewAuthorityProof,
} from "./authority-proofs.js";
import { ActionConflictError } from "./errors.js";
import type { ActionFilePersistence } from "./persistence.js";
import { materializeAuthorityEvent } from "./records.js";
import type {
  ActionApprovalV1,
  ActionAuthoritySnapshotV1,
  ActionRequestAuthorityV1,
} from "./types.js";

export function requireResolver(
  resolver: ActionAuthorityResolverV1 | null,
): ActionAuthorityResolverV1 {
  if (!resolver)
    throw new Error("typed action authority resolver is required for review or dispatch");
  return resolver;
}

export function revalidateReview(
  files: ActionFilePersistence,
  resolver: ActionAuthorityResolverV1 | null,
  nowEpoch: number,
  snapshot: ActionAuthoritySnapshotV1,
  authority: ActionRequestAuthorityV1,
  decision: "approved" | "denied",
  lock: ProcessLock,
): ReviewAuthorityProofV1 {
  const now = iso(nowEpoch);
  if (Date.parse(snapshot.proposal.expires_at) <= Date.parse(now)) {
    appendProposalTerminal(files, lock, snapshot, "expired", now, "proposal-expired");
    throw new ActionConflictError(
      "stale_proposal",
      "Proposal expired before review.",
      snapshot.proposal.proposal_id,
    );
  }
  try {
    const proof = requireResolver(resolver).review({
      proposal: snapshot.proposal,
      authority,
      decision,
      now,
    });
    assertReviewAuthorityProof(proof, snapshot.proposal, authority, now);
    return proof;
  } catch (error) {
    handleStaleResolver(files, lock, snapshot, error);
  }
}

export function appendApproval(
  files: ActionFilePersistence,
  lock: ProcessLock,
  snapshot: ActionAuthoritySnapshotV1,
  approval: ActionApprovalV1,
): void {
  files.appendAuthority(
    lock,
    materializeAuthorityEvent(
      snapshot.proposal,
      snapshot.events.length,
      snapshot.events.at(-1)?.event_digest ?? null,
      {
        kind: "approval-decision",
        from: "pending_review",
        to: approval.decision === "approved" ? "approved" : "denied",
        approval,
      },
      approval.decided_at,
    ),
  );
}

export function assertDispatchLease(
  files: ActionFilePersistence,
  lock: ProcessLock,
  snapshot: ActionAuthoritySnapshotV1,
  now: string,
): void {
  const expiry = Math.min(
    Date.parse(snapshot.proposal.expires_at),
    Date.parse(snapshot.approval?.expires_at ?? ""),
  );
  if (!Number.isFinite(expiry) || expiry <= Date.parse(now)) {
    appendProposalTerminal(files, lock, snapshot, "expired", now, "approval-expired");
    throw new ActionConflictError(
      "stale_proposal",
      "Approval expired before dispatch.",
      snapshot.proposal.proposal_id,
    );
  }
}

export function handleStaleResolver(
  files: ActionFilePersistence,
  lock: ProcessLock,
  snapshot: ActionAuthoritySnapshotV1,
  error: unknown,
): never {
  if (!(error instanceof ActionAuthorityStaleError)) throw error;
  appendProposalTerminal(files, lock, snapshot, "stale", error.recorded_at, error.reason_code);
  throw new ActionConflictError(
    "stale_proposal",
    "Proposal authority changed before commit.",
    snapshot.proposal.proposal_id,
  );
}

export function appendProposalTerminal(
  files: ActionFilePersistence,
  lock: ProcessLock,
  snapshot: ActionAuthoritySnapshotV1,
  to: "expired" | "stale",
  recordedAt: string,
  reasonCode: string,
): void {
  if (snapshot.state !== "pending_review" && snapshot.state !== "approved")
    throw new Error("proposal-only terminal transition has an invalid source");
  const previousAt = Date.parse(
    snapshot.events.at(-1)?.recorded_at ?? snapshot.proposal.created_at,
  );
  if (Date.parse(recordedAt) < previousAt)
    throw new Error("proposal terminal authority timestamp regressed");
  files.appendAuthority(
    lock,
    materializeAuthorityEvent(
      snapshot.proposal,
      snapshot.events.length,
      snapshot.events.at(-1)?.event_digest ?? null,
      {
        kind: "state-transition",
        from: snapshot.state,
        to,
        operation_id: null,
        dispatch_record_digest: null,
        domain_terminal_digest: null,
        reason_code: reasonCode,
      },
      recordedAt,
    ),
  );
}

function iso(epoch: number): string {
  if (!Number.isSafeInteger(epoch)) throw new Error("invalid action clock");
  return new Date(epoch).toISOString();
}
