import { describe, expect, test } from "bun:test";
import { buildReport } from "../../src/eval/report.js";
import type { VerdictSample, VerifySample } from "../../src/eval/telemetry.js";

function v(pass: boolean, over: Partial<VerdictSample> = {}): VerdictSample {
  return { ts: 0, pass, gates: {}, ...over };
}

describe("buildReport (#549)", () => {
  test("computes pass-rate, gate failures, avg goal score, cost totals", () => {
    const verdicts: VerdictSample[] = [
      v(true, {
        gates: { build: "pass", review: "pass" },
        goalScore: 0.8,
        costUsd: 0.01,
        tokens: 100,
      }),
      v(false, {
        gates: { build: "fail", review: "fail" },
        goalScore: 0.4,
        costUsd: 0.02,
        tokens: 200,
      }),
      v(true, { gates: { build: "pass", review: "fail" } }), // no cost/score
    ];
    const verifies: VerifySample[] = [
      { date: "2026-07-13", pass: true },
      { date: "2026-07-12", pass: false },
    ];
    const r = buildReport(verdicts, verifies, {});
    expect(r.verdict.total).toBe(3);
    expect(r.verdict.passed).toBe(2);
    expect(r.verdict.passRate).toBeCloseTo(2 / 3);
    expect(r.verdict.gateFailures).toEqual({ build: 1, review: 2 });
    expect(r.verdict.avgGoalScore).toBeCloseTo(0.6); // (0.8+0.4)/2
    expect(r.verdict.totalCostUsd).toBeCloseTo(0.03);
    expect(r.verdict.totalTokens).toBe(300);
    expect(r.verify).toEqual({ total: 2, passed: 1, passRate: 0.5 });
    expect(r.ok).toBe(true); // no minPassRate → always ok
    expect(r.sampleWarning).toBeUndefined();
  });

  test("total===0 → passRate 0, no NaN, no cost/score fields", () => {
    const r = buildReport([], [], {});
    expect(r.verdict).toEqual({ total: 0, passed: 0, passRate: 0, gateFailures: {} });
    expect(r.verify).toEqual({ total: 0, passed: 0, passRate: 0 });
    expect(r.ok).toBe(true);
  });

  test("ok=false when below threshold with enough samples", () => {
    const verdicts = [v(true), v(false), v(false)];
    const r = buildReport(verdicts, [], { minPassRate: 0.9, minSamples: 3 });
    expect(r.minPassRate).toBe(0.9);
    expect(r.ok).toBe(false);
    expect(r.sampleWarning).toBeUndefined();
  });

  test("ok=true above threshold with enough samples", () => {
    const verdicts = [v(true), v(true), v(true)];
    const r = buildReport(verdicts, [], { minPassRate: 0.9, minSamples: 3 });
    expect(r.ok).toBe(true);
  });

  test("thin samples → ok=true + warning, never fails", () => {
    const verdicts = [v(false)];
    const r = buildReport(verdicts, [], { minPassRate: 0.9, minSamples: 10 });
    expect(r.ok).toBe(true);
    expect(r.sampleWarning).toContain("1");
    expect(r.sampleWarning).toContain("10");
  });

  test("minSamples defaults to 10 when omitted", () => {
    const verdicts = Array.from({ length: 5 }, () => v(false));
    const r = buildReport(verdicts, [], { minPassRate: 0.9 });
    expect(r.ok).toBe(true); // 5 < default 10 → warning, not fail
    expect(r.sampleWarning).toBeDefined();
  });
});
