import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { orchestrate } from "../../src/commands.js";
import type { WorkflowState } from "../../src/core.js";
import type { WorkUnit } from "../../src/core/types.js";
import type { EngineProcessSpawner } from "../../src/dispatch/session-types.js";

const SUMMARY =
  '```json\n{"skills_used":[],"files_changed":[],"commands_run":[],"tests_run":[],"confidence":0.9,"uncertainty":""}\n```';

function unit(name: string, over: Partial<WorkUnit> = {}): WorkUnit {
  return {
    name,
    status: "pending",
    confidence: 0,
    scope: [`src/${name}/`],
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    ...over,
  };
}

function writeState(base: string, units: WorkUnit[]): void {
  const ctx = join(base, ".vibeflow");
  mkdirSync(ctx, { recursive: true });
  const state: WorkflowState = {
    task_id: "TASK-W",
    goal: "wave goal",
    success_criteria: [],
    work_units: units,
    totals: { units: units.length, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
  writeFileSync(join(ctx, "WORKFLOW_STATE.json"), JSON.stringify(state, null, 2));
}

/** Injected spawner that records the prompt it was handed and returns a passing summary. */
function recordingSpawner(seen: Array<{ name: string; prompt: string }>): EngineProcessSpawner {
  return (_argv, options) => {
    const m = /^Work units: (.+)$/m.exec(options.stdinText ?? "");
    seen.push({ name: m?.[1]?.trim() ?? "", prompt: options.stdinText ?? "" });
    return {
      stdin: { write: () => {}, end: () => {} },
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                type: "result",
                session_id: "50c1c208-9518-44e7-9fc5-d63b0bfcbec2",
                result: SUMMARY,
              }),
            ),
          );
          controller.close();
        },
      }),
      stderr: new ReadableStream({ start: (controller) => controller.close() }),
      exited: Promise.resolve(0),
      kill: () => {},
    };
  };
}

function nameOf(prompt: string): string {
  const m = /^Work units: (.+)$/m.exec(prompt);
  return m?.[1]?.trim() ?? "";
}

function promptAt(seen: Array<{ name: string; prompt: string }>, i: number): string {
  return seen[i]?.prompt ?? "";
}

describe("orchestrate — wave-aware handoff (#612)", () => {
  test("no deps → single wave, every unit dispatched once, no upstream block (backward-compat)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wv-nodep-"));
    writeState(dir, [unit("a"), unit("b")]);
    const seen: Array<{ name: string; prompt: string }> = [];
    await orchestrate({ yes: true, engine: "claude", concurrency: "1" }, dir, {
      sessionRuntime: { processSpawner: recordingSpawner(seen) },
    });
    // Single wave ⇒ both units in one orchestrateUnits call, no upstream context injected.
    expect(seen.map((s) => s.name)).toEqual(["a", "b"]);
    expect(seen.every((s) => !s.prompt.includes("## Upstream context"))).toBe(true);
  });

  test("A→B dependency: B dispatched after A and carries A's handoff summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wv-ab-"));
    writeState(dir, [unit("a"), unit("b", { depends_on: ["a"] })]);
    const seen: Array<{ name: string; prompt: string }> = [];
    await orchestrate({ yes: true, engine: "claude", concurrency: "1" }, dir, {
      sessionRuntime: { processSpawner: recordingSpawner(seen) },
    });
    // Wave 0 = A, Wave 1 = B (serialized by the dependency).
    expect(seen.map((s) => s.name)).toEqual(["a", "b"]);
    // A (wave 0) gets no upstream context; B (wave 1) does.
    expect(promptAt(seen, 0)).not.toContain("## Upstream context");
    expect(promptAt(seen, 1)).toContain("## Upstream context");
    expect(promptAt(seen, 1)).toContain("a: ");
    expect(promptAt(seen, 1)).toContain("evidence item(s)");
  });

  test("diamond A→B, A→C, B&C→D: D sees both B and C handoffs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wv-diamond-"));
    writeState(dir, [
      unit("a"),
      unit("b", { depends_on: ["a"] }),
      unit("c", { depends_on: ["a"] }),
      unit("d", { depends_on: ["b", "c"] }),
    ]);
    const seen: Array<{ name: string; prompt: string }> = [];
    await orchestrate({ yes: true, engine: "claude", concurrency: "1" }, dir, {
      sessionRuntime: { processSpawner: recordingSpawner(seen) },
    });
    // a,b,c,d in dependency order.
    expect(seen.map((s) => s.name)).toEqual(["a", "b", "c", "d"]);
    const dPrompt = promptAt(seen, 3);
    expect(dPrompt).toContain("## Upstream context");
    expect(dPrompt).toContain("b: ");
    expect(dPrompt).toContain("c: ");
    expect(dPrompt).toContain("evidence item(s)");
  });

  test("dep on an already-complete (no-handoff) unit is filtered out, no crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wv-ghost-"));
    // A is already complete ⇒ skipped by orchestrate (not (re)dispatched), so no handoff.
    // B depends on A ⇒ its handoff lookup finds nothing and must not crash.
    writeState(dir, [
      unit("a", { status: "done", confidence: 1, evidence: ["a.log"] }),
      unit("b", { depends_on: ["a"] }),
    ]);
    const seen: Array<{ name: string; prompt: string }> = [];
    await orchestrate({ yes: true, engine: "claude", concurrency: "1" }, dir, {
      sessionRuntime: { processSpawner: recordingSpawner(seen) },
    });
    // Only B is dispatched (A was already complete).
    expect(seen.map((s) => s.name)).toEqual(["b"]);
    expect(promptAt(seen, 0)).not.toContain("## Upstream context");
  });

  test("dep on a non-existent unit is filtered out, no crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wv-missing-"));
    writeState(dir, [unit("e", { depends_on: ["ghost"] })]);
    const seen: Array<{ name: string; prompt: string }> = [];
    await orchestrate({ yes: true, engine: "claude", concurrency: "1" }, dir, {
      sessionRuntime: { processSpawner: recordingSpawner(seen) },
    });
    expect(seen.map((s) => s.name)).toEqual(["e"]);
    expect(seen.every((s) => !s.prompt.includes("## Upstream context"))).toBe(true);
    expect(nameOf(promptAt(seen, 0))).toBe("e");
  });
});

// --- Codex P1: antigravity engine must force concurrency=1 ---
describe("orchestrate — antigravity concurrency clamp", () => {
  test("antigravity forces concurrency 1 even when --concurrency is high", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ag-conc-"));
    const key = basename(dir);
    writeState(dir, [unit(`x-${key}`), unit(`y-${key}`)]);
    const seen: Array<{ name: string; prompt: string }> = [];
    let active = 0;
    let maxActive = 0;
    const baseSpawner = recordingSpawner(seen);
    const delayedSpawner: EngineProcessSpawner = (argv, options) => {
      const process = baseSpawner(argv, options);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return {
        ...process,
        exited: new Promise<number>((resolve) => {
          setTimeout(() => {
            active -= 1;
            resolve(0);
          }, 25);
        }),
      };
    };
    await orchestrate(
      { yes: true, engine: "antigravity", concurrency: "100", "no-unit-gate": true },
      dir,
      { sessionRuntime: { processSpawner: delayedSpawner } },
    );
    expect({ calls: seen.length, maxActive }).toEqual({ calls: 2, maxActive: 1 });
  });
});
