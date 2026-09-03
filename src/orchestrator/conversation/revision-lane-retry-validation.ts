import { PUBLIC_OPERATION_PARTICIPANT_START_PHASE } from "../../actions/protocol-contract.js";
import { ENGINE_ATTEMPT_START_OUTCOME } from "../../dispatch/session-contract.js";
import type {
  AttemptStartAuthorityRecordV1,
  EngineSessionResult,
  InternalResumeBinding,
} from "../../dispatch/session-types.js";
import { CONVERSATION_OPERATION_STATE } from "./conversation-public-wire-contract.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";

export function classifyRevisionLaneRetryResult(input: {
  participant: RevisionPreparationPlanV1["participant_starts"][number];
  attemptKey: string;
  result: EngineSessionResult;
  resume: InternalResumeBinding | undefined;
  adapterEvidence: { attemptId: string; internalRef: string } | undefined;
  startAuthority?: AttemptStartAuthorityRecordV1 | null;
  priorNativeSessionIds: ReadonlySet<string>;
}):
  | typeof PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED
  | typeof PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN {
  const accepted = Boolean(
    input.result.attemptId === input.attemptKey &&
      input.result.ok &&
      input.result.state === CONVERSATION_OPERATION_STATE.COMPLETED &&
      input.resume?.attemptId === input.attemptKey &&
      input.resume.engine === input.participant.engine &&
      input.resume.nativeSessionId.length > 0 &&
      !input.priorNativeSessionIds.has(input.resume.nativeSessionId) &&
      input.adapterEvidence?.attemptId === input.attemptKey &&
      input.startAuthority?.attempt_id === input.attemptKey &&
      input.startAuthority.outcome === ENGINE_ATTEMPT_START_OUTCOME.ACCEPTED &&
      input.startAuthority.process_quiescent &&
      input.startAuthority.native_session_id === input.resume.nativeSessionId &&
      input.startAuthority.evidence_ref === input.adapterEvidence.internalRef,
  );
  return accepted
    ? PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED
    : PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN;
}
