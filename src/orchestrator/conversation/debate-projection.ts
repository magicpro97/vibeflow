import type { EvaluatorOutput } from "../consensus.js";
import type { StoredTraceEvent } from "../trace/types.js";

export const DECISION_MATRIX_WEIGHTS = Object.freeze({
  responses: 20,
  evidence: 10,
  agreement: 25,
  conflict_resolution: 20,
  evidence_quality: 15,
  convergence: 10,
} as const);

export type DecisionScoreName = keyof typeof DECISION_MATRIX_WEIGHTS;
export type DecisionScores = Record<DecisionScoreName, number>;

export interface DecisionMatrixRow {
  option: string;
  scores: DecisionScores;
  aggregate: number;
  rank: number;
}

export interface DecisionMatrix {
  rows: DecisionMatrixRow[];
  method: "weighted_sum";
  generated_at: string;
}

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

interface ResponseState {
  claim: string | null;
  evidence: string[];
  complete: boolean;
  invalid: boolean;
}

interface RoundState {
  responses: Map<string, ResponseState>;
  assessments: EvaluatorOutput[];
  decision: "abort" | "complete" | null;
  consumed: StoredTraceEvent[];
  ended: boolean;
}

interface OptionGroup {
  key: string;
  option: string;
  responses: number;
  evidence: number;
}

interface RankedGroup extends OptionGroup {
  componentRationals: Record<DecisionScoreName, Rational>;
  aggregateRational: Rational;
}

const ratio = (numerator: number | bigint, denominator: number | bigint): Rational => ({
  numerator: BigInt(numerator),
  denominator: BigInt(denominator) || 1n,
});

const add = (left: Rational, right: Rational): Rational => ({
  numerator: left.numerator * right.denominator + right.numerator * left.denominator,
  denominator: left.denominator * right.denominator,
});

const weighted = (value: Rational, percent: number): Rational => ({
  numerator: value.numerator * BigInt(percent),
  denominator: value.denominator * 100n,
});

