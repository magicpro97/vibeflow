import type { StoredTraceEvent } from "../trace/types.js";
import {
  CONVERSATION_BASELINE_FAILURE_REASON,
  CONVERSATION_BASELINE_SKIP_REASON,
  CONVERSATION_BASELINE_STATUS,
  CONVERSATION_OPERATION_STATE,
  CONVERSATION_TRACE_EVENT_KIND,
  type ConversationBaselineFailureReasonV1,
  type ConversationBaselineReasonV1,
  type ConversationBaselineSkipReasonV1,
  type ConversationBaselineStatusV1,
  isConversationBaselineFailureReason,
} from "./conversation-public-wire-contract.js";
import {
  type DecisionMatrix,
  normalizeDebateOption,
  roundRatioHalfUpSix,
} from "./debate-projection.js";
import type { ConversationContext } from "./types.js";

export type BaselineSkipReason = ConversationBaselineSkipReasonV1;

export interface BaselineComparison {
  status: ConversationBaselineStatusV1;
  baseline_answer: string | null;
  debate_answer: string | null;
  divergence: number | null;
  skip_reason: ConversationBaselineReasonV1 | null;
}

export interface BaselineProjectionInput {
  enabled: boolean;
  nonEvaluatorParticipantCount: number;
  selectedEngineAvailable: boolean;
  decisionMatrix: DecisionMatrix | null;
  records: readonly StoredTraceEvent[];
}

const tokens = (value: string): Set<string> => {
  const normalized = normalizeDebateOption(value).key;
  return new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
};

/** Deterministic Jaccard distance over normalized Unicode letter/number token sets. */
export function computeTokenSetDivergence(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 && rightTokens.size === 0) return 0;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 1;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  const union = leftTokens.size + rightTokens.size - intersection;
  return roundRatioHalfUpSix(union - intersection, union);
}

const skipped = (reason: BaselineSkipReason, debateAnswer: string | null): BaselineComparison => ({
  status: CONVERSATION_BASELINE_STATUS.SKIPPED,
  baseline_answer: null,
  debate_answer: debateAnswer,
  divergence: null,
  skip_reason: reason,
});

const failed = (
  reason: ConversationBaselineFailureReasonV1 | null,
  debateAnswer: string | null,
): BaselineComparison => ({
  status: CONVERSATION_BASELINE_STATUS.FAILED,
  baseline_answer: null,
  debate_answer: debateAnswer,
  divergence: null,
  skip_reason: reason,
});

/** Apply the frozen skip/failure precedence to one ordered conversation journal. */
export function projectBaselineComparison(input: BaselineProjectionInput): BaselineComparison {
  const debateAnswer = input.decisionMatrix?.rows.find((row) => row.rank === 1)?.option ?? null;
  if (!input.enabled) return skipped(CONVERSATION_BASELINE_SKIP_REASON.DISABLED, debateAnswer);
  if (input.nonEvaluatorParticipantCount <= 1) {
    return skipped(CONVERSATION_BASELINE_SKIP_REASON.SINGLE_PARTICIPANT, debateAnswer);
  }
  if (!input.selectedEngineAvailable)
    return skipped(CONVERSATION_BASELINE_SKIP_REASON.ENGINE_UNAVAILABLE, debateAnswer);
  if (debateAnswer === null)
    return failed(CONVERSATION_BASELINE_FAILURE_REASON.NO_DEBATE_ANSWER, null);
  const baseline = input.records
    .filter(({ event }) => event.type === CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT)
    .sort((left, right) => left.seq - right.seq)
    .at(-1)?.event;
  if (!baseline || baseline.type !== CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT) {
    return failed(CONVERSATION_BASELINE_FAILURE_REASON.BASELINE_MISSING, debateAnswer);
  }
  if (baseline.payload.status === CONVERSATION_BASELINE_STATUS.FAILED) {
    return failed(
      baseline.payload.skip_reason === null ||
        isConversationBaselineFailureReason(baseline.payload.skip_reason)
        ? baseline.payload.skip_reason
        : CONVERSATION_BASELINE_FAILURE_REASON.BASELINE_FAILED,
      debateAnswer,
    );
  }
  if (baseline.payload.status === CONVERSATION_BASELINE_STATUS.SKIPPED) {
    return {
      status: CONVERSATION_BASELINE_STATUS.SKIPPED,
      baseline_answer: null,
      debate_answer: debateAnswer,
      divergence: null,
      skip_reason: baseline.payload.skip_reason,
    };
  }
  if (baseline.payload.answer === null)
    return failed(CONVERSATION_BASELINE_FAILURE_REASON.BASELINE_MISSING, debateAnswer);
  return {
    status: CONVERSATION_BASELINE_STATUS.SUCCESS,
    baseline_answer: baseline.payload.answer,
    debate_answer: debateAnswer,
    divergence: computeTokenSetDivergence(baseline.payload.answer, debateAnswer),
    skip_reason: null,
  };
}

/** Launch or skip the isolated first-participant baseline and persist exactly one result. */
export async function persistBaselineResult(
  context: ConversationContext,
  firstResponderIndex: number,
): Promise<StoredTraceEvent> {
  const firstId = context.participantIds[firstResponderIndex] as string;
  let payload: Extract<
    StoredTraceEvent["event"],
    { type: typeof CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT }
  >["payload"];
  if (!context.baselineEnabled) {
    payload = {
      status: CONVERSATION_BASELINE_STATUS.SKIPPED,
      answer: null,
      confidence: null,
      skip_reason: CONVERSATION_BASELINE_SKIP_REASON.DISABLED,
    };
  } else if (
    context.bindings.filter((binding) => binding.role.spec.name !== "brainstorm-evaluator")
      .length <= 1
  ) {
    payload = {
      status: CONVERSATION_BASELINE_STATUS.SKIPPED,
      answer: null,
      confidence: null,
      skip_reason: CONVERSATION_BASELINE_SKIP_REASON.SINGLE_PARTICIPANT,
    };
  } else if (!context.bindingReadiness[firstResponderIndex]?.engine_available) {
    payload = {
      status: CONVERSATION_BASELINE_STATUS.SKIPPED,
      answer: null,
      confidence: null,
      skip_reason: CONVERSATION_BASELINE_SKIP_REASON.ENGINE_UNAVAILABLE,
    };
  } else {
    try {
      const result = await context.launchAttempt({
        participantId: firstId,
        bindingIndex: firstResponderIndex,
        purpose: "baseline",
        promptInput: context.topic,
      }).completion;
      payload =
        result.ok && result.state === CONVERSATION_OPERATION_STATE.COMPLETED
          ? {
              status: CONVERSATION_BASELINE_STATUS.SUCCESS,
              answer: result.output,
              confidence: null,
              skip_reason: null,
            }
          : {
              status: CONVERSATION_BASELINE_STATUS.FAILED,
              answer: null,
              confidence: null,
              skip_reason: isConversationBaselineFailureReason(result.reason)
                ? result.reason
                : CONVERSATION_BASELINE_FAILURE_REASON.BASELINE_FAILED,
            };
    } catch {
      payload = {
        status: CONVERSATION_BASELINE_STATUS.FAILED,
        answer: null,
        confidence: null,
        skip_reason: CONVERSATION_BASELINE_FAILURE_REASON.BASELINE_START_FAILED,
      };
    }
  }
  return context.emit({
    idempotency_key: "debate:baseline:result",
    event: { type: CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT, payload },
  });
}
