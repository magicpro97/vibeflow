import type { Engine } from "../core.js";
import { CONVERSATION_OPERATION_STATE } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { type AttemptEvidenceReservation, persistFailedAttemptEvidence } from "./attempt-handle.js";
import { sanitizePublicValue } from "./public-redaction.js";
import {
  ENGINE_ATTEMPT_START_OUTCOME,
  ENGINE_IDENTITY,
  ENGINE_NATIVE_SESSION_STATUS,
  type EngineAttemptStartOutcome,
} from "./session-contract.js";
import type {
  EngineSessionResult,
  InternalResumeBinding,
  OperationLifecycleState,
} from "./session-types.js";
import type { EngineSessionAdapterOptions } from "./session-types.js";
import type { AttemptStartAuthorityStore } from "./start-authority.js";

export function persistSynchronousStartFailure(input: {
  store: AttemptStartAuthorityStore;
  attemptId: string;
  engine: Engine | typeof ENGINE_IDENTITY.UNKNOWN;
  lifecycle: readonly OperationLifecycleState[];
  nativeSessionId: string | undefined;
  privateValues: readonly string[];
  reservation: AttemptEvidenceReservation | undefined;
  evidence: { attemptId: string; internalRef: string } | undefined;
  writer: EngineSessionAdapterOptions["writeEvidence"];
  failure: Error;
  outcome: Exclude<EngineAttemptStartOutcome, typeof ENGINE_ATTEMPT_START_OUTCOME.ACCEPTED>;
}): { attemptId: string; internalRef: string } | undefined {
  let binding = input.evidence;
  const evidence = sanitizePublicValue(
    {
      attempt_id: input.attemptId,
      engine: input.engine,
      lifecycle: [...input.lifecycle],
      state: "engine_start",
      error_kind: "engine_start",
      ok: false,
      reason: input.failure.message,
      native_session_status: ENGINE_NATIVE_SESSION_STATUS.UNAVAILABLE,
    },
    input.nativeSessionId ? [input.nativeSessionId] : [],
    input.privateValues,
  );
  persistFailedAttemptEvidence(
    input.reservation,
    input.writer,
    input.attemptId,
    evidence,
    (ref) => {
      binding = { attemptId: input.attemptId, internalRef: ref };
    },
  );
  if (input.engine === ENGINE_IDENTITY.UNKNOWN || !binding) return binding;
  input.store.record({
    attempt_id: input.attemptId,
    engine: input.engine,
    outcome: input.outcome,
    native_session_id: null,
    evidence_ref: binding.internalRef,
  });
  return binding;
}

export function recordCompletedStartOutcome(input: {
  store: AttemptStartAuthorityStore;
  result: EngineSessionResult;
  lifecycle: readonly OperationLifecycleState[];
  resume: InternalResumeBinding | undefined;
  evidence: { attemptId: string; internalRef: string } | undefined;
}): void {
  if (input.evidence?.attemptId !== input.result.attemptId) return;
  const resume = input.resume;
  const accepted =
    input.result.ok &&
    input.result.state === CONVERSATION_OPERATION_STATE.COMPLETED &&
    input.lifecycle.includes(CONVERSATION_OPERATION_STATE.ACKNOWLEDGED) &&
    resume?.attemptId === input.result.attemptId &&
    resume.engine === input.result.engine;
  const provedAbsent =
    !input.lifecycle.includes(CONVERSATION_OPERATION_STATE.ACKNOWLEDGED) &&
    !resume &&
    !input.result.ok &&
    input.result.state === CONVERSATION_OPERATION_STATE.AMBIGUOUS;
  input.store.record({
    attempt_id: input.result.attemptId,
    engine: input.result.engine,
    outcome: accepted
      ? ENGINE_ATTEMPT_START_OUTCOME.ACCEPTED
      : provedAbsent
        ? ENGINE_ATTEMPT_START_OUTCOME.PROVED_ABSENT
        : ENGINE_ATTEMPT_START_OUTCOME.UNKNOWN,
    native_session_id: accepted && resume ? resume.nativeSessionId : null,
    evidence_ref: input.evidence.internalRef,
  });
}
