import { type EvaluatorOutput, decideRound } from "../consensus.js";
import {
  debateBlindEvaluatorPrompt,
  debateFullEvaluatorPrompt,
  parseDebateEvaluatorOutput,
  parseDebateParticipantOutput,
} from "../debate.js";
import type { StoredTraceEvent } from "../trace/types.js";
import { persistBaselineResult, projectBaselineComparison } from "./baseline.js";
import type { AgentSocialIntentRequestV1 } from "./conversation-interaction-types.js";
import { projectDecisionMatrix } from "./debate-projection.js";
import { publishDebateParticipantResponse } from "./debate-response-publication.js";
import type {
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
  PolicyAttempt,
} from "./types.js";

interface ParticipantRoundResult {
  participantId: string;
  attempt: PolicyAttempt;
  answer: string;
  content: string;
  claim: string | null;
  evidence: string[];
  socialIntent: AgentSocialIntentRequestV1;
}

interface TranscriptRound {
  round_id: string;
  responses: Array<{
    participant_id: string;
    content: string;
    claim: string | null;
    evidence: string[];
  }>;
  blind: EvaluatorOutput;
  full: EvaluatorOutput;
  decision: ReturnType<typeof decideRound>;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const failed = (
  context: ConversationContext,
  status: "failed" | "aborted" = "failed",
): ConversationOrchestrationResult => ({
  operation_id: context.correlation.operation_id,
  status,
  artifact_refs: [],
});

async function coordinatorError(
  context: ConversationContext,
  code: string,
  message: string,
): Promise<void> {
  await context.emit({
    idempotency_key: `debate:error:${code}`,
    event: { type: "error", payload: { agent_id: null, code, message } },
  });
}

async function attemptFailure(
  attempt: PolicyAttempt,
  key: string,
  participantId: string,
  code: string,
  message: string,
): Promise<void> {
  await attempt.emit({
    idempotency_key: key,
    event: { type: "error", payload: { agent_id: participantId, code, message } },
  });
}

/** Real multi-agent debate policy; the runtime remains the sole attempt/trace/artifact authority. */
export class DebateConversationPolicy implements ConversationPolicy {
  readonly name = "debate";

  async dryRun(context: ConversationContext): Promise<DryRunResult> {
    const engines = new Set<(typeof context.bindings)[number]["engine"]>();
    const participants = context.bindings.map((binding, index) => {
      const readiness = context.bindingReadiness[index];
      if (readiness?.engine_available) engines.add(binding.engine);
      return {
        participant_id: context.participantIds[index] ?? "",
        role_ref: binding.role.spec.name,
        engine: binding.engine,
        model: binding.model,
        engine_available: readiness?.engine_available ?? false,
        model_valid: readiness?.model_valid ?? false,
      };
    });
    return {
      participants,
      evaluator_auto_added: context.evaluatorAutoAdded,
      engines_available: [...engines],
      models_valid:
        context.bindings.length > 0 &&
        context.bindings.every((_binding, index) => context.bindingReadiness[index]?.model_valid),
    };
  }

  async execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    const evaluatorIndices = context.bindings
      .map((binding, index) => (binding.role.spec.name === "brainstorm-evaluator" ? index : -1))
      .filter((index) => index >= 0);
    const responders = context.bindings
      .map((binding, index) => (binding.role.spec.name !== "brainstorm-evaluator" ? index : -1))
      .filter((index) => index >= 0);
    if (evaluatorIndices.length !== 1) {
      await coordinatorError(
        context,
        "invalid_evaluator_count",
        "debate requires exactly one evaluator",
      );
      return failed(context);
    }
    if (responders.length < 2) {
      await coordinatorError(
        context,
        "insufficient_participants",
        "debate requires at least two non-evaluator participants",
      );
      return failed(context);
    }
    const evaluatorIndex = evaluatorIndices[0] as number;
    const evaluatorId = context.participantIds[evaluatorIndex];
    if (!evaluatorId) {
      await coordinatorError(context, "invalid_evaluator_count", "evaluator identity is missing");
      return failed(context);
    }
    const journal: StoredTraceEvent[] = [];
    journal.push(await persistBaselineResult(context, responders[0] as number));
    if (context.signal.aborted) return failed(context, "aborted");

