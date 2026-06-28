import type { DebatePosition, DebateResult, InvestigationRound, WorkUnit } from "../core.js";

/**
 * Risk classes map to required-confidence thresholds (AGENT_ORCHESTRATION_POLICY.md).
 * A decision below its threshold must trigger bounded investigation before it is acted on.
 */
export type RiskClass = "docs" | "simple-code" | "feature" | "architecture" | "security" | "deploy";

const THRESHOLDS: Record<RiskClass, number> = {
  docs: 0.7,
  "simple-code": 0.8,
  feature: 0.85,
  architecture: 0.9,
  security: 0.95,
  deploy: 0.95,
};

/** Bounded by default so investigation can never loop indefinitely. */
export const DEFAULT_MAX_ROUNDS = 4;

export function thresholdFor(rc: RiskClass): number {
  return THRESHOLDS[rc];
}

/** Return value from a single research round. */
export interface ResearchResult {
  findings: string[];
  confidence: number;
  /** Set when the round cannot progress without input the agent cannot obtain. */
  blocked?: boolean;
  /** Verifiable evidence (command output, file paths). Confidence may only rise when present. */
  artifacts?: string[];
}

/** One research step: given the open question, return new findings + a confidence estimate. */
export type Researcher = (round: number, question: string) => ResearchResult;

export type StoppedBy =
  | "threshold-met"
  | "max-rounds"
  | "no-new-evidence"
  | "no-progress"
  | "blocked-by-missing-input";

export interface InvestigationResult {
  question: string;
  threshold: number;
  rounds: InvestigationRound[];
  finalConfidence: number;
  met: boolean;
  /** Why investigation stopped (bounded — never an infinite loop). */
  stoppedBy: StoppedBy;
  recommendation: string;
}

/** Decide whether to stop after a round (and why), or keep investigating. */
function stopReason(
  prev: number,
  current: number,
  findings: string[],
  blocked: boolean,
  threshold: number,
): StoppedBy | undefined {
  if (blocked) return "blocked-by-missing-input";
  if (findings.length === 0 && current <= prev) return "no-new-evidence";
  if (current <= prev) return "no-progress";
  if (current >= threshold) return "threshold-met";
  return undefined;
}

function recommend(met: boolean, confidence: number, threshold: number): string {
  return met
    ? `Confidence ${confidence.toFixed(2)} ≥ ${threshold} — proceed with the investigated decision.`
    : `Confidence ${confidence.toFixed(2)} < ${threshold} — escalate: recommend the best-supported option and log uncertainty (do not merge/close).`;
}

/**
 * Bounded investigation: dispatch read-only research rounds until confidence reaches the
 * risk threshold OR a stop condition trips. Never loops indefinitely. The orchestrator
 * uses this whenever a decision's confidence is below 1.0 / below its risk threshold.
 */
export function investigate(opts: {
  question: string;
  riskClass: RiskClass;
  research: Researcher;
  maxRounds?: number;
  startConfidence?: number;
}): InvestigationResult {
  const threshold = thresholdFor(opts.riskClass);
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const rounds: InvestigationRound[] = [];
  let confidence = opts.startConfidence ?? 0;
  let stoppedBy: StoppedBy = "max-rounds";

  for (let r = 1; r <= maxRounds; r++) {
    const { findings, confidence: c, blocked, artifacts } = opts.research(r, opts.question);
    rounds.push({ round: r, question: opts.question, findings, confidence: c, artifacts });
    const prev = confidence;
    // Only accept the researcher's self-reported confidence when the round produced
    // verifiable artifacts (command output, file evidence). Pure prose findings do
    // NOT raise confidence — see issue #354.
    if (!blocked && findings.length > 0 && (artifacts?.length ?? 0) > 0) {
      confidence = c;
    }
    const reason = stopReason(prev, confidence, findings, Boolean(blocked), threshold);
    if (reason) {
      stoppedBy = reason;
      break;
    }
  }

  const met = confidence >= threshold;
  return {
    question: opts.question,
    threshold,
    rounds,
    finalConfidence: confidence,
    met,
    stoppedBy,
    recommendation: recommend(met, confidence, threshold),
  };
}

