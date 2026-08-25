import type {
  AttemptStartAuthorityRecordV1,
  EngineSessionResult,
  InternalResumeBinding,
} from "../../dispatch/session-types.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";

export function classifyRevisionLaneRetryResult(input: {
  participant: RevisionPreparationPlanV1["participant_starts"][number];
  attemptKey: string;
  result: EngineSessionResult;
  resume: InternalResumeBinding | undefined;
  adapterEvidence: { attemptId: string; internalRef: string } | undefined;
  startAuthority?: AttemptStartAuthorityRecordV1 | null;
  priorNativeSessionIds: ReadonlySet<string>;
}): "accepted" | "uncertain" {
  const accepted = Boolean(
    input.result.attemptId === input.attemptKey &&
      input.result.ok &&
      input.result.state === "completed" &&
      input.resume?.attemptId === input.attemptKey &&
      input.resume.engine === input.participant.engine &&
      input.resume.nativeSessionId.length > 0 &&
      !input.priorNativeSessionIds.has(input.resume.nativeSessionId) &&
      input.adapterEvidence?.attemptId === input.attemptKey &&
      input.startAuthority?.attempt_id === input.attemptKey &&
      input.startAuthority.outcome === "accepted" &&
      input.startAuthority.process_quiescent &&
      input.startAuthority.native_session_id === input.resume.nativeSessionId &&
      input.startAuthority.evidence_ref === input.adapterEvidence.internalRef,
  );
  return accepted ? "accepted" : "uncertain";
}
