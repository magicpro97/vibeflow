import { type EvaluatorOutput, decideRound } from "../consensus.js";
import {
  debateBlindEvaluatorPrompt,
  debateFullEvaluatorPrompt,
  parseDebateEvaluatorOutput,
  parseDebateParticipantOutput,
} from "../debate.js";
import type { AgentActionCandidateOutput } from "../debate.js";
import type { StoredTraceEvent } from "../trace/types.js";
import { persistBaselineResult } from "./baseline.js";
import {
  CONVERSATION_COMMAND_FAILURE_STATUS,
  type ConversationCommandFailureStatus,
} from "./conversation-command-result-contract.js";
import type { AgentSocialIntentRequestV1 } from "./conversation-interaction-types.js";
import {
  CONVERSATION_ASSESSMENT_STAGE,
  CONVERSATION_DECISION_OUTCOME,
  CONVERSATION_INVALID_ASSESSMENT_REASON,
  CONVERSATION_OPERATION_STATE,
  CONVERSATION_ROUND_PHASE,
  CONVERSATION_TRACE_EVENT_KIND,
  type ConversationAssessmentStageV1,
} from "./conversation-public-wire-contract.js";
import {
  type DebateTranscriptRoundV1,
  publishDebateArtifacts,
} from "./debate-artifact-publication.js";
import { publishDebateParticipantResponse } from "./debate-response-publication.js";
import { CONVERSATION_TURN_INSTRUCTION_KIND } from "./turn-delivery-contract.js";
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
  actionCandidate?: AgentActionCandidateOutput;
}

const failed = (
  context: ConversationContext,
  status: ConversationCommandFailureStatus = CONVERSATION_COMMAND_FAILURE_STATUS.FAILED,
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
    event: {
      type: CONVERSATION_TRACE_EVENT_KIND.ERROR,
      payload: { agent_id: null, code, message },
    },
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
    event: {
      type: CONVERSATION_TRACE_EVENT_KIND.ERROR,
      payload: { agent_id: participantId, code, message },
    },
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
    if (context.signal.aborted) return failed(context, CONVERSATION_COMMAND_FAILURE_STATUS.ABORTED);

    const transcript: DebateTranscriptRoundV1[] = [];
    for (let round = 1; round <= context.maxRounds; round += 1) {
      const roundId = `round-${round}`;
      journal.push(
        await context.emit({
          idempotency_key: `debate:round:${round}:start`,
          event: {
            type: CONVERSATION_TRACE_EVENT_KIND.ROUND_BOUNDARY,
            payload: { round_id: roundId, phase: CONVERSATION_ROUND_PHASE.START },
          },
        }),
      );
      const participants = await this.runParticipants(context, responders, round);
      if (!participants)
        return failed(
          context,
          context.signal.aborted
            ? CONVERSATION_COMMAND_FAILURE_STATUS.ABORTED
            : CONVERSATION_COMMAND_FAILURE_STATUS.FAILED,
        );
      for (const participant of participants) {
        journal.push(
          await participant.attempt.emit({
            idempotency_key: `debate:round:${round}:participant:${participant.participantId}:precommit`,
            event: {
              type: CONVERSATION_TRACE_EVENT_KIND.PRECOMMIT,
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
        CONVERSATION_ASSESSMENT_STAGE.BLIND,
        debateBlindEvaluatorPrompt(
          participants.map(({ answer, evidence }) => ({ answer, evidence })),
        ),
        journal,
      );
      if (!blind)
        return failed(
          context,
          context.signal.aborted
            ? CONVERSATION_COMMAND_FAILURE_STATUS.ABORTED
            : CONVERSATION_COMMAND_FAILURE_STATUS.FAILED,
        );
      for (const participant of participants) {
        journal.push(await publishDebateParticipantResponse(context, round, participant));
      }
      const positions = participants.map(({ claim, evidence }) => ({ claim, evidence }));
      const full = await this.evaluate(
        context,
        evaluatorIndex,
        evaluatorId,
        round,
        CONVERSATION_ASSESSMENT_STAGE.FULL,
        debateFullEvaluatorPrompt(blind, positions),
        journal,
      );
      if (!full)
        return failed(
          context,
          context.signal.aborted
            ? CONVERSATION_COMMAND_FAILURE_STATUS.ABORTED
            : CONVERSATION_COMMAND_FAILURE_STATUS.FAILED,
        );
      const decision = decideRound(full, round, context.maxRounds);
      if (decision.outcome === CONVERSATION_DECISION_OUTCOME.ABORT) {
        await coordinatorError(
          context,
          CONVERSATION_INVALID_ASSESSMENT_REASON,
          "evaluator returned an invalid full assessment",
        );
        return failed(context);
      }
      journal.push(
        await context.emit({
          idempotency_key: `debate:round:${round}:consensus`,
          event: {
            type: CONVERSATION_TRACE_EVENT_KIND.CONSENSUS_UPDATE,
            payload: { round_id: roundId, decision },
          },
        }),
        await context.emit({
          idempotency_key: `debate:round:${round}:end`,
          event: {
            type: CONVERSATION_TRACE_EVENT_KIND.ROUND_BOUNDARY,
            payload: { round_id: roundId, phase: CONVERSATION_ROUND_PHASE.END },
          },
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
      if (decision.outcome !== CONVERSATION_DECISION_OUTCOME.CONTINUE) break;
    }
    return publishDebateArtifacts({
      context,
      responder_indices: responders,
      journal,
      transcript,
    });
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
          instruction: {
            kind: CONVERSATION_TURN_INSTRUCTION_KIND.DEBATE_PARTICIPANT,
            topic: context.topic,
            round,
          },
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
    const failedIndex = results.findIndex(
      (result) => !result.ok || result.state !== CONVERSATION_OPERATION_STATE.COMPLETED,
    );
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
        ...(parsed.action_candidate ? { actionCandidate: parsed.action_candidate } : {}),
      };
    });
  }

  private async evaluate(
    context: ConversationContext,
    bindingIndex: number,
    participantId: string,
    round: number,
    stage: ConversationAssessmentStageV1,
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
    if (!result.ok || result.state !== CONVERSATION_OPERATION_STATE.COMPLETED) {
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
      stage === CONVERSATION_ASSESSMENT_STAGE.BLIND ? 1 : round,
      stage === CONVERSATION_ASSESSMENT_STAGE.BLIND
        ? Math.max(1, context.maxRounds)
        : context.maxRounds,
    );
    if (!assessment) {
      await coordinatorError(
        context,
        CONVERSATION_INVALID_ASSESSMENT_REASON,
        `evaluator returned an invalid ${stage} assessment`,
      );
      return null;
    }
    journal.push(
      await attempt.emit({
        idempotency_key: `debate:round:${round}:evaluator:${stage}`,
        event: {
          type: CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT,
          payload: { round_id: `round-${round}`, stage, assessment },
        },
      }),
    );
    return assessment;
  }
}
