import { describe, expect, test } from "bun:test";
import { StuckDetector } from "../../src/orchestrator/stuck-detector.js";

describe("StuckDetector", () => {
  test("stalled: no progress past stallSeconds", () => {
    const d = new StuckDetector({ stallSeconds: 10 });
    d.recordProgress(1_000);
    expect(d.check(1_000 + 5_000).stalled).toBe(false);
    const s = d.check(1_000 + 11_000);
    expect(s.stalled).toBe(true);
    expect(s.reasons.some((r) => r.startsWith("stalled"))).toBe(true);
  });

  test("looping: same output repeated loopThreshold times", () => {
    const d = new StuckDetector({ loopThreshold: 3 });
    d.recordOutput("same");
    d.recordOutput("same");
    expect(d.check().looping).toBe(false);
    d.recordOutput("same");
    expect(d.check().looping).toBe(true);
  });

  test("looping: distinct outputs do not trip it", () => {
    const d = new StuckDetector({ loopThreshold: 3 });
    d.recordOutput("a");
    d.recordOutput("b");
    d.recordOutput("c");
    expect(d.check().looping).toBe(false);
  });

  test("evidence-stuck at default (rounds=1): 2 identical counts trips", () => {
    const d = new StuckDetector({ evidenceStallRounds: 1 });
    d.recordEvidenceCount(4);
    expect(d.check().evidenceStuck).toBe(false);
    d.recordEvidenceCount(4);
    expect(d.check().evidenceStuck).toBe(true);
  });

  test("evidence-stuck at default (rounds=1): differing counts (0 then 2) is not stuck", () => {
    const d = new StuckDetector({ evidenceStallRounds: 1 });
    d.recordEvidenceCount(0);
    d.recordEvidenceCount(2);
    expect(d.check().evidenceStuck).toBe(false);
  });

  test("evidence-stuck: default rounds clamped to 1", () => {
    const d = new StuckDetector();
    expect(d.getEvidenceStallRoundsForTest()).toBe(1);
    d.recordEvidenceCount(5);
    d.recordEvidenceCount(5);
    expect(d.check().evidenceStuck).toBe(true);
  });

  test("clamp: evidenceStallRounds:0 behaves as rounds=1", () => {
    const d = new StuckDetector({ evidenceStallRounds: 0 });
    expect(d.getEvidenceStallRoundsForTest()).toBe(1);
    d.recordEvidenceCount(3);
    d.recordEvidenceCount(3);
    expect(d.check().evidenceStuck).toBe(true);
  });

  test("evidence-stuck: a growing count clears it", () => {
    const d = new StuckDetector({ evidenceStallRounds: 1 });
    d.recordEvidenceCount(1);
    d.recordEvidenceCount(2);
    d.recordEvidenceCount(3);
    expect(d.check().evidenceStuck).toBe(false);
  });

  test("healthy run trips nothing (false-positive guard)", () => {
    const d = new StuckDetector();
    d.recordProgress();
    d.recordOutput("a");
    d.recordEvidenceCount(1);
    d.recordOutput("b");
    d.recordEvidenceCount(2);
    const s = d.check();
    expect(s.stalled).toBe(false);
    expect(s.looping).toBe(false);
    expect(s.evidenceStuck).toBe(false);
    expect(s.reasons).toEqual([]);
  });
});
