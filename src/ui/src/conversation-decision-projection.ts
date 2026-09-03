import {
  CONVERSATION_ASSESSMENT_STAGE,
  CONVERSATION_BASELINE_FAILURE_REASON,
  CONVERSATION_BASELINE_STATUS,
  CONVERSATION_CONVERGENCE_NOT_APPLICABLE,
  CONVERSATION_DECISION_OUTCOME,
  CONVERSATION_ROUND_PHASE,
  CONVERSATION_TRACE_EVENT_KIND,
  type ConversationDecisionOutcomeV1,
} from "../../orchestrator/conversation/conversation-public-wire-contract.js";
import type { ConversationTraceRecord } from "./conversation-types.js";

const WEIGHTS = {
  responses: 0.2,
  evidence: 0.1,
  agreement: 0.25,
  conflict_resolution: 0.2,
  evidence_quality: 0.15,
  convergence: 0.1,
} as const;

type GateValue = boolean | typeof CONVERSATION_CONVERGENCE_NOT_APPLICABLE;
type ScoreAxis = keyof typeof WEIGHTS;
type FullAssessment = Extract<
  ConversationTraceRecord["event"],
  { type: typeof CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT }
>;
type CompletedRound = {
  responses: Map<string, ResponseState>;
  assessments: FullAssessment[];
  decision: ConversationDecisionOutcomeV1 | null;
  consumed: string[];
  ended: boolean;
};
type ResponseState = {
  claim: string | null;
  evidence: string[];
  complete: boolean;
  invalid: boolean;
};
const EMPTY_RESPONSE: ResponseState = {
  claim: null,
  evidence: [],
  complete: false,
  invalid: false,
};

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const normalizeOption = (value: string) => {
  const normalized = value
    .normalize("NFKC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  return { option: normalized, key: normalized.toLowerCase() };
};
const compareCodePoints = (left: string, right: string) => {
  const a = [...left].map((value) => value.codePointAt(0) ?? 0);
  const b = [...right].map((value) => value.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return a.length - b.length;
};
const computeTokenSetDivergence = (left: string, right: string) => {
  const tokenize = (value: string) =>
    new Set(
      normalizeOption(value)
        .key.split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    );
  const a = tokenize(left);
  const b = tokenize(right);
  if (!a.size && !b.size) return 0;
  if (!a.size || !b.size) return 1;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return round6((a.size + b.size - 2 * intersection) / (a.size + b.size - intersection));
};
const roundIdFor = (event: ConversationTraceRecord["event"]) => {
  const payload = event.payload as { round_id?: unknown };
  return typeof payload.round_id === "string" ? payload.round_id : null;
};

function collectCompletedRounds(records: readonly ConversationTraceRecord[]) {
  const rounds = new Map<string, CompletedRound>();
  for (const record of records) {
    const event = record.event;
    const roundId = roundIdFor(event);
    if (
      event.type === CONVERSATION_TRACE_EVENT_KIND.ROUND_BOUNDARY &&
      event.payload.phase === CONVERSATION_ROUND_PHASE.START
    ) {
      rounds.set(
        event.payload.round_id,
        rounds.get(event.payload.round_id) ?? {
          responses: new Map(),
          assessments: [],
          decision: null,
          consumed: [record.ts],
          ended: false,
        },
      );
    }
    if (!roundId) continue;
    const round = rounds.get(roundId);
    if (!round || round.ended) continue;
    if (event.type === CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA) {
      const response = round.responses.get(event.payload.participant_id) ?? { ...EMPTY_RESPONSE };
      if (response.complete) response.invalid = true;
      else if (event.payload.completes_response) {
        response.complete = true;
        response.claim = event.payload.final_claim;
        response.evidence = [...new Set(event.payload.final_evidence)];
      }
      round.responses.set(event.payload.participant_id, response);
      round.consumed.push(record.ts);
    } else if (
      event.type === CONVERSATION_TRACE_EVENT_KIND.EVALUATOR_ASSESSMENT &&
      event.payload.stage === CONVERSATION_ASSESSMENT_STAGE.FULL
    ) {
      round.assessments.push(event);
      round.consumed.push(record.ts);
    } else if (event.type === CONVERSATION_TRACE_EVENT_KIND.CONSENSUS_UPDATE) {
      round.decision = event.payload.decision.outcome;
      round.consumed.push(record.ts);
    } else if (
      event.type === CONVERSATION_TRACE_EVENT_KIND.ROUND_BOUNDARY &&
      event.payload.phase === CONVERSATION_ROUND_PHASE.END
    ) {
      round.ended = true;
      round.consumed.push(record.ts);
    }
  }
  return [...rounds.values()].filter(
    (round) =>
      round.ended &&
      round.decision !== null &&
      round.decision !== CONVERSATION_DECISION_OUTCOME.ABORT &&
      round.responses.size > 0 &&
      [...round.responses.values()].every((response) => response.complete && !response.invalid),
  );
}

function gateRatio(
  rounds: ReturnType<typeof collectCompletedRounds>,
  name: Exclude<ScoreAxis, "responses" | "evidence">,
) {
  let passed = 0;
  let applicable = 0;
  for (const round of rounds) {
    for (const assessment of round.assessments) {
      const gate = assessment.payload.assessment[name];
      if ((gate.value as GateValue) === CONVERSATION_CONVERGENCE_NOT_APPLICABLE) continue;
      applicable += 1;
      if (gate.value) passed += 1;
    }
  }
  return applicable ? passed / applicable : 0;
}

export function projectConversationDecisionMatrix(records: readonly ConversationTraceRecord[]) {
  const completed = collectCompletedRounds(records);
  const groups = new Map<
    string,
    { option: string; key: string; responses: number; evidence: number }
  >();
  for (const round of completed) {
    for (const response of round.responses.values()) {
      if (!response.claim) continue;
      const normalized = normalizeOption(response.claim);
      if (!normalized.key) continue;
      const current = groups.get(normalized.key);
      if (!current) {
        groups.set(normalized.key, {
          option: normalized.option,
          key: normalized.key,
          responses: 1,
          evidence: response.evidence.length,
        });
        continue;
      }
      current.responses += 1;
      current.evidence += response.evidence.length;
      if (compareCodePoints(normalized.option, current.option) < 0) {
        current.option = normalized.option;
      }
    }
  }
  if (!groups.size) return null;

  const totalResponses = [...groups.values()].reduce((sum, group) => sum + group.responses, 0);
  const totalEvidence = [...groups.values()].reduce((sum, group) => sum + group.evidence, 0);
  const sharedScores = {
    agreement: round6(gateRatio(completed, "agreement")),
    conflict_resolution: round6(gateRatio(completed, "conflict_resolution")),
    evidence_quality: round6(gateRatio(completed, "evidence_quality")),
    convergence: round6(gateRatio(completed, "convergence")),
  };

  const rows = [...groups.values()]
    .map((group) => {
      const responses = round6(group.responses / totalResponses);
      const evidence = round6(totalEvidence ? group.evidence / totalEvidence : 0);
      return {
        option: group.option,
        key: group.key,
        responses: group.responses,
        scores: { responses, evidence, ...sharedScores },
        aggregate: round6(
          responses * WEIGHTS.responses +
            evidence * WEIGHTS.evidence +
            sharedScores.agreement * WEIGHTS.agreement +
            sharedScores.conflict_resolution * WEIGHTS.conflict_resolution +
            sharedScores.evidence_quality * WEIGHTS.evidence_quality +
            sharedScores.convergence * WEIGHTS.convergence,
        ),
      };
    })
    .sort(
      (left, right) =>
        right.aggregate - left.aggregate ||
        right.responses - left.responses ||
        compareCodePoints(left.key, right.key),
    )
    .map(({ key: _key, responses: _responses, ...row }, index) => ({
      ...row,
      rank: index + 1,
    }));

  return {
    rows,
    method: "weighted_sum" as const,
    generated_at:
      completed
        .flatMap((round) => round.consumed)
        .sort()
        .at(-1) ?? "",
  };
}

export function projectConversationBaseline(
  records: readonly ConversationTraceRecord[],
  decisionMatrix: ReturnType<typeof projectConversationDecisionMatrix>,
) {
  const baseline = [...records]
    .reverse()
    .find((record) => record.event.type === CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT);
  if (!baseline || baseline.event.type !== CONVERSATION_TRACE_EVENT_KIND.BASELINE_RESULT)
    return null;

  const debateAnswer = decisionMatrix?.rows.find((row) => row.rank === 1)?.option ?? null;
  if (baseline.event.payload.status !== CONVERSATION_BASELINE_STATUS.SUCCESS) {
    return {
      status: baseline.event.payload.status,
      baseline_answer: null,
      debate_answer: debateAnswer,
      divergence: null,
      skip_reason: baseline.event.payload.skip_reason,
    };
  }

  const baselineAnswer = baseline.event.payload.answer;
  return {
    status:
      baselineAnswer && debateAnswer
        ? CONVERSATION_BASELINE_STATUS.SUCCESS
        : CONVERSATION_BASELINE_STATUS.FAILED,
    baseline_answer: baselineAnswer,
    debate_answer: debateAnswer,
    divergence:
      baselineAnswer && debateAnswer
        ? computeTokenSetDivergence(baselineAnswer, debateAnswer)
        : null,
    skip_reason:
      baselineAnswer && debateAnswer
        ? null
        : baselineAnswer
          ? CONVERSATION_BASELINE_FAILURE_REASON.NO_DEBATE_ANSWER
          : CONVERSATION_BASELINE_FAILURE_REASON.BASELINE_MISSING,
  };
}