    const transcript: TranscriptRound[] = [];
    for (let round = 1; round <= context.maxRounds; round += 1) {
      const roundId = `round-${round}`;
      journal.push(
        await context.emit({
          idempotency_key: `debate:round:${round}:start`,
          event: { type: "round_boundary", payload: { round_id: roundId, phase: "start" } },
        }),
      );
      const participants = await this.runParticipants(context, responders, round);
      if (!participants) return failed(context, context.signal.aborted ? "aborted" : "failed");
      for (const participant of participants) {
        journal.push(
          await participant.attempt.emit({
            idempotency_key: `debate:round:${round}:participant:${participant.participantId}:precommit`,
            event: {
              type: "precommit",
              payload: {
                round_id: roundId,
                participant_id: participant.participantId,
                answer: participant.answer,
                evidence: participant.evidence,
              },
            },
          }),
        );
      }
      const blind = await this.evaluate(
        context,
        evaluatorIndex,
        evaluatorId,
        round,
        "blind",
        debateBlindEvaluatorPrompt(
          participants.map(({ answer, evidence }) => ({ answer, evidence })),
        ),
        journal,
      );
      if (!blind) return failed(context, context.signal.aborted ? "aborted" : "failed");
      for (const participant of participants) {
        journal.push(await publishDebateParticipantResponse(context, round, participant));
      }
      const positions = participants.map(({ claim, evidence }) => ({ claim, evidence }));
      const full = await this.evaluate(
        context,
        evaluatorIndex,
        evaluatorId,
        round,
        "full",
        debateFullEvaluatorPrompt(blind, positions),
        journal,
      );
      if (!full) return failed(context, context.signal.aborted ? "aborted" : "failed");
      const decision = decideRound(full, round, context.maxRounds);
      if (decision.outcome === "abort") {
        await coordinatorError(
          context,
          "invalid_assessment",
          "evaluator returned an invalid full assessment",
        );
        return failed(context);
      }
      journal.push(
        await context.emit({
          idempotency_key: `debate:round:${round}:consensus`,
          event: { type: "consensus_update", payload: { round_id: roundId, decision } },
        }),
        await context.emit({
          idempotency_key: `debate:round:${round}:end`,
          event: { type: "round_boundary", payload: { round_id: roundId, phase: "end" } },
        }),
      );
      transcript.push({
        round_id: roundId,
        responses: participants.map(({ participantId, content, claim, evidence }) => ({
          participant_id: participantId,
          content,
          claim,
          evidence,
        })),
        blind,
        full,
        decision,
      });
      if (decision.outcome !== "continue") break;
    }
    return this.publishArtifacts(context, responders, journal, transcript);
  }

  private async runParticipants(
    context: ConversationContext,
    indices: readonly number[],
    round: number,
  ): Promise<ParticipantRoundResult[] | null> {
    const launched = await Promise.all(
      indices.map(async (bindingIndex) => {
        const participantId = context.participantIds[bindingIndex] as string;
        const delivery = await context.prepareTurn({
          participant_id: participantId,
          instruction: { kind: "debate-participant", topic: context.topic, round },
        });
        const attempt = context.launchAttempt({
          participantId,
          bindingIndex,
          purpose: "participant",
          promptInput: delivery.prompt_input,
          delivery,
        });
        return { participantId, attempt };
      }),
    );
    const results = await Promise.all(launched.map(({ attempt }) => attempt.completion));
    const failedIndex = results.findIndex((result) => !result.ok || result.state !== "completed");
    if (failedIndex >= 0) {
      const failedAttempt = launched[failedIndex] as (typeof launched)[number];
      const result = results[failedIndex];
      await attemptFailure(
        failedAttempt.attempt,
        `debate:round:${round}:participant:${failedAttempt.participantId}:error`,
        failedAttempt.participantId,
        "participant_attempt_failed",
        result?.reason ?? "participant attempt failed",
      );
      return null;
    }
    return launched.map(({ participantId, attempt }, index) => {
      const parsed = parseDebateParticipantOutput(
        (results[index] as NonNullable<(typeof results)[number]>).output,
      );
      return {
        participantId,
        attempt,
        answer: parsed.answer,
        content: parsed.content,
        claim: parsed.claim,
        evidence: parsed.evidence,
        socialIntent: parsed.social_intent,
      };
    });
  }

