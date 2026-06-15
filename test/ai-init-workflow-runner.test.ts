import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAiInitWorkflow } from "../src/ai-init.js";
import type { Engine } from "../src/core.js";
import type { UnitDispatcher } from "../src/orchestrator/run.js";
import type { EngineReadiness } from "../src/preflight.js";

const FIXED = "2026-06-15T00:00:00.000Z";
function readiness(engine: Engine, level: EngineReadiness["level"]): EngineReadiness {
  return { engine, level, detail: `${engine}: ${level}`, checkedAt: FIXED };
}

describe("runAiInitWorkflow", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "vf-ai-workflow-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", version: "0.0.0" }));
    writeFileSync(join(repo, "src", "cli.ts"), "// cli");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("returns ok=false with reason when no engine is ready", async () => {
    const result = await runAiInitWorkflow({
      base: repo,
      intake: { goal: "ship it" },
      preflight: () => [readiness("claude", "no-binary")],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no ready engine");
    expect(result.units).toEqual([]);
    expect(result.reviews).toEqual([]);
    expect(result.goalMet).toBe(false);
  });

  test("returns ok=false with reason when forced engine is not ready", async () => {
    const result = await runAiInitWorkflow({
      base: repo,
      intake: {},
      forceEngine: "claude",
      preflight: () => [readiness("claude", "no-binary")],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("claude is not ready");
  });

  test("dispatches 7 units, returns per-unit reviews + ok=true when reviewer passes", async () => {
    const dispatcher: UnitDispatcher = async (unit) => {
      return {
        status: "done",
        confidence: 1,
        evidence: unit.scope ?? [],
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
      };
    };
    const result = await runAiInitWorkflow({
      base: repo,
      intake: { goal: "add web UI" },
      forceEngine: "claude",
      preflight: () => [readiness("claude", "ready")],
      dispatcher,
    });
    expect(result.ok).toBe(true);
    expect(result.goalMet).toBe(true);
    expect(result.units).toHaveLength(7);
    expect(result.reviews).toHaveLength(7);
    expect(result.reviews.every((r) => r.pass)).toBe(true);
    expect(result.units.every((u) => u.status === "done")).toBe(true);
    expect(result.units.every((u) => u.confidence === 1)).toBe(true);
  });

  test("includes phase units in the dispatch set when intake.workflowPhases is set", async () => {
    const dispatcher: UnitDispatcher = async (unit) => {
      return {
        status: "done",
        confidence: 1,
        evidence: unit.scope ?? [],
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
      };
    };
    const result = await runAiInitWorkflow({
      base: repo,
      intake: {
        workflowPhases: [
          { name: "analyze", description: "x", dod: "x" },
          { name: "ship", description: "y", dod: "y" },
        ],
      },
      forceEngine: "claude",
      preflight: () => [readiness("claude", "ready")],
      dispatcher,
    });
    expect(result.units).toHaveLength(9);
    expect(result.units.map((u) => u.name).slice(7)).toEqual([
      "ai-init-phase-analyze-1",
      "ai-init-phase-ship-2",
    ]);
  });

  test("returns ok=false when reviewer rejects one unit (instruction-writer with no evidence)", async () => {
    const dispatcher: UnitDispatcher = async (unit) => {
      if (unit.name === "ai-init-instruction-writer") {
        return { status: "done", confidence: 1, evidence: [] };
      }
      return {
        status: "done",
        confidence: 1,
        evidence: unit.scope ?? [],
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
      };
    };
    const result = await runAiInitWorkflow({
      base: repo,
      intake: {},
      forceEngine: "claude",
      preflight: () => [readiness("claude", "ready")],
      dispatcher,
    });
    expect(result.ok).toBe(false);
    expect(result.goalMet).toBe(false);
    const failed = result.reviews.filter((r) => !r.pass);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.unit).toBe("ai-init-instruction-writer");
    const blockedUnit = result.units.find((u) => u.name === "ai-init-instruction-writer");
    expect(blockedUnit?.status).toBe("blocked");
  });

  test("goalMet reflects every unit passing review", async () => {
    const dispatcher: UnitDispatcher = async (unit) => {
      if (unit.name === "ai-init-analyzer") {
        return { status: "done", confidence: 0.5, evidence: unit.scope ?? [] };
      }
      return {
        status: "done",
        confidence: 1,
        evidence: unit.scope ?? [],
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
      };
    };
    const result = await runAiInitWorkflow({
      base: repo,
      intake: {},
      forceEngine: "claude",
      preflight: () => [readiness("claude", "ready")],
      dispatcher,
    });
    expect(result.goalMet).toBe(false);
    expect(result.ok).toBe(false);
    const analyzerReview = result.reviews.find((r) => r.unit === "ai-init-analyzer");
    expect(analyzerReview?.pass).toBe(false);
  });
});
