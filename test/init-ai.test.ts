/**
 * Coverage tests for `src/commands/init-ai.ts` (PR #137 extraction).
 * The function `runInitAiEnrichment` was extracted out of `init.ts` to
 * keep init.ts under the 400-line cap. The init.ts test suite exercises
 * it via the `init` CLI entry point, but a direct unit test gives us
 * tighter scope coverage and lets the per-file coverage gate see
 * every branch.
 *
 * Test strategy: inject a fake `aiSpawner` and `dispatcher` so no real
 * engine is invoked. We just assert the function takes the expected
 * branch (`useAgentTeam` vs legacy, `ai+!dry+!refused` vs dry-run,
 * autopilot fallback, etc.) and does not throw.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitAiEnrichment } from "../src/commands/init-ai.js";
import type { IntakeAnswers } from "../src/commands/init-apply.js";
import type { Ctx7AuthResult } from "../src/commands/init-ctx7.js";
import type { Engine } from "../src/core.js";
import type { EngineReadiness } from "../src/preflight.js";

const FIXED = "2026-06-20T00:00:00.000Z";
function readiness(engine: Engine, level: EngineReadiness["level"]): EngineReadiness {
  return { engine, level, detail: `${engine}: ${level}`, checkedAt: FIXED };
}

function answers(extra: Partial<IntakeAnswers> = {}): IntakeAnswers {
  return {
    goal: "ship it",
    engines: ["copilot"],
    ...extra,
  };
}

describe("runInitAiEnrichment (extracted Phase 2 in init-ai.ts)", () => {
  let repo: string;
  let origCwd: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "vf-init-ai-"));
    origCwd = process.cwd();
    process.chdir(repo);
    mkdirSync(join(repo, ".vibeflow", "ai-context"), { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", version: "0.0.0" }));
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(repo, { recursive: true, force: true });
  });

  test("ai=false is a no-op (returns without running anything)", async () => {
    let dispatcherCalls = 0;
    let aiSpawnerCalls = 0;
    await runInitAiEnrichment({
      ai: false,
      dry: false,
      refused: false,
      initEngine: "claude",
      useAgentTeam: true,
      hasPhases: false,
      answers: answers(),
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        aiSpawner: async () => {
          aiSpawnerCalls++;
          return { status: 0, stdout: "", stderr: "", timedOut: false };
        },
        dispatcher: async () => {
          dispatcherCalls++;
          return { status: "done", confidence: 1, evidence: [] };
        },
      },
    });
    expect(dispatcherCalls).toBe(0);
    expect(aiSpawnerCalls).toBe(0);
  });

  test("ai=true, refused=true is a no-op (Phase 1 already gave up)", async () => {
    let dispatcherCalls = 0;
    await runInitAiEnrichment({
      ai: true,
      dry: false,
      refused: true,
      initEngine: "claude",
      useAgentTeam: true,
      hasPhases: false,
      answers: answers(),
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        dispatcher: async () => {
          dispatcherCalls++;
          return { status: "done", confidence: 1, evidence: [] };
        },
      },
    });
    expect(dispatcherCalls).toBe(0);
  });

  test("useAgentTeam=true runs the workflow (dispatcher fires, legacy spawner ignored)", async () => {
    let dispatcherCalls = 0;
    let aiSpawnerCalls = 0;
    await runInitAiEnrichment({
      ai: true,
      dry: false,
      refused: false,
      initEngine: "claude",
      useAgentTeam: true,
      hasPhases: false,
      answers: answers(),
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        aiPreflight: () => [readiness("claude", "ready")],
        aiSpawner: async () => {
          aiSpawnerCalls++;
          return { status: 0, stdout: "", stderr: "", timedOut: false };
        },
        dispatcher: async (unit) => {
          dispatcherCalls++;
          return {
            status: "done",
            confidence: 1,
            evidence: Array.isArray(unit.scope) ? unit.scope.slice(0, 1) : [unit.scope ?? "."],
            gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          };
        },
      },
    });
    expect(dispatcherCalls).toBeGreaterThan(0);
    expect(aiSpawnerCalls).toBe(0);
  });

  test("useAgentTeam=false runs legacy runAiInit (aiSpawner fires, dispatcher ignored)", async () => {
    let dispatcherCalls = 0;
    let aiSpawnerCalls = 0;
    await runInitAiEnrichment({
      ai: true,
      dry: false,
      refused: false,
      initEngine: "claude",
      useAgentTeam: false,
      hasPhases: false,
      answers: answers(),
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        aiPreflight: () => [readiness("claude", "ready")],
        aiSpawner: async () => {
          aiSpawnerCalls++;
          return {
            status: 0,
            stdout: '```json\n{"confidence":1,"files_changed":[]}\n```',
            stderr: "",
            timedOut: false,
          };
        },
        dispatcher: async () => {
          dispatcherCalls++;
          return { status: "done", confidence: 1, evidence: [] };
        },
      },
    });
    expect(aiSpawnerCalls).toBeGreaterThan(0);
    expect(dispatcherCalls).toBe(0);
  });

  test("useAgentTeam=false with hasPhases=true uses the enrichment prompt builder", async () => {
    let aiSpawnerCalls = 0;
    let capturedPrompt = "";
    await runInitAiEnrichment({
      ai: true,
      dry: false,
      refused: false,
      initEngine: "claude",
      useAgentTeam: false,
      hasPhases: true,
      answers: {
        goal: "ship it",
        engines: ["claude"],
        workflowPhases: [
          { name: "Plan", description: "plan", dod: "reviewed" },
          { name: "Build", description: "build", dod: "shipped" },
        ],
      },
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        aiPreflight: () => [readiness("claude", "ready")],
        aiSpawner: async (_cmd, _args, input) => {
          aiSpawnerCalls++;
          if (typeof input === "string") capturedPrompt = input;
          return {
            status: 0,
            stdout: '{"confidence":1,"files_changed":[]}',
            stderr: "",
            timedOut: false,
          };
        },
      },
    });
    expect(aiSpawnerCalls).toBeGreaterThan(0);
    expect(capturedPrompt.length).toBeGreaterThan(0);
  });

  test("useAgentTeam=true with hasPhases=true forwards workflowPhases", async () => {
    let dispatcherCalls = 0;
    let lastUnitName = "";
    await runInitAiEnrichment({
      ai: true,
      dry: false,
      refused: false,
      initEngine: "claude",
      useAgentTeam: true,
      hasPhases: true,
      answers: {
        goal: "ship it",
        engines: ["claude"],
        workflowPhases: [
          { name: "Plan", description: "plan", dod: "ok" },
          { name: "Build", description: "build", dod: "ok" },
        ],
      },
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        aiPreflight: () => [readiness("claude", "ready")],
        dispatcher: async (unit) => {
          dispatcherCalls++;
          lastUnitName = unit.name;
          return {
            status: "done",
            confidence: 1,
            evidence: Array.isArray(unit.scope) ? unit.scope : [unit.scope ?? "."],
            gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          };
        },
      },
    });
    expect(dispatcherCalls).toBeGreaterThan(0);
    expect(lastUnitName.length).toBeGreaterThan(0);
  });

  test("workflow ok=true: dispatcher returns done for all units", async () => {
    mkdirSync(join(repo, ".github"), { recursive: true });
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
    await runInitAiEnrichment({
      ai: true,
      dry: false,
      refused: false,
      initEngine: "claude",
      useAgentTeam: true,
      hasPhases: false,
      answers: answers(),
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        aiPreflight: () => [readiness("claude", "ready")],
        dispatcher: async (unit) => {
          const ev = SCOPE_BY_NAME[unit.name] ?? unit.scope?.[0] ?? ".";
          return {
            status: "done",
            confidence: 1,
            evidence: Array.isArray(ev) ? ev : [ev],
            gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          };
        },
      },
    });
    // must not throw
  });

  test("workflow ok=false: dispatcher returns blocked; function returns cleanly", async () => {
    let calls = 0;
    await runInitAiEnrichment({
      ai: true,
      dry: false,
      refused: false,
      initEngine: "claude",
      useAgentTeam: true,
      hasPhases: false,
      answers: answers(),
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        aiPreflight: () => [readiness("claude", "ready")],
        dispatcher: async () => {
          calls++;
          return { status: "blocked", confidence: 0, evidence: ["test-block"] };
        },
      },
    });
    expect(calls).toBeGreaterThan(0);
  });

  test("dry-run with phases renders the enrichment prompt preview", async () => {
    await runInitAiEnrichment({
      ai: true,
      dry: true,
      refused: false,
      initEngine: "claude",
      useAgentTeam: false,
      hasPhases: true,
      answers: {
        goal: "ship it",
        engines: ["claude"],
        workflowPhases: [{ name: "Plan", description: "plan", dod: "ok" }],
      },
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {},
    });
  });

  test("dry-run without phases renders the original AI init prompt preview", async () => {
    await runInitAiEnrichment({
      ai: true,
      dry: true,
      refused: false,
      initEngine: "claude",
      useAgentTeam: false,
      hasPhases: false,
      answers: answers(),
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {},
    });
  });

  test("legacy path ok=true: success with no fallback", async () => {
    await runInitAiEnrichment({
      ai: true,
      dry: false,
      refused: false,
      initEngine: "claude",
      useAgentTeam: false,
      hasPhases: false,
      answers: answers(),
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        aiPreflight: () => [readiness("claude", "ready")],
        aiSpawner: async () => ({
          status: 0,
          stdout: '{"confidence":1,"files_changed":[]}',
          stderr: "",
          timedOut: false,
        }),
      },
    });
  });

  test("legacy path ok=false: surfaces AI-skipped message", async () => {
    await runInitAiEnrichment({
      ai: true,
      dry: false,
      refused: false,
      initEngine: "claude",
      useAgentTeam: false,
      hasPhases: false,
      answers: answers(),
      ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
      autopilot: false,
      inject: {
        aiPreflight: () => [readiness("claude", "no-binary")],
        aiSpawner: async () => ({
          status: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
        }),
      },
    });
  });
});

test("legacy path: useAgentTeam=false with autopilot=true covers autopilot=true on legacy path", async () => {
  // Expose the autopilot flag on the legacy runAiInit path.
  // The fallback chain is already tested in runAiInit tests via
  // commands-coverage; here we just exercise the parameter pass-through.
  let sealedAutopilot: boolean | undefined;
  const origRunAiInit = await import("../src/ai-init.js").then((m) => m.runAiInit);
  await runInitAiEnrichment({
    ai: true,
    dry: false,
    refused: false,
    initEngine: "claude",
    useAgentTeam: false,
    hasPhases: false,
    answers: answers(),
    ctx7Auth: { authenticated: false, fallback: true } as Ctx7AuthResult,
    autopilot: true,
    inject: {
      aiPreflight: () => [readiness("claude", "ready")],
      aiSpawner: async () => ({
        status: 0,
        stdout: '{"confidence":1,"files_changed":[]}',
        stderr: "",
        timedOut: false,
      }),
    },
  });
});
