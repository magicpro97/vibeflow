import { ActionConflictError } from "./errors.js";
import type { ActionFilePersistence } from "./persistence.js";
import { materializeAuthorityEvent } from "./records.js";
import { foldActionAuthority } from "./state.js";
import {
  assertRequestAuthority,
  equalCanonical,
  isAgentProposalBrowserController,
  requireOwnedSnapshot,
} from "./store-rules.js";
import type { ActionAuthoritySnapshotV1, ActionRequestAuthorityV1 } from "./types.js";

export interface CancelActionInputV1 {
  proposal_id: string;
  proposal_digest: string;
  authority: ActionRequestAuthorityV1;
  reason: string | null;
}

function iso(epoch: number): string {
  if (!Number.isSafeInteger(epoch)) throw new Error("invalid action clock");
  return new Date(epoch).toISOString();
}

export function cancelAction(
  files: ActionFilePersistence,
  get: (proposalId: string) => ActionAuthoritySnapshotV1 | null,
  now: () => number,
  input: CancelActionInputV1,
): ActionAuthoritySnapshotV1 {
  assertRequestAuthority(input.authority);
  if (
    input.reason !== null &&
    (typeof input.reason !== "string" ||
      Buffer.byteLength(input.reason, "utf8") > 512 ||
      /\p{Cc}/u.test(input.reason))
  )
    throw new Error("invalid cancellation reason");
  return files.withLock(`action-cancel:${input.proposal_id}`, (lock) => {
    const snapshot = requireOwnedSnapshot(
      files,
      get,
      input.proposal_id,
      input.proposal_digest,
      input.authority,
    );
    if (
      !equalCanonical(snapshot.proposal.requested_by, input.authority.actor) &&
      !isAgentProposalBrowserController(snapshot.proposal, input.authority)
    )
      throw new ActionConflictError(
        "stale_proposal",
        "Cancellation actor does not control this proposal.",
        input.proposal_id,
      );
    if (snapshot.state === "canceled") return snapshot;
    if (snapshot.state !== "pending_review" && snapshot.state !== "approved")
      throw new ActionConflictError(
        "stale_proposal",
        "Proposal can no longer be canceled.",
        input.proposal_id,
      );
    const event = materializeAuthorityEvent(
      snapshot.proposal,
      snapshot.events.length,
      snapshot.events.at(-1)?.event_digest ?? null,
      {
        kind: "state-transition",
        from: snapshot.state,
        to: "canceled",
        operation_id: null,
        dispatch_record_digest: null,
        domain_terminal_digest: null,
        reason_code: input.reason === null ? "caller-canceled" : "caller-canceled-with-reason",
      },
      iso(now()),
    );
    files.appendAuthority(lock, event);
    return foldActionAuthority([...snapshot.events, event]);
  });
}
