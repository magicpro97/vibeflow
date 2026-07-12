// test/orchestrator/stuck-detector.test.ts
// #546 — StuckDetector: stalled / looping / evidence-stuck patterns.

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

  test("evidence-stuck: count unchanged across evidenceStallRounds+1 checks", () => {
    const d = new StuckDetector({ evidenceStallRounds: 2 });
    d.recordEvidenceCount(4);
    d.recordEvidenceCount(4);
    expect(d.check().evidenceStuck).toBe(false);
    d.recordEvidenceCount(4);
    expect(d.check().evidenceStuck).toBe(true);
  });

  test("evidence-stuck: a growing count clears it", () => {
    const d = new StuckDetector({ evidenceStallRounds: 2 });
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
