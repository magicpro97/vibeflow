import type { StoredTraceEvent } from "../trace/types.js";
import {
  type DecisionMatrix,
  normalizeDebateOption,
  roundRatioHalfUpSix,
} from "./debate-projection.js";
import type { ConversationContext } from "./types.js";

export type BaselineSkipReason = "disabled" | "single_participant" | "engine_unavailable";

export interface BaselineComparison {
  status: "success" | "failed" | "skipped";
  baseline_answer: string | null;
  debate_answer: string | null;
  divergence: number | null;
  skip_reason: string | null;
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
  status: "skipped",
  baseline_answer: null,
  debate_answer: debateAnswer,
  divergence: null,
  skip_reason: reason,
});

const failed = (reason: string | null, debateAnswer: string | null): BaselineComparison => ({
  status: "failed",
  baseline_answer: null,
  debate_answer: debateAnswer,
  divergence: null,
  skip_reason: reason,
});

/** Apply the frozen skip/failure precedence to one ordered conversation journal. */
export function projectBaselineComparison(input: BaselineProjectionInput): BaselineComparison {
  const debateAnswer = input.decisionMatrix?.rows.find((row) => row.rank === 1)?.option ?? null;
  if (!input.enabled) return skipped("disabled", debateAnswer);
  if (input.nonEvaluatorParticipantCount <= 1) {
    return skipped("single_participant", debateAnswer);
  }
  if (!input.selectedEngineAvailable) return skipped("engine_unavailable", debateAnswer);
  if (debateAnswer === null) return failed("no_debate_answer", null);
  const baseline = input.records
    .filter(({ event }) => event.type === "baseline_result")
    .sort((left, right) => left.seq - right.seq)
    .at(-1)?.event;
  if (!baseline || baseline.type !== "baseline_result") {
    return failed("baseline_missing", debateAnswer);
  }
  if (baseline.payload.status === "failed") {
    return failed(baseline.payload.skip_reason, debateAnswer);
  }
  if (baseline.payload.status === "skipped") {
    return {
      status: "skipped",
      baseline_answer: null,
      debate_answer: debateAnswer,
      divergence: null,
      skip_reason: baseline.payload.skip_reason,
    };
  }
  if (baseline.payload.answer === null) return failed("baseline_missing", debateAnswer);
  return {
    status: "success",
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
  let payload: Extract<StoredTraceEvent["event"], { type: "baseline_result" }>["payload"];
  if (!context.baselineEnabled) {
    payload = { status: "skipped", answer: null, confidence: null, skip_reason: "disabled" };
  } else if (
    context.bindings.filter((binding) => binding.role.spec.name !== "brainstorm-evaluator")
      .length <= 1
  ) {
    payload = {
      status: "skipped",
      answer: null,
      confidence: null,
      skip_reason: "single_participant",
    };
  } else if (!context.bindingReadiness[firstResponderIndex]?.engine_available) {
    payload = {
      status: "skipped",
      answer: null,
      confidence: null,
      skip_reason: "engine_unavailable",
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
        result.ok && result.state === "completed"
          ? { status: "success", answer: result.output, confidence: null, skip_reason: null }
          : {
              status: "failed",
              answer: null,
              confidence: null,
              skip_reason: result.reason ?? "baseline_failed",
            };
    } catch {
      payload = {
        status: "failed",
        answer: null,
        confidence: null,
        skip_reason: "baseline_start_failed",
      };
    }
  }
  return context.emit({
    idempotency_key: "debate:baseline:result",
    event: { type: "baseline_result", payload },
  });
}
