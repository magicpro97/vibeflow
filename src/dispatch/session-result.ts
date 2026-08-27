import type { Engine } from "../core.js";
import { CONVERSATION_OPERATION_STATE } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import type { OwnedProcessTerminalKind } from "./owned-process-contract.js";
import type { OwnedProcessReleaseProof } from "./owned-process-runtime.js";
import { parseEngineSummary } from "./prompt.js";
import {
  publicEngineSummary,
  sanitizePublicEngineText,
  sanitizePublicValue,
} from "./public-redaction.js";
import { ENGINE_EVIDENCE_STATUS, ENGINE_NATIVE_SESSION_STATUS } from "./session-contract.js";
import type { SessionStdoutState } from "./session-output.js";
import type {
  EngineSessionResult,
  InternalResumeBinding,
  OperationLifecycleState,
  SpawnOptionsProjection,
} from "./session-types.js";

interface SessionCompletionProjectionInput {
  attemptId: string;
  engine: Engine;
  lifecycle: readonly OperationLifecycleState[];
  state: EngineSessionResult["state"];
  rawReason: string | undefined;
  resume: InternalResumeBinding | undefined;
  privateValues: readonly string[];
  processRelease: OwnedProcessReleaseProof | null | undefined;
  isolationEvidenceRef: string | null;
  provenance: SpawnOptionsProjection["provenance"];
  traceMetadata: SpawnOptionsProjection["trace_metadata"];
  stdout: SessionStdoutState;
  authenticatedTerminal: OwnedProcessTerminalKind | null;
  exitCode: number | null;
}

/** Builds the public result and its byte-identical evidence projection from one terminal snapshot. */
export function projectSessionCompletion(input: SessionCompletionProjectionInput): {
  evidence: Readonly<Record<string, unknown>>;
  result: EngineSessionResult;
} {
  const nativeIds = input.resume?.nativeSessionId ? [input.resume.nativeSessionId] : [];
  const output = input.stdout.publicOutput(nativeIds, input.privateValues);
  const reason = input.rawReason
    ? sanitizePublicEngineText(input.rawReason, nativeIds, input.privateValues)
    : undefined;
  const ok =
    input.state === CONVERSATION_OPERATION_STATE.COMPLETED &&
    (input.authenticatedTerminal !== null || (input.exitCode === 0 && !input.rawReason));
  const nativeSessionStatus = input.resume
    ? ENGINE_NATIVE_SESSION_STATUS.CAPTURED
    : ENGINE_NATIVE_SESSION_STATUS.UNAVAILABLE;
  const evidence = sanitizePublicValue(
    {
      attempt_id: input.attemptId,
      engine: input.engine,
      lifecycle: [...input.lifecycle],
      state: input.state,
      ok,
      reason: reason ?? null,
      native_session_status: nativeSessionStatus,
      process_release: input.processRelease ?? null,
      isolation_evidence_ref: input.isolationEvidenceRef,
      provenance: input.provenance,
      trace_metadata: input.traceMetadata,
    },
    nativeIds,
    input.privateValues,
  );
  return {
    evidence,
    result: {
      attemptId: input.attemptId,
      engine: input.engine,
      ok,
      state: input.state,
      lifecycle: [...input.lifecycle],
      output,
      summary: publicEngineSummary(
        parseEngineSummary(output),
        input.resume?.nativeSessionId,
        input.privateValues,
      ),
      reason,
      evidenceStatus: ENGINE_EVIDENCE_STATUS.PERSISTED,
      nativeSessionStatus,
    },
  };
}
