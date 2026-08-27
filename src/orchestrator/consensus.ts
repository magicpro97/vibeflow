import {
  CONVERSATION_CONVERGENCE_NOT_APPLICABLE,
  CONVERSATION_DECISION_OUTCOME,
  CONVERSATION_INVALID_ASSESSMENT_REASON,
  type ConversationContinuingDecisionOutcomeV1,
} from "./conversation/conversation-public-wire-contract.js";

export interface BooleanGate {
  value: boolean;
  evidence: string;
}
export interface ConvergenceGate {
  value: boolean | typeof CONVERSATION_CONVERGENCE_NOT_APPLICABLE;
  evidence: string;
}
export interface EvaluatorOutput {
  agreement: BooleanGate;
  conflict_resolution: BooleanGate;
  evidence_quality: BooleanGate;
  convergence: ConvergenceGate;
}
export type RoundDecision =
  | {
      outcome: typeof CONVERSATION_DECISION_OUTCOME.ABORT;
      score: null;
      reason: typeof CONVERSATION_INVALID_ASSESSMENT_REASON;
    }
  | { outcome: ConversationContinuingDecisionOutcomeV1; score: number };

export function decideRound(input: unknown, round: unknown, maxRounds: unknown): RoundDecision {
  const invalid = (): RoundDecision => ({
    outcome: CONVERSATION_DECISION_OUTCOME.ABORT,
    score: null,
    reason: CONVERSATION_INVALID_ASSESSMENT_REASON,
  });
  try {
    if (
      typeof round !== "number" ||
      typeof maxRounds !== "number" ||
      !Number.isFinite(round) ||
      !Number.isFinite(maxRounds) ||
      !Number.isInteger(round) ||
      !Number.isInteger(maxRounds) ||
      round < 1 ||
      maxRounds < 1 ||
      round > maxRounds ||
      typeof input !== "object" ||
      input === null
    )
      return invalid();
    const assessment = input as Record<string, unknown>;
    const names = ["agreement", "conflict_resolution", "evidence_quality", "convergence"] as const;
    const isGate = (
      value: unknown,
      convergence = false,
    ): value is {
      value: boolean | typeof CONVERSATION_CONVERGENCE_NOT_APPLICABLE;
      evidence: string;
    } => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const gate = value as Record<string, unknown>;
      return (
        Object.keys(gate).length === 2 &&
        Object.prototype.hasOwnProperty.call(gate, "value") &&
        Object.prototype.hasOwnProperty.call(gate, "evidence") &&
        typeof gate.evidence === "string" &&
        (typeof gate.value === "boolean" ||
          (convergence && gate.value === CONVERSATION_CONVERGENCE_NOT_APPLICABLE))
      );
    };
    if (
      Array.isArray(assessment) ||
      Object.keys(assessment).length !== 4 ||
      !names.every((name) => Object.prototype.hasOwnProperty.call(assessment, name)) ||
      !isGate(assessment.agreement) ||
      !isGate(assessment.conflict_resolution) ||
      !isGate(assessment.evidence_quality) ||
      !isGate(assessment.convergence, true) ||
      (round > 1 && assessment.convergence.value === CONVERSATION_CONVERGENCE_NOT_APPLICABLE)
    )
      return invalid();
    const active =
      round === 1
        ? [
            assessment.agreement.value,
            assessment.conflict_resolution.value,
            assessment.evidence_quality.value,
          ]
        : [
            assessment.agreement.value,
            assessment.conflict_resolution.value,
            assessment.evidence_quality.value,
            assessment.convergence.value as boolean,
          ];
    const score = active.filter(Boolean).length / active.length;
    return active.every(Boolean)
      ? { outcome: CONVERSATION_DECISION_OUTCOME.CONSENSUS, score }
      : round === maxRounds
        ? { outcome: CONVERSATION_DECISION_OUTCOME.EXHAUSTED, score }
        : { outcome: CONVERSATION_DECISION_OUTCOME.CONTINUE, score };
  } catch {
    return invalid();
  }
}