  private async evaluate(
    context: ConversationContext,
    bindingIndex: number,
    participantId: string,
    round: number,
    stage: "blind" | "full",
    promptInput: string,
    journal: StoredTraceEvent[],
  ): Promise<EvaluatorOutput | null> {
    const attempt = context.launchAttempt({
      participantId,
      bindingIndex,
      purpose: "evaluator",
      promptInput,
    });
    const result = await attempt.completion;
    if (!result.ok || result.state !== "completed") {
      await attemptFailure(
        attempt,
        `debate:round:${round}:evaluator:${stage}:error`,
        participantId,
        "evaluator_attempt_failed",
        result.reason ?? "evaluator attempt failed",
      );
      return null;
    }
    const assessment = parseDebateEvaluatorOutput(
      result.output,
      stage === "blind" ? 1 : round,
      stage === "blind" ? Math.max(1, context.maxRounds) : context.maxRounds,
    );
    if (!assessment) {
      await coordinatorError(
        context,
        "invalid_assessment",
        `evaluator returned an invalid ${stage} assessment`,
      );
      return null;
    }
    journal.push(
      await attempt.emit({
        idempotency_key: `debate:round:${round}:evaluator:${stage}`,
        event: {
          type: "evaluator_assessment",
          payload: { round_id: `round-${round}`, stage, assessment },
        },
      }),
    );
    return assessment;
  }

  private async publishArtifacts(
    context: ConversationContext,
    responders: readonly number[],
    journal: readonly StoredTraceEvent[],
    transcript: readonly TranscriptRound[],
  ): Promise<ConversationOrchestrationResult> {
    const matrix = projectDecisionMatrix(journal);
    const comparison = projectBaselineComparison({
      enabled: context.baselineEnabled,
      nonEvaluatorParticipantCount: responders.length,
      selectedEngineAvailable:
        context.bindingReadiness[responders[0] as number]?.engine_available ?? false,
      decisionMatrix: matrix,
      records: journal,
    });
    const matrixArtifact = await context.createArtifact({
      artifact_type: "decision_matrix",
      content: json(matrix),
      idempotency_key: "debate:artifact:decision-matrix",
    });
    const baselineArtifact = await context.createArtifact({
      artifact_type: "synthesis",
      content: json(comparison),
      idempotency_key: "debate:artifact:baseline-comparison",
    });
    const transcriptArtifact = await context.createArtifact({
      artifact_type: "transcript",
      content: json({ rounds: transcript }),
      idempotency_key: "debate:artifact:transcript",
    });
    const lastDecision = transcript.at(-1)?.decision ?? null;
    const synthesisArtifact = await context.createArtifact({
      artifact_type: "synthesis",
      content: json({
        answer: matrix?.rows[0]?.option ?? null,
        consensus_score: lastDecision?.score ?? null,
        outcome: lastDecision?.outcome ?? "abort",
      }),
      idempotency_key: "debate:artifact:final-synthesis",
    });
    await context.emit({
      idempotency_key: "debate:synthesis:completed",
      event: {
        type: "synthesis_completed",
        payload: {
          decision_matrix_ref: matrixArtifact.ref,
          baseline_comparison_ref: baselineArtifact.ref,
        },
      },
    });
    return {
      operation_id: context.correlation.operation_id,
      status: "completed",
      artifact_refs: [
        matrixArtifact.ref,
        baselineArtifact.ref,
        transcriptArtifact.ref,
        synthesisArtifact.ref,
      ],
    };
  }
}
