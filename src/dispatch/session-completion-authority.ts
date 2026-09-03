import type { Engine } from "../core.js";
import { CONVERSATION_OPERATION_STATE } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import type { AttemptEvidenceReservation } from "./attempt-handle.js";
import { ENGINE_SESSION_PROTOCOL, supportsExactNativeSessionResume } from "./session-contract.js";
import { recordCompletedStartOutcome } from "./session-start-recording.js";
import type {
  EngineSessionAdapterOptions,
  EngineSessionResult,
  InternalAuthenticatedModelOutputBinding,
  InternalResumeBinding,
  OperationLifecycleState,
} from "./session-types.js";
import type { AttemptStartAuthorityStore } from "./start-authority.js";

export async function finalizeSessionCompletionAuthority(input: {
  attemptId: string;
  engine: Engine;
  state: EngineSessionResult["state"];
  protocol: EngineSessionAdapterOptions["protocol"];
  requestedResumeId: string | undefined;
  resume: InternalResumeBinding | undefined;
  internalModelOutput: string | undefined;
  evidence: Readonly<Record<string, unknown>>;
  evidenceBinding: { attemptId: string; internalRef: string } | undefined;
  reservation: AttemptEvidenceReservation | undefined;
  writeEvidence: EngineSessionAdapterOptions["writeEvidence"];
  recordStartOutcome: boolean;
  startAuthorityStore: AttemptStartAuthorityStore;
  result: EngineSessionResult;
  lifecycle: readonly OperationLifecycleState[];
}): Promise<{
  evidenceBinding: { attemptId: string; internalRef: string } | undefined;
  modelOutputBinding: InternalAuthenticatedModelOutputBinding | undefined;
}> {
  let evidenceBinding = input.evidenceBinding;
  if (input.reservation) input.reservation.finalize(input.evidence);
  else if (input.writeEvidence) {
    const internalRef = await input.writeEvidence(input.attemptId, input.evidence);
    evidenceBinding = { attemptId: input.attemptId, internalRef };
  }
  if (input.recordStartOutcome)
    recordCompletedStartOutcome({
      store: input.startAuthorityStore,
      result: input.result,
      lifecycle: input.lifecycle,
      resume: input.resume,
      evidence: evidenceBinding,
    });
  const capturedIdentity =
    input.resume?.attemptId === input.attemptId && input.resume.engine === input.engine
      ? input.resume.nativeSessionId
      : undefined;
  const exactIdentityValid =
    !supportsExactNativeSessionResume(input.engine) ||
    (capturedIdentity !== undefined &&
      (input.requestedResumeId === undefined || capturedIdentity === input.requestedResumeId));
  const modelOutputBinding =
    input.state === CONVERSATION_OPERATION_STATE.COMPLETED &&
    input.protocol !== ENGINE_SESSION_PROTOCOL.BRIDGE &&
    exactIdentityValid &&
    input.internalModelOutput !== undefined
      ? Object.freeze({
          attemptId: input.attemptId,
          engine: input.engine,
          nativeSessionId: capturedIdentity ?? null,
          output: input.internalModelOutput,
        })
      : undefined;
  return { evidenceBinding, modelOutputBinding };
}
