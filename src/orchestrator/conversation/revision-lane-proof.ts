import type { DurableAttemptStartAuthorityReaderV1 } from "../../dispatch/session-types.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import type { RevisionLaneEvidenceStore } from "./revision-lane-evidence-store.js";
import type { ParticipantStartReceiptV1 } from "./revision-participant-receipt.js";
import { readRevisionStartAuthority } from "./revision-start-authority.js";

function receiptEvidence(receipt: ParticipantStartReceiptV1) {
  const ref = receipt.private_native_session_ref ?? receipt.private_process_lease_ref;
  const digest =
    receipt.private_native_session_producer_receipt_digest ??
    receipt.private_process_lease_producer_receipt_digest;
  return ref && digest ? { ref, digest } : null;
}

/** Re-resolves the concrete adapter record behind one terminal/accepted lane receipt. */
export function revisionLaneReceiptIsProved(input: {
  evidence: RevisionLaneEvidenceStore;
  reader: DurableAttemptStartAuthorityReaderV1 | undefined;
  operation: RevisionOperationV1;
  participant: RevisionPreparationPlanV1["participant_starts"][number];
  receipt: ParticipantStartReceiptV1;
}): boolean {
  const binding = receiptEvidence(input.receipt);
  const authority = readRevisionStartAuthority({
    reader: input.reader,
    attemptKey: input.receipt.attempt_key,
    participant: input.participant,
  });
  if (input.receipt.participant_id !== input.participant.participant_id || !authority) return false;
  if (input.receipt.state === "failed")
    return (
      !binding && authority.outcome === "proved-absent" && authority.native_session_id === null
    );
  if (!binding) return false;
  const evidence = input.evidence.read(binding.ref, binding.digest);
  if (
    !evidence ||
    evidence.operation_id !== input.operation.operation_id ||
    evidence.participant_id !== input.receipt.participant_id ||
    evidence.start_generation !== input.receipt.start_generation ||
    evidence.attempt_key !== input.receipt.attempt_key ||
    evidence.adapter_evidence_ref !== authority.record_digest ||
    evidence.native_session_id !== authority.native_session_id
  )
    return false;
  if (input.receipt.state === "accepted" || input.receipt.state === "canceled")
    return authority.outcome === "accepted" && authority.native_session_id !== null;
  return false;
}
