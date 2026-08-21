export interface BooleanGate {
  value: boolean;
  evidence: string;
}
export interface ConvergenceGate {
  value: boolean | "not_applicable";
  evidence: string;
}
export interface EvaluatorOutput {
  agreement: BooleanGate;
  conflict_resolution: BooleanGate;
  evidence_quality: BooleanGate;
  convergence: ConvergenceGate;
}
export type RoundDecision =
  | { outcome: "abort"; score: null; reason: "invalid_assessment" }
  | { outcome: "consensus" | "continue" | "exhausted"; score: number };

export function decideRound(input: unknown, round: unknown, maxRounds: unknown): RoundDecision {
  const invalid = (): RoundDecision => ({
    outcome: "abort",
    score: null,
    reason: "invalid_assessment",
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
    ): value is { value: boolean | "not_applicable"; evidence: string } => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const gate = value as Record<string, unknown>;
      return (
        Object.keys(gate).length === 2 &&
        Object.prototype.hasOwnProperty.call(gate, "value") &&
        Object.prototype.hasOwnProperty.call(gate, "evidence") &&
        typeof gate.evidence === "string" &&
        (typeof gate.value === "boolean" || (convergence && gate.value === "not_applicable"))
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
      (round > 1 && assessment.convergence.value === "not_applicable")
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
      ? { outcome: "consensus", score }
      : round === maxRounds
        ? { outcome: "exhausted", score }
        : { outcome: "continue", score };
  } catch {
    return invalid();
  }
}
