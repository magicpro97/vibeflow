import type {
  AttemptStartAuthorityRecordV1,
  InternalResumeBinding,
} from "../../dispatch/session-types.js";
import type { InitialRevisionLaneTokenV1 } from "./revision-initial-lane-authority.js";
import type { RevisionLaneEvidenceStore } from "./revision-lane-evidence-store.js";
import type { ParticipantStartReceiptV1 } from "./revision-participant-receipt.js";
import type { RevisionOperationEventV1 } from "./revision-planner.js";

export function latestRevisionLaneReceipts(events: readonly RevisionOperationEventV1[]) {
  const latest = new Map<string, ParticipantStartReceiptV1>();
  for (const event of events)
    if (event.payload.kind === "participant-start")
      latest.set(event.payload.receipt.participant_id, event.payload.receipt);
  return latest;
}

export function writeInitialRevisionLaneEvidence(input: {
  store: RevisionLaneEvidenceStore;
  token: InitialRevisionLaneTokenV1;
  authority: AttemptStartAuthorityRecordV1;
  resume: InternalResumeBinding | null;
  recordedAt: string;
}): { ref: string | null; digest: string | null } {
  return input.store.write({
    root_session_id: input.token.operation.root_session_id,
    operation_id: input.token.operation.operation_id,
    participant_id: input.token.participant.participant_id,
    start_generation: 0,
    attempt_key: input.token.attempt_key,
    native_session_id: input.resume?.nativeSessionId ?? input.authority.native_session_id,
    adapter_evidence_ref: input.authority.record_digest,
    reconciliation_mode: input.token.participant.reconciliation_mode,
    adapter_reference_utf8: input.authority.evidence_ref,
    absence_proved: input.authority.outcome === "proved-absent",
    recorded_at: input.recordedAt,
  });
}
