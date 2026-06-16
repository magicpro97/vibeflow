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
    // MINOR-2/3/4: the reviewer now requires cited files to exist on
    // disk. Pre-create the AI-init framework files the adapter units
    // will cite as evidence.
    mkdirSync(join(repo, ".vibeflow", "ai-context"), { recursive: true });
    mkdirSync(join(repo, ".github"), { recursive: true });
    writeFileSync(join(repo, ".vibeflow/ai-context/stack-evidence.md"), "# stack\n");
    writeFileSync(join(repo, "CLAUDE.md"), "# claude\n");
    writeFileSync(join(repo, "AGENTS.md"), "# agents\n");
    writeFileSync(join(repo, ".github/copilot-instructions.md"), "# copilot\n");
    mkdirSync(join(repo, ".vibeflow", "skills"), { recursive: true });
    writeFileSync(join(repo, ".vibeflow/SKILL_INDEX.md"), "# index\n");
    writeFileSync(join(repo, ".vibeflow/PROJECT_CONTEXT.md"), "# ctx\n");
    writeFileSync(join(repo, ".vibeflow/SETTINGS.json"), "{}");
    writeFileSync(join(repo, ".vibeflow/WORKFLOW_POLICY.md"), "# policy\n");
    writeFileSync(join(repo, ".vibeflow/WORKFLOW_STATE.json"), "{}");
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
    // MINOR-2/3/4: cite each adapter's required acceptance file
    // (pre-created in beforeEach) so the reviewer's evidence + file-exists
    // checks pass.
    const SCOPE_BY_NAME: Record<string, string> = {
      "ai-init-analyzer": ".vibeflow/ai-context/stack-evidence.md",
      "ai-init-instruction-writer": "CLAUDE.md",
      "ai-init-skill-curator": ".vibeflow/SKILL_INDEX.md",
      "ai-init-context-updater": ".vibeflow/PROJECT_CONTEXT.md",
      "ai-init-tool-configurator": ".vibeflow/SETTINGS.json",
      "ai-init-workflow-policy-writer": ".vibeflow/WORKFLOW_POLICY.md",
      "ai-init-workflow-state-writer": ".vibeflow/WORKFLOW_STATE.json",
    };
    const dispatcher: UnitDispatcher = async (unit) => ({
      status: "done",
      confidence: 1,
      evidence: [SCOPE_BY_NAME[unit.name] ?? "src/cli.ts"],
      gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
    });
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

  test("uses the forced engine as instruction-writer scope when intake omits engines", async () => {
    const SCOPE_BY_NAME: Record<string, string> = {
      "ai-init-analyzer": ".vibeflow/ai-context/stack-evidence.md",
      "ai-init-instruction-writer": "AGENTS.md",
      "ai-init-skill-curator": ".vibeflow/SKILL_INDEX.md",
      "ai-init-context-updater": ".vibeflow/PROJECT_CONTEXT.md",
      "ai-init-tool-configurator": ".vibeflow/SETTINGS.json",
      "ai-init-workflow-policy-writer": ".vibeflow/WORKFLOW_POLICY.md",
      "ai-init-workflow-state-writer": ".vibeflow/WORKFLOW_STATE.json",
    };
    const scopes: Record<string, string[]> = {};
    const dispatcher: UnitDispatcher = async (unit) => {
      scopes[unit.name] = unit.scope ?? [];
      return {
        status: "done",
        confidence: 1,
        evidence: [SCOPE_BY_NAME[unit.name] ?? "src/cli.ts"],
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
      };
    };
    const result = await runAiInitWorkflow({
      base: repo,
      intake: {},
      forceEngine: "copilot",
      preflight: () => [readiness("copilot", "ready")],
      dispatcher,
    });
    expect(result.ok).toBe(true);
    expect(scopes["ai-init-instruction-writer"]).toEqual([
      "AGENTS.md",
      ".github/copilot-instructions.md",
    ]);
  });

  test("includes phase units in the dispatch set when intake.workflowPhases is set", async () => {
    // MINOR-3: phase units now go through file-exists review. Cite a
    // real file (pre-created in beforeEach) so the reviewer passes.
    const SCOPE_BY_NAME: Record<string, string> = {
      "ai-init-analyzer": ".vibeflow/ai-context/stack-evidence.md",
      "ai-init-instruction-writer": "CLAUDE.md",
      "ai-init-skill-curator": ".vibeflow/SKILL_INDEX.md",
      "ai-init-context-updater": ".vibeflow/PROJECT_CONTEXT.md",
      "ai-init-tool-configurator": ".vibeflow/SETTINGS.json",
      "ai-init-workflow-policy-writer": ".vibeflow/WORKFLOW_POLICY.md",
      "ai-init-workflow-state-writer": ".vibeflow/WORKFLOW_STATE.json",
    };
    const dispatcher: UnitDispatcher = async (unit) => ({
      status: "done",
      confidence: 1,
      evidence: [SCOPE_BY_NAME[unit.name] ?? "src/cli.ts"],
      gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
    });
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
    const SCOPE_BY_NAME: Record<string, string> = {
      "ai-init-analyzer": ".vibeflow/ai-context/stack-evidence.md",
      "ai-init-instruction-writer": "CLAUDE.md",
      "ai-init-skill-curator": ".vibeflow/SKILL_INDEX.md",
      "ai-init-context-updater": ".vibeflow/PROJECT_CONTEXT.md",
      "ai-init-tool-configurator": ".vibeflow/SETTINGS.json",
      "ai-init-workflow-policy-writer": ".vibeflow/WORKFLOW_POLICY.md",
      "ai-init-workflow-state-writer": ".vibeflow/WORKFLOW_STATE.json",
    };
    const dispatcher: UnitDispatcher = async (unit) => {
      if (unit.name === "ai-init-instruction-writer") {
        return { status: "done", confidence: 1, evidence: [] };
      }
      // MINOR-2/3/4: cite each adapter's own required file
      return {
        status: "done",
        confidence: 1,
        evidence: [SCOPE_BY_NAME[unit.name] ?? "src/cli.ts"],
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
