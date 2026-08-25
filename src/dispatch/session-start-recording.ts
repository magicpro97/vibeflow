import type { Engine } from "../core.js";
import { type AttemptEvidenceReservation, persistFailedAttemptEvidence } from "./attempt-handle.js";
import { sanitizePublicValue } from "./public-redaction.js";
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
  engine: Engine | "unknown";
  lifecycle: readonly OperationLifecycleState[];
  nativeSessionId: string | undefined;
  privateValues: readonly string[];
  reservation: AttemptEvidenceReservation | undefined;
  evidence: { attemptId: string; internalRef: string } | undefined;
  writer: EngineSessionAdapterOptions["writeEvidence"];
  failure: Error;
  outcome: "proved-absent" | "unknown";
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
      native_session_status: "unavailable",
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
  if (input.engine === "unknown" || !binding) return binding;
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
    input.result.state === "completed" &&
    input.lifecycle.includes("acknowledged") &&
    resume?.attemptId === input.result.attemptId &&
    resume.engine === input.result.engine;
  const provedAbsent =
    !input.lifecycle.includes("acknowledged") &&
    !resume &&
    !input.result.ok &&
    input.result.state === "ambiguous";
  input.store.record({
    attempt_id: input.result.attemptId,
    engine: input.result.engine,
    outcome: accepted ? "accepted" : provedAbsent ? "proved-absent" : "unknown",
    native_session_id: accepted && resume ? resume.nativeSessionId : null,
    evidence_ref: input.evidence.internalRef,
  });
}