const compareRational = (left: Rational, right: Rational): number => {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

/** Exact non-negative decimal half-up rounding, converted only after six places are fixed. */
export function roundHalfUpSix(value: Rational): number {
  const scale = 1_000_000n;
  const scaled = value.numerator * scale;
  let quotient = scaled / value.denominator;
  const remainder = scaled % value.denominator;
  if (remainder * 2n >= value.denominator) quotient += 1n;
  return Number(quotient) / Number(scale);
}

export const roundRatioHalfUpSix = (
  numerator: number | bigint,
  denominator: number | bigint,
): number => roundHalfUpSix(ratio(numerator, denominator));

export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left].map((value) => value.codePointAt(0) ?? 0);
  const rightPoints = [...right].map((value) => value.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

/** NFKC + Unicode trim/whitespace collapse. The key adds non-locale lowercase. */
export function normalizeDebateOption(value: string): { option: string; key: string } {
  const option = value
    .normalize("NFKC")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  return { option, key: option.toLowerCase() };
}

const responseState = (round: RoundState, participantId: string): ResponseState => {
  let state = round.responses.get(participantId);
  if (!state) {
    state = { claim: null, evidence: [], complete: false, invalid: false };
    round.responses.set(participantId, state);
  }
  return state;
};

function completedRounds(records: readonly StoredTraceEvent[]): RoundState[] {
  const rounds = new Map<string, RoundState>();
  const completed: RoundState[] = [];
  for (const record of records) {
    const event = record.event;
    if (event.type === "round_boundary" && event.payload.phase === "start") {
      if (!rounds.has(event.payload.round_id)) {
        rounds.set(event.payload.round_id, {
          responses: new Map(),
          assessments: [],
          decision: null,
          consumed: [record],
          ended: false,
        });
      }
      continue;
    }
    const roundId =
      event.type === "agent_response_delta" ||
      event.type === "evaluator_assessment" ||
      event.type === "consensus_update" ||
      event.type === "round_boundary"
        ? event.payload.round_id
        : null;
    const round = roundId ? rounds.get(roundId) : undefined;
    if (!round || round.ended) continue;
    if (event.type === "agent_response_delta") {
      round.consumed.push(record);
      const response = responseState(round, event.payload.participant_id);
      if (response.complete) {
        response.invalid = true;
        continue;
      }
      if (event.payload.completes_response) {
        response.complete = true;
        response.claim = event.payload.final_claim;
        response.evidence = [...new Set(event.payload.final_evidence)];
      }
      continue;
    }
    if (event.type === "evaluator_assessment" && event.payload.stage === "full") {
      round.consumed.push(record);
      round.assessments.push(event.payload.assessment);
      continue;
    }
    if (event.type === "consensus_update") {
      round.consumed.push(record);
      round.decision = event.payload.decision.outcome === "abort" ? "abort" : "complete";
      continue;
    }
    if (event.type === "round_boundary" && event.payload.phase === "end") {
      round.consumed.push(record);
      round.ended = true;
      const responses = [...round.responses.values()];
      if (
        round.decision === "complete" &&
        responses.length > 0 &&
        responses.every((response) => response.complete && !response.invalid)
      ) {
        completed.push(round);
      }
    }
  }
  return completed;
}

const gateRatios = (rounds: readonly RoundState[]): Record<DecisionScoreName, Rational> => {
  const values: Record<Exclude<DecisionScoreName, "responses" | "evidence">, Rational> = {
    agreement: ratio(0, 1),
    conflict_resolution: ratio(0, 1),
    evidence_quality: ratio(0, 1),
    convergence: ratio(0, 1),
  };
  for (const name of Object.keys(values) as Array<keyof typeof values>) {
    let applicable = 0;
    let passed = 0;
    for (const round of rounds) {
      for (const assessment of round.assessments) {
        const value = assessment[name].value;
        if (value === "not_applicable") continue;
        applicable += 1;
        if (value) passed += 1;
      }
    }
    values[name] = ratio(passed, applicable);
  }
  return { responses: ratio(0, 1), evidence: ratio(0, 1), ...values };
};

function groupOptions(rounds: readonly RoundState[]): OptionGroup[] {
  const groups = new Map<string, OptionGroup>();
  for (const round of rounds) {
    for (const response of round.responses.values()) {
      if (response.claim === null) continue;
      const normalized = normalizeDebateOption(response.claim);
      if (!normalized.key) continue;
      const existing = groups.get(normalized.key);
      if (existing) {
        existing.responses += 1;
        existing.evidence += response.evidence.length;
        if (compareUnicodeCodePoints(normalized.option, existing.option) < 0) {
          existing.option = normalized.option;
        }
      } else {
        groups.set(normalized.key, {
          key: normalized.key,
          option: normalized.option,
          responses: 1,
          evidence: response.evidence.length,
        });
      }
    }
  }
  return [...groups.values()];
}

const rankGroups = (
  groups: readonly OptionGroup[],
  rounds: readonly RoundState[],
): RankedGroup[] => {
  const totalResponses = groups.reduce((sum, group) => sum + group.responses, 0);
  const totalEvidence = groups.reduce((sum, group) => sum + group.evidence, 0);
  const gates = gateRatios(rounds);
  return groups.map((group) => {
    const componentRationals: Record<DecisionScoreName, Rational> = {
      responses: ratio(group.responses, totalResponses),
      evidence: ratio(group.evidence, totalEvidence),
      agreement: gates.agreement,
      conflict_resolution: gates.conflict_resolution,
      evidence_quality: gates.evidence_quality,
      convergence: gates.convergence,
    };
    let aggregateRational = ratio(0, 1);
    for (const name of Object.keys(DECISION_MATRIX_WEIGHTS) as DecisionScoreName[]) {
      aggregateRational = add(
        aggregateRational,
        weighted(componentRationals[name], DECISION_MATRIX_WEIGHTS[name]),
      );
    }
    return { ...group, componentRationals, aggregateRational };
  });
};

/** Project semantic debate output solely from the ascending durable journal. */
export function projectDecisionMatrix(records: readonly StoredTraceEvent[]): DecisionMatrix | null {
  const completed = completedRounds(records);
  const groups = groupOptions(completed);
  if (groups.length === 0) return null;
  const ranked = rankGroups(groups, completed).sort((left, right) => {
    const aggregate = compareRational(right.aggregateRational, left.aggregateRational);
    if (aggregate !== 0) return aggregate;
    if (left.responses !== right.responses) return right.responses - left.responses;
    return compareUnicodeCodePoints(left.key, right.key);
  });
  let generatedAt = "";
  for (const round of completed) {
    for (const record of round.consumed) {
      if (record.ts > generatedAt) generatedAt = record.ts;
    }
  }
  return {
    rows: ranked.map((group, index) => ({
      option: group.option,
      scores: Object.fromEntries(
        (Object.keys(DECISION_MATRIX_WEIGHTS) as DecisionScoreName[]).map((name) => [
          name,
          roundHalfUpSix(group.componentRationals[name]),
        ]),
      ) as DecisionScores,
      aggregate: roundHalfUpSix(group.aggregateRational),
      rank: index + 1,
    })),
    method: "weighted_sum",
    generated_at: generatedAt,
  };
}
