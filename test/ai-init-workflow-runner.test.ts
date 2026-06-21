import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiInitUnit } from "../src/ai-init-workflow.js";
import { defaultAiInitDispatcher, runAiInitWorkflow } from "../src/ai-init.js";
import type { Engine } from "../src/core.js";
import type { EngineCommandResult } from "../src/dispatch.js";
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
    writeFileSync(join(repo, "QUICKSTART.md"), "# quickstart\n");
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

  test("dispatches 8 units, returns per-unit reviews + ok=true when reviewer passes", async () => {
    // P1-7: with batchFinishers=true (the default), the 4 separate
    // finisher adapters are collapsed into a single
    // `ai-init-finishers-batch` unit. Total dispatch count drops
    // from 8 to 5. The dispatcher returns evidence citing the
    // batch unit's first scope path so the reviewer's all-or-
    // nothing gate can verify all 4 files.
    const SCOPE_BY_NAME: Record<string, string | string[]> = {
      "ai-init-analyzer": ".vibeflow/ai-context/stack-evidence.md",
      "ai-init-instruction-writer": "CLAUDE.md",
      "ai-init-skill-curator": ".vibeflow/SKILL_INDEX.md",
      "ai-init-context-updater": ".vibeflow/PROJECT_CONTEXT.md",
      "ai-init-finishers-batch": [
        ".vibeflow/SETTINGS.json",
        ".vibeflow/WORKFLOW_POLICY.md",
        ".vibeflow/WORKFLOW_STATE.json",
        "QUICKSTART.md",
      ],
    };
    const dispatcher: UnitDispatcher = async (unit) => {
      const ev = SCOPE_BY_NAME[unit.name] ?? unit.scope?.[0] ?? "src/cli.ts";
      return {
        status: "done",
        confidence: 1,
        evidence: Array.isArray(ev) ? ev : [ev],
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
    expect(result.units).toHaveLength(5);
    expect(result.reviews).toHaveLength(5);
    expect(result.reviews.every((r) => r.pass)).toBe(true);
    expect(result.units.every((u) => u.status === "done")).toBe(true);
    expect(result.units.every((u) => u.confidence === 1)).toBe(true);
  });

  test("uses the forced engine as instruction-writer scope when intake omits engines", async () => {
    // P1-7: the 4 finisher units are batched into one. Dispatcher
    // must cite every finisher output path in evidence so the
    // batched reviewer's all-or-nothing check passes.
    const SCOPE_BY_NAME: Record<string, string | string[]> = {
      "ai-init-analyzer": ".vibeflow/ai-context/stack-evidence.md",
      "ai-init-instruction-writer": "AGENTS.md",
      "ai-init-skill-curator": ".vibeflow/SKILL_INDEX.md",
      "ai-init-context-updater": ".vibeflow/PROJECT_CONTEXT.md",
      "ai-init-finishers-batch": [
        ".vibeflow/SETTINGS.json",
        ".vibeflow/WORKFLOW_POLICY.md",
        ".vibeflow/WORKFLOW_STATE.json",
        "QUICKSTART.md",
      ],
    };
    const scopes: Record<string, string[]> = {};
    const dispatcher: UnitDispatcher = async (unit) => {
      scopes[unit.name] = unit.scope ?? [];
      const ev = SCOPE_BY_NAME[unit.name] ?? "src/cli.ts";
      return {
        status: "done",
        confidence: 1,
        evidence: Array.isArray(ev) ? ev : [ev],
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

  test("phase units from intake.workflowPhases are not dispatched (filtered out before review)", async () => {
    // The runner filters out phase units (`ai-init-phase-*`) from the
    // dispatch set because the workflow-state-writer adapter already
    // encodes the phases into WORKFLOW_STATE.json. This test pins the
    // contract so a regression that starts dispatching phase units is
    // caught immediately.
    const dispatcher: UnitDispatcher = async (unit) => ({
      status: "done",
      confidence: 1,
      evidence: [".vibeflow/ai-context/stack-evidence.md"],
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
    const phaseNames = result.units.filter((u) => u.name.startsWith("ai-init-phase-"));
    expect(phaseNames).toEqual([]);
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
      "ai-init-quickstart-writer": "QUICKSTART.md",
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

  test("preflight is called with [forceEngine] only (not all engines) when forceEngine is set", async () => {
    // Issue 3: previously `runAiInitWorkflow` probed all 3 engines just to look
    // up the forced one in the readiness array — ~2 wasted CLI calls per init.
    // Now the array is narrowed to [forceEngine].
    let probed: Engine[] = [];
    const dispatcher: UnitDispatcher = async (unit) => ({
      status: "done",
      confidence: 1,
      evidence: [".vibeflow/ai-context/stack-evidence.md"],
      gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
    });
    await runAiInitWorkflow({
      base: repo,
      intake: { goal: "x" },
      forceEngine: "copilot",
      preflight: (engines) => {
        probed = engines;
        return [readiness("copilot", "ready")];
      },
      dispatcher,
    });
    expect(probed).toEqual(["copilot"]);
  });

  test("preflight still probes all engines when forceEngine is unset (best-engine selection)", async () => {
    // Counterpart: without forceEngine, the planner must still see all engines
    // so `selectBestEngine` can pick. Don't over-narrow this path.
    let probed: Engine[] = [];
    const dispatcher: UnitDispatcher = async (unit) => ({
      status: "done",
      confidence: 1,
      evidence: [".vibeflow/ai-context/stack-evidence.md"],
      gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
    });
    await runAiInitWorkflow({
      base: repo,
      intake: { goal: "x" },
      preflight: (engines) => {
        probed = engines;
        return [readiness("claude", "ready"), readiness("copilot", "ready")];
      },
      dispatcher,
    });
    expect(probed.length).toBeGreaterThan(1);
  });
});

describe("defaultAiInitDispatcher — engine warning surfacing", () => {
  test("writes the copilot --version warning to stderr (was previously swallowed in the agent-team path)", async () => {
    // Issue 1: `engineCommand("copilot")` returns `warning` when the CLI's
    // version can't be detected (the github/copilot-cli#1606 silent-breaking-
    // update class). The legacy `runAiInit` path surfaces this via
    // `announceLaunch`; the agent-team path (defaultAiInitDispatcher) used
    // to drop it. Now the dispatcher probes the invocation once at
    // construction and writes the warning to stderr on first unit dispatch.
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const WARNING = "could not determine `copilot --version`; verify `copilot -p` still works";
      const engineCommandFn = (): EngineCommandResult => ({
        cmd: "copilot",
        args: ["-p", "--allow-all"],
        promptMode: "arg",
        warning: WARNING,
      });
      const dispatcher = defaultAiInitDispatcher("copilot", {
        engineCommandFn,
        // The warning fires before the spawner call (after `isUnavailable`
        // check, before `materializePrompt` + `asyncSpawn`), so any
        // sensible success-style spawner proves the ordering without
        // coupling to it.
        spawner: async () => ({ status: 0, stdout: "" }),
      });
      const unit: AiInitUnit = {
        name: "ai-init-analyzer",
        status: "pending",
        confidence: 0,
        scope: [".vibeflow/ai-context/stack-evidence.md"],
        acceptance: "stack-evidence.md written",
        depends_on: [],
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      };
      const outcome = await dispatcher(unit);
      expect(outcome.status).toBe("verifying");
      expect(outcome.confidence).toBe(1);
      const stderr = stderrChunks.join("");
      expect(stderr).toContain("[ai-init-dispatcher]");
      expect(stderr).toContain("copilot");
      expect(stderr).toContain(WARNING);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("emits the warning once even when the dispatcher handles many units (warn-once)", async () => {
    // The warning is per-installation, not per-unit — emitting it 7 times
    // (once per adapter in the agent-team run) would be stderr noise.
    // Probe-once-at-construction + warnedDegraded flag handles this.
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const WARNING = "synthetic warning";
      const dispatcher = defaultAiInitDispatcher("copilot", {
        engineCommandFn: (): EngineCommandResult => ({
          cmd: "copilot",
          args: ["-p"],
          promptMode: "arg",
          warning: WARNING,
        }),
        spawner: async () => ({ status: 0, stdout: "" }),
      });
      const unit: AiInitUnit = {
        name: "ai-init-analyzer",
        status: "pending",
        confidence: 0,
        scope: [".vibeflow/ai-context/stack-evidence.md"],
        acceptance: "stack-evidence.md written",
        depends_on: [],
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      };
      await dispatcher(unit);
      await dispatcher(unit);
      await dispatcher(unit);
      const stderr = stderrChunks.join("");
      const occurrences = stderr.split(WARNING).length - 1;
      expect(occurrences).toBe(1);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe("runAiInitWorkflow: quota-aware finisher skip (top-level)", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "vf-quota-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", version: "0.0.0" }));
    writeFileSync(join(repo, "src", "cli.ts"), "// cli");
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
    writeFileSync(join(repo, "QUICKSTART.md"), "# quickstart\n");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  test("skips finisher batch when quota is below threshold", async () => {
    const dispatcherNames: string[] = [];
    const result = await runAiInitWorkflow({
      base: repo,
      intake: { goal: "skip-test" },
      forceEngine: "claude",
      preflight: () => [readiness("claude", "ready")],
      quotaStatus: { level: "ready" as const, percentRemaining: 5 },
      quotaSkipFinisherBelowPct: 10,
      dispatcher: async (unit) => {
        dispatcherNames.push(unit.name);
        return {
          status: "done",
          confidence: 1,
          evidence: unit.scope ?? [".vibeflow/ai-context/stack-evidence.md"],
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        };
      },
    });
    expect(dispatcherNames).not.toContain("ai-init-finishers-batch");
    expect(dispatcherNames).toContain("ai-init-analyzer");
  });

  test("keeps finisher batch when quota is above threshold", async () => {
    const dispatcherNames: string[] = [];
    const result = await runAiInitWorkflow({
      base: repo,
      intake: { goal: "keep-test" },
      forceEngine: "claude",
      preflight: () => [readiness("claude", "ready")],
      quotaStatus: { level: "ready" as const, percentRemaining: 50 },
      quotaSkipFinisherBelowPct: 20,
      dispatcher: async (unit) => {
        dispatcherNames.push(unit.name);
        return {
          status: "done",
          confidence: 1,
          evidence: unit.scope ?? [".vibeflow/ai-context/stack-evidence.md"],
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        };
      },
    });
    expect(dispatcherNames).toContain("ai-init-finishers-batch");
    expect(result.goalMet).toBe(true);
  });

  test("skips nothing when no quotaStatus is provided", async () => {
    const dispatcherNames: string[] = [];
    const result = await runAiInitWorkflow({
      base: repo,
      intake: { goal: "no-quota-test" },
      forceEngine: "claude",
      preflight: () => [readiness("claude", "ready")],
      dispatcher: async (unit) => {
        dispatcherNames.push(unit.name);
        return {
          status: "done",
          confidence: 1,
          evidence: unit.scope ?? [".vibeflow/ai-context/stack-evidence.md"],
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        };
      },
    });
    expect(dispatcherNames).toContain("ai-init-finishers-batch");
    expect(result.goalMet).toBe(true);
  });
});
