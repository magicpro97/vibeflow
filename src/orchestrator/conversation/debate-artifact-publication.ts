import type { EvaluatorOutput, RoundDecision } from "../consensus.js";
import type { StoredTraceEvent } from "../trace/types.js";
import { projectBaselineComparison } from "./baseline.js";
import { CONVERSATION_COMMAND_RESULT_STATUS } from "./conversation-command-result-contract.js";
import {
  CONVERSATION_ARTIFACT_TYPE,
  CONVERSATION_DECISION_OUTCOME,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";
import { projectDecisionMatrix } from "./debate-projection.js";
import type { ConversationContext, ConversationOrchestrationResult } from "./types.js";

export interface DebateTranscriptRoundV1 {
  round_id: string;
  responses: Array<{
    participant_id: string;
    content: string;
    claim: string | null;
    evidence: string[];
  }>;
  blind: EvaluatorOutput;
  full: EvaluatorOutput;
  decision: RoundDecision;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export async function publishDebateArtifacts(input: {
  context: ConversationContext;
  responder_indices: readonly number[];
  journal: readonly StoredTraceEvent[];
  transcript: readonly DebateTranscriptRoundV1[];
}): Promise<ConversationOrchestrationResult> {
  const { context, journal, transcript } = input;
  const matrix = projectDecisionMatrix(journal);
  const comparison = projectBaselineComparison({
    enabled: context.baselineEnabled,
    nonEvaluatorParticipantCount: input.responder_indices.length,
    selectedEngineAvailable:
      context.bindingReadiness[input.responder_indices[0] as number]?.engine_available ?? false,
    decisionMatrix: matrix,
    records: journal,
  });
  const matrixArtifact = await context.createArtifact({
    artifact_type: CONVERSATION_ARTIFACT_TYPE.DECISION_MATRIX,
    content: json(matrix),
    idempotency_key: "debate:artifact:decision-matrix",
  });
  const baselineArtifact = await context.createArtifact({
    artifact_type: CONVERSATION_ARTIFACT_TYPE.SYNTHESIS,
    content: json(comparison),
    idempotency_key: "debate:artifact:baseline-comparison",
  });
  const transcriptArtifact = await context.createArtifact({
    artifact_type: CONVERSATION_ARTIFACT_TYPE.TRANSCRIPT,
    content: json({ rounds: transcript }),
    idempotency_key: "debate:artifact:transcript",
  });
  const lastDecision = transcript.at(-1)?.decision ?? null;
  const synthesisArtifact = await context.createArtifact({
    artifact_type: CONVERSATION_ARTIFACT_TYPE.SYNTHESIS,
    content: json({
      answer: matrix?.rows[0]?.option ?? null,
      consensus_score: lastDecision?.score ?? null,
      outcome: lastDecision?.outcome ?? CONVERSATION_DECISION_OUTCOME.ABORT,
    }),
    idempotency_key: "debate:artifact:final-synthesis",
  });
  await context.emit({
    idempotency_key: "debate:synthesis:completed",
    event: {
      type: CONVERSATION_TRACE_EVENT_KIND.SYNTHESIS_COMPLETED,
      payload: {
        decision_matrix_ref: matrixArtifact.ref,
        baseline_comparison_ref: baselineArtifact.ref,
      },
    },
  });
  return {
    operation_id: context.correlation.operation_id,
    status: CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED,
    artifact_refs: [
      matrixArtifact.ref,
      baselineArtifact.ref,
      transcriptArtifact.ref,
      synthesisArtifact.ref,
    ],
  };
}
