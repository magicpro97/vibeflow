import type { ActionFilePersistence } from "./persistence.js";
import type { ActionAuthoritySnapshotV1 } from "./types.js";

export function listRecordedActionsForRecovery(
  files: ActionFilePersistence,
  readRecorded: (proposalId: string) => ActionAuthoritySnapshotV1 | null,
): ActionAuthoritySnapshotV1[] {
  return listActionSnapshots(
    files.proposalIds().filter((proposalId) => files.hasVisibleIdempotencyForProposal(proposalId)),
    readRecorded,
  );
}

export function listActionSnapshots(
  proposalIds: readonly string[],
  read: (proposalId: string) => ActionAuthoritySnapshotV1 | null,
): ActionAuthoritySnapshotV1[] {
  return proposalIds
    .map(read)
    .filter((value): value is ActionAuthoritySnapshotV1 => value !== null)
    .sort(
      (left, right) =>
        right.proposal.created_at.localeCompare(left.proposal.created_at) ||
        right.proposal.proposal_id.localeCompare(left.proposal.proposal_id),
    );
}
