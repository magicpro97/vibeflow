import { PUBLIC_OPERATION_PARTICIPANT_START_PHASE } from "../../actions/protocol-contract.js";
import { ENGINE_ATTEMPT_START_OUTCOME } from "../../dispatch/session-contract.js";
import type { DurableAttemptStartAuthorityReaderV1 } from "../../dispatch/session-types.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import type { RevisionLaneEvidenceStore } from "./revision-lane-evidence-store.js";
import {
  type ParticipantStartReceiptV1,
  participantStartReceiptEvidence,
} from "./revision-participant-receipt.js";
import { readRevisionStartAuthority } from "./revision-start-authority.js";

/** Re-resolves the concrete adapter record behind one terminal/accepted lane receipt. */
export function revisionLaneReceiptIsProved(input: {
  evidence: RevisionLaneEvidenceStore;
  reader: DurableAttemptStartAuthorityReaderV1 | undefined;
  operation: RevisionOperationV1;
  participant: RevisionPreparationPlanV1["participant_starts"][number];
  receipt: ParticipantStartReceiptV1;
}): boolean {
  const binding = participantStartReceiptEvidence(input.receipt);
  const authority = readRevisionStartAuthority({
    reader: input.reader,
    attemptKey: input.receipt.attempt_key,
    participant: input.participant,
  });
  if (input.receipt.participant_id !== input.participant.participant_id || !authority) return false;
  if (input.receipt.state === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED)
    return (
      !binding &&
      authority.outcome === ENGINE_ATTEMPT_START_OUTCOME.PROVED_ABSENT &&
      authority.native_session_id === null
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
  if (
    input.receipt.state === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED ||
    input.receipt.state === PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCELED
  )
    return (
      authority.outcome === ENGINE_ATTEMPT_START_OUTCOME.ACCEPTED &&
      authority.native_session_id !== null
    );
  return false;
}
