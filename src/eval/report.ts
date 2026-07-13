// src/eval/report.ts — #549
//
// Aggregate telemetry samples into a stable pass-rate report with a threshold
// gate. Pure: samples in, report out. `ok` fails ONLY when an expected pass-rate
// is set AND we have enough samples AND the real pass-rate is below it — thin
// samples warn but never fail (a handful of hard tasks isn't a regression).

import type { VerdictSample, VerifySample } from "./telemetry.js";

export interface EvalReport {
  verdict: {
    total: number;
    passed: number;
    passRate: number;
    gateFailures: Record<string, number>;
    avgGoalScore?: number;
    totalCostUsd?: number;
    totalTokens?: number;
  };
  verify: { total: number; passed: number; passRate: number };
  minPassRate?: number;
  ok: boolean;
  sampleWarning?: string;
}

const DEFAULT_MIN_SAMPLES = 10;

/** Aggregate verdict + verify samples into a report; gate on minPassRate when set. */
export function buildReport(
  verdicts: VerdictSample[],
  verifies: VerifySample[],
  opts: { minPassRate?: number; minSamples?: number },
): EvalReport {
  const total = verdicts.length;
  const passed = verdicts.filter((s) => s.pass).length;
  const passRate = total === 0 ? 0 : passed / total;

  const gateFailures: Record<string, number> = {};
  for (const s of verdicts) {
    for (const [gate, state] of Object.entries(s.gates)) {
      if (state === "fail") gateFailures[gate] = (gateFailures[gate] ?? 0) + 1;
    }
  }

  const verdict: EvalReport["verdict"] = { total, passed, passRate, gateFailures };

  const scores = verdicts
    .filter((s) => s.goalScore !== undefined)
    .map((s) => s.goalScore as number);
  if (scores.length > 0) verdict.avgGoalScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  const costs = verdicts.filter((s) => s.costUsd !== undefined).map((s) => s.costUsd as number);
  if (costs.length > 0) verdict.totalCostUsd = costs.reduce((a, b) => a + b, 0);

  const tokenSamples = verdicts
    .filter((s) => s.tokens !== undefined)
    .map((s) => s.tokens as number);
  if (tokenSamples.length > 0) verdict.totalTokens = tokenSamples.reduce((a, b) => a + b, 0);

  const vTotal = verifies.length;
  const vPassed = verifies.filter((s) => s.pass).length;
  const verify = { total: vTotal, passed: vPassed, passRate: vTotal === 0 ? 0 : vPassed / vTotal };

  const report: EvalReport = { verdict, verify, ok: true };
  if (opts.minPassRate === undefined) return report;

  report.minPassRate = opts.minPassRate;
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES;
  if (total < minSamples) {
    report.sampleWarning = `n=${total} < ${minSamples} — not enough samples, treating as pass (don't conclude a regression)`;
    return report;
  }
  report.ok = passRate >= opts.minPassRate;
  return report;
}
