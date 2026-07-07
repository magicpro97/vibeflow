import { describe, expect, test } from "bun:test";
import { collectVerifyReportAsync, parseGoalScore } from "../src/commands/tools-detect.js";

// #545: the judge appends `SCORE: 0.NN` (P(goal met)). Parse it, clamp [0,1],
// fail-open (undefined) when absent/malformed so it never hardens a green path.
describe("parseGoalScore (#545 calibrated judge score)", () => {
  test("parses a well-formed trailing SCORE line", () => {
    expect(parseGoalScore("COVERED\n...reasons...\nSCORE: 0.72")).toBe(0.72);
  });
  test("last-wins when the judge mentions score more than once (trailing is the verdict)", () => {
    // W1: the contract is a TRAILING `SCORE:` line; prose earlier must not win.
    expect(parseGoalScore("I tentatively score: 0.2 ...\nSCORE: 0.9")).toBe(0.9);
  });
  test("parses integer and 1.0 / 0", () => {
    expect(parseGoalScore("SCORE: 1")).toBe(1);
    expect(parseGoalScore("SCORE: 0")).toBe(0);
    expect(parseGoalScore("score: 1.0")).toBe(1);
  });
  test("accepts a leading-dot fraction (.5)", () => {
    expect(parseGoalScore("SCORE: .5")).toBe(0.5);
  });
  test("case-insensitive, tolerates a trailing-line match", () => {
    expect(parseGoalScore("blah\nScore:  0.5")).toBe(0.5);
  });
  test("clamps out-of-range values", () => {
    expect(parseGoalScore("SCORE: 9")).toBe(1);
    expect(parseGoalScore("SCORE: -2")).toBe(0);
  });
  test("scientific notation is REJECTED, not truncated-then-inflated", () => {
    // W2: `5e-1` (=0.5) must NOT parse as `5`→clamp 1.0 (a malformed score that
    // inflates a green path is the exact fail-open violation we forbid).
    expect(parseGoalScore("SCORE: 5e-1")).toBeUndefined();
  });
  test("absent → undefined (fail-open)", () => {
    expect(parseGoalScore("COVERED no score here")).toBeUndefined();
    expect(parseGoalScore("")).toBeUndefined();
  });
  test("malformed number → undefined", () => {
    expect(parseGoalScore("SCORE: abc")).toBeUndefined();
  });
});

describe("collectVerifyReportAsync threads goal score into the report (#545)", () => {
  // Green toolchain via injected spawner (status 0), goal + goalEvalFn provided →
  // the report surfaces the judge's calibrated score for the UI/ledger.
  const greenSpawn = async () => ({ status: 0 });
  test("goalEvalFn score flows to report.goalEval.score", async () => {
    const r = await collectVerifyReportAsync("/tmp/nonexistent-repo", {
      spawner: greenSpawn,
      goal: "ship X",
      goalEvalFn: async () => ({ covered: true, uncovered: [], score: 0.77 }),
    });
    expect(r.goalEval?.score).toBe(0.77);
    expect(r.goalEval?.pass).toBe(true);
  });
  test("absent score → report.goalEval.score undefined (fail-open)", async () => {
    const r = await collectVerifyReportAsync("/tmp/nonexistent-repo", {
      spawner: greenSpawn,
      goal: "ship X",
      goalEvalFn: async () => ({ covered: false, uncovered: ["missing Y"] }),
    });
    expect(r.goalEval?.score).toBeUndefined();
    expect(r.goalEval?.pass).toBe(false);
  });
});
