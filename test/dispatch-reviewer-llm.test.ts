import { describe, expect, test } from "bun:test";
import {
  getUnitDiff,
  makeVibflowLLMFn,
  runLLMReview,
} from "../src/commands/dispatch-reviewer-llm.js";

describe("runLLMReview (ADR-001)", () => {
  test("calls llmFn with isolated prompt containing goal and diff", async () => {
    let capturedPrompt = "";
    const llmFn = async (p: string) => {
      capturedPrompt = p;
      return "COVERED";
    };
    const result = await runLLMReview({ goal: "add X", diff: "diff output", llmFn });
    expect(result.pass).toBe(true);
    expect(capturedPrompt).toContain("You have NOT seen the implementation process");
    expect(capturedPrompt).toContain("add X");
    expect(capturedPrompt).toContain("diff output");
  });

  test("pass=false when LLM does not respond COVERED", async () => {
    const llmFn = async () => "Missing edge case: empty string input not handled";
    const result = await runLLMReview({ goal: "g", diff: "d", llmFn });
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("Missing edge case");
  });

  test("includes spec in prompt when provided", async () => {
    let capturedPrompt = "";
    const llmFn = async (p: string) => {
      capturedPrompt = p;
      return "COVERED";
    };
    await runLLMReview({ goal: "g", spec: "fn() uppercase", diff: "d", llmFn });
    expect(capturedPrompt).toContain("fn() uppercase");
  });

  test("prompt does NOT contain dispatch context", async () => {
    let capturedPrompt = "";
    const llmFn = async (p: string) => {
      capturedPrompt = p;
      return "COVERED";
    };
    await runLLMReview({ goal: "g", diff: "d", llmFn });
    expect(capturedPrompt).not.toContain("dispatch");
    expect(capturedPrompt).not.toContain("self-report");
  });

  test("cross-tool: reviewerEngine differs from implementer when 2nd engine available", async () => {
    const llmFn = async () => "COVERED";
    const r = await runLLMReview({
      goal: "g",
      diff: "d",
      llmFn,
      implementer: "claude",
      available: ["claude", "codex"],
    });
    expect(r.reviewerEngine).toBe("codex");
    expect(r.warning).toBeUndefined();
  });

  test("same-family: warning emitted when only implementer engine available", async () => {
    const llmFn = async () => "COVERED";
    const r = await runLLMReview({
      goal: "g",
      diff: "d",
      llmFn,
      implementer: "claude",
      available: ["claude"],
    });
    expect(r.reviewerEngine).toBe("claude");
    expect(r.warning).toContain("same-tool review has correlated blind spots");
  });
});

// --- ADR-001: getUnitDiff + makeVibflowLLMFn coverage ---
describe("getUnitDiff (ADR-001)", () => {
  test("returns empty string when git fails", () => {
    // cwd = /tmp which has no git repo → spawnSync exit non-zero
    const diff = getUnitDiff("/tmp/nonexistent-repo-12345", ["src/"]);
    expect(typeof diff).toBe("string");
  });

  test("returns string from valid repo", () => {
    const diff = getUnitDiff(process.cwd(), []);
    expect(typeof diff).toBe("string");
  });

  test("spawner throws (ENOENT) → catch returns empty string", () => {
    let called = false;
    const diff = getUnitDiff(process.cwd(), ["src/"], () => {
      called = true;
      throw new Error("ENOENT: git not found");
    });
    expect(called).toBe(true);
    expect(diff).toBe("");
  });
});

describe("makeVibflowLLMFn (ADR-001)", () => {
  test("returns undefined when VIBEFLOW_AI not set", () => {
    const orig = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = undefined;
    expect(makeVibflowLLMFn()).toBeUndefined();
    if (orig !== undefined) process.env.VIBEFLOW_AI = orig;
  });

  test("returns a function when VIBEFLOW_AI is set", () => {
    const orig = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "echo COVERED";
    const fn = makeVibflowLLMFn();
    expect(typeof fn).toBe("function");
    if (orig === undefined) process.env.VIBEFLOW_AI = undefined;
    else process.env.VIBEFLOW_AI = orig;
  });

  test("returned fn calls VIBEFLOW_AI bridge and returns stdout", async () => {
    const orig = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "echo COVERED";
    const fn = makeVibflowLLMFn();
    const result = (await fn?.("test prompt")) ?? "";
    expect(result.trim()).toBe("COVERED");
    if (orig === undefined) process.env.VIBEFLOW_AI = undefined;
    else process.env.VIBEFLOW_AI = orig;
  });
});