/** Async research step (real research spawns read-only engine agents — same injectable seam). */
export type AsyncResearcher = (round: number, question: string) => Promise<ResearchResult>;

export interface InvestigateUnitOptions {
  research: AsyncResearcher;
  /** Risk class governing the confidence threshold (defaults to feature-level). */
  riskClass?: RiskClass;
  maxRounds?: number;
}

export interface UnitInvestigationOutcome extends InvestigationResult {
  unit: string;
  /** True when the unit may proceed; false means block/escalate (do not close). */
  proceed: boolean;
}

/**
 * Entry point Wave B (commands.ts) calls when a unit's confidence < 1 before blocking/closing.
 * Runs a bounded async investigation seeded from the unit's current confidence, using an
 * injected read-only researcher (the real one spawns research agents via the dispatch seam).
 * Returns structured rounds + a final outcome; `proceed=false` means escalate, never silently
 * close. Pass `research` wired to the real engine dispatcher from commands.ts.
 */
export async function investigateUnit(
  unit: Pick<WorkUnit, "name" | "confidence" | "owner_agent">,
  opts: InvestigateUnitOptions,
): Promise<UnitInvestigationOutcome> {
  const riskClass = opts.riskClass ?? "feature";
  const threshold = thresholdFor(riskClass);
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const question = `Raise confidence for work unit "${unit.name}" to ${threshold}`;
  const rounds: InvestigationRound[] = [];
  let confidence = unit.confidence ?? 0;
  let stoppedBy: StoppedBy = "max-rounds";

  for (let r = 1; r <= maxRounds; r++) {
    const { findings, confidence: c, blocked, artifacts } = await opts.research(r, question);
    rounds.push({ round: r, question, findings, confidence: c, artifacts });
    const prev = confidence;
    // Only accept the researcher's self-reported confidence when the round produced
    // verifiable artifacts (command output, file evidence). Pure prose findings do
    // NOT raise confidence — see issue #354.
    if (!blocked && findings.length > 0 && (artifacts?.length ?? 0) > 0) {
      confidence = c;
    }
    const reason = stopReason(prev, confidence, findings, Boolean(blocked), threshold);
    if (reason) {
      stoppedBy = reason;
      break;
    }
  }

  const met = confidence >= threshold;
  return {
    unit: unit.name,
    question,
    threshold,
    rounds,
    finalConfidence: confidence,
    met,
    proceed: met,
    stoppedBy,
    recommendation: recommend(met, confidence, threshold),
  };
}

/**
 * Reconcile competing agent positions into a single resolution. The position backed by the
 * most evidence wins; the rest are recorded as rejected alternatives (auditable, no silent
 * discard). Confidence rises with evidence margin and falls when positions are tied.
 */
export function debate(question: string, positions: DebatePosition[]): DebateResult {
  if (!positions.length) {
    return { question, positions, resolution: "no positions offered", confidence: 0, rejected: [] };
  }
  const ranked = [...positions].sort((a, b) => b.evidence.length - a.evidence.length);
  const winner = ranked[0] as DebatePosition;
  const runnerUp = ranked[1];
  const margin = winner.evidence.length - (runnerUp?.evidence.length ?? 0);
  // Evidence-weighted confidence: more total evidence and a clear margin → higher confidence.
  const totalEvidence = positions.reduce((a, p) => a + p.evidence.length, 0);
  const confidence =
    totalEvidence === 0 ? 0 : Math.min(1, (winner.evidence.length + margin) / (totalEvidence + 1));
  return {
    question,
    positions,
    resolution: winner.claim,
    confidence: Number(confidence.toFixed(2)),
    rejected: ranked.slice(1).map((p) => `${p.agent}: ${p.claim}`),
  };
}
