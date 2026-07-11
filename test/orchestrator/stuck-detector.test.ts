// test/orchestrator/stuck-detector.test.ts
// #546 stuck detection — RED phase: StuckDetector contract tests

import { describe, expect, test } from "bun:test";
import { StuckDetector } from "../../src/orchestrator/stuck-detector.js";
import type { StepRecord } from "../../src/orchestrator/stuck-detector.js";

describe("StuckDetector", () => {
  test("detectRepeatEdit: same file edited then reverted across 3 cycles", () => {
    const detector = new StuckDetector({ maxRepeatEdits: 3 });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "a1b2" }); // cycle 1
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "c3d4" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "a1b2" }); // cycle 2
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "c3d4" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "a1b2" }); // cycle 3
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "c3d4" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "a1b2" }); // trigger
    const result = detector.isStuck();
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("repeat-edit");
    expect(result!.evidence).toContain("src/foo.ts");
  });

  test("detectRepeatEdit: different files don't trigger", () => {
    const detector = new StuckDetector({ maxRepeatEdits: 3 });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "aaa" });
    detector.feed({ action: "edit", file: "src/bar.ts", hash: "bbb" });
    detector.feed({ action: "edit", file: "src/baz.ts", hash: "ccc" });
    expect(detector.isStuck()).toBeNull();
  });

  test("detectSameFail: K consecutive identical test failures", () => {
    const detector = new StuckDetector({ maxConsecutiveFails: 3 });
    detector.feed({ action: "test", test: "test_a", status: "fail", error: "expected X got Y" });
    detector.feed({ action: "test", test: "test_a", status: "fail", error: "expected X got Y" });
    detector.feed({ action: "test", test: "test_a", status: "fail", error: "expected X got Y" });
    const result = detector.isStuck();
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("same-fail");
    expect(result!.evidence).toContain("test_a");
  });

  test("detectSameFail: different error messages don't trigger", () => {
    const detector = new StuckDetector({ maxConsecutiveFails: 3 });
    detector.feed({ action: "test", test: "test_a", status: "fail", error: "expected X got Y" });
    detector.feed({ action: "test", test: "test_a", status: "fail", error: "expected A got B" });
    detector.feed({ action: "test", test: "test_a", status: "fail", error: "expected 1 got 2" });
    expect(detector.isStuck()).toBeNull();
  });

  test("detectNoProgress: zero diff growth across N steps", () => {
    const detector = new StuckDetector({ maxStepsNoProgress: 5 });
    for (let i = 0; i < 4; i++) {
      expect(detector.feed({ action: "edit", diffSize: 0 })).toBeNull();
    }
    const result = detector.feed({ action: "edit", diffSize: 0 });
    expect(result).not.toBeNull();
    expect(result!.reason).toBe("no-progress");
  });

  test("detectNoProgress: steps with diff growth don't trigger", () => {
    const detector = new StuckDetector({ maxStepsNoProgress: 5 });
    for (let i = 0; i < 4; i++) {
      detector.feed({ action: "edit", diffSize: 0 });
    }
    detector.feed({ action: "edit", file: "src/foo.ts", diffSize: 5 });
    detector.feed({ action: "edit", diffSize: 0 });
    detector.feed({ action: "edit", diffSize: 0 });
    expect(detector.isStuck()).toBeNull();
  });

  test("healthy run must NOT trip detector (false-positive guard)", () => {
    const detector = new StuckDetector();
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "aaa", diffSize: 10 });
    detector.feed({ action: "test", test: "test_a", status: "pass" });
    detector.feed({ action: "edit", file: "src/bar.ts", hash: "bbb", diffSize: 8 });
    detector.feed({ action: "test", test: "test_b", status: "pass" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "ccc", diffSize: 3 });
    expect(detector.isStuck()).toBeNull();
  });

  test("default thresholds are sensible", () => {
    const detector = new StuckDetector();
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "a" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "b" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "a" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "b" });
    expect(detector.isStuck()).toBeNull();
  });

  test("custom thresholds override defaults", () => {
    const detector = new StuckDetector({ maxRepeatEdits: 2, maxConsecutiveFails: 2 });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "a" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "b" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "a" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "b" });
    detector.feed({ action: "edit", file: "src/foo.ts", hash: "a" });
    expect(detector.isStuck()?.reason).toBe("repeat-edit");
  });
});
