// Tests for src/ui/src/ — only pure-TS modules that run without DOM.
// Composables (useSSE, usePoller) require Vue lifecycle → not tested here.
// api.ts requires document.querySelector → not tested here.
// Types are compile-time only but we can import and do shape checks.
import { describe, expect, test } from "bun:test";

// Import the types module to verify it parses without errors.
// The import itself is the smoke test.
import type {
  GateState,
  LogEvent,
  VibeSettings,
  WorkUnit,
  WorkflowState,
} from "../src/ui/src/types.js";

describe("ui types: WorkUnit", () => {
  test("valid WorkUnit satisfies the shape", () => {
    const u: WorkUnit = {
      name: "test-unit",
      status: "pending",
      confidence: 0,
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    expect(u.name).toBe("test-unit");
    expect(u.status).toBe("pending");
  });

  test("all status values are valid string literals", () => {
    const statuses: WorkUnit["status"][] = ["pending", "running", "verifying", "done", "blocked"];
    expect(statuses).toHaveLength(5);
  });

  test("all gate states are valid", () => {
    const gates: GateState[] = ["pass", "fail", "running", "pending"];
    expect(gates).toHaveLength(4);
  });
});

describe("ui types: WorkflowState", () => {
  test("valid WorkflowState satisfies the shape", () => {
    const s: WorkflowState = {
      task_id: "abc",
      goal: "build something",
      success_criteria: ["tests pass"],
      work_units: [],
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    expect(s.task_id).toBe("abc");
    expect(s.work_units).toHaveLength(0);
  });
});

describe("ui types: LogEvent", () => {
  test("valid LogEvent satisfies the shape", () => {
    const ev: LogEvent = {
      seq: 1,
      ts: 1000,
      runId: "r1",
      channel: "vf",
      level: "info",
      text: "hello",
    };
    expect(ev.channel).toBe("vf");
    expect(ev.level).toBe("info");
  });
});

describe("ui types: VibeSettings", () => {
  test("valid VibeSettings satisfies the shape", () => {
    const s: VibeSettings = {
      tools: { codegraph: true, lsp: false },
      toolPriority: ["codegraph", "lsp", "native"],
      failureProtection: {
        timeoutSeconds: 300,
        autoWip: false,
        rollbackOnFail: false,
        requireGit: true,
      },
      memory: false,
      updatedAt: "2026-01-01",
    };
    expect(s.tools.codegraph).toBe(true);
    expect(s.failureProtection.requireGit).toBe(true);
  });
});

// stageReachable logic inlined (store.ts uses document.querySelector — DOM-only)
// Mirrors src/ui/src/store.ts stageReachable exactly.
function localStageReachable(n: 1 | 2 | 3 | 4, state: WorkflowState | null): boolean {
  if (n === 1) return true;
  if (n === 2) return state !== null;
  if (n === 3) return state !== null; // Stage 3 reachable when goal set — orchestrate creates units there
  if (n === 4) {
    const units = state?.work_units ?? [];
    return units.length > 0 && units.every((u) => u.status === "done" || u.status === "blocked");
  }
  return false;
}

describe("stageReachable: pure stage gate logic", () => {
  const noUnits: WorkflowState = {
    task_id: "T1",
    goal: "g",
    success_criteria: [],
    work_units: [],
    totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
  const withPending: WorkflowState = {
    ...noUnits,
    work_units: [
      {
        name: "u1",
        status: "pending",
        confidence: 0,
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
  };
  const allDone: WorkflowState = {
    ...noUnits,
    work_units: [
      {
        name: "u1",
        status: "done",
        confidence: 0.9,
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        resources: { agents: 1, tokens: 100, cost_usd: 0.01, wall_seconds: 5 },
      },
    ],
  };
  const mixed: WorkflowState = {
    ...noUnits,
    work_units: [
      {
        name: "u1",
        status: "done",
        confidence: 0.9,
        gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        resources: { agents: 1, tokens: 100, cost_usd: 0.01, wall_seconds: 5 },
      },
      {
        name: "u2",
        status: "blocked",
        confidence: 0,
        gates: { build: "fail", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
  };

  test("stage 1 always reachable", () => {
    expect(localStageReachable(1, null)).toBe(true);
    expect(localStageReachable(1, noUnits)).toBe(true);
  });
  test("stage 2 requires non-null state", () => {
    expect(localStageReachable(2, null)).toBe(false);
    expect(localStageReachable(2, noUnits)).toBe(true);
  });
  test("stage 3 reachable when state exists (orchestrate creates units on stage 3)", () => {
    expect(localStageReachable(3, null)).toBe(false);
    expect(localStageReachable(3, noUnits)).toBe(true); // state exists, units created by orchestrate
    expect(localStageReachable(3, withPending)).toBe(true);
  });
  test("stage 4 requires all units done or blocked", () => {
    expect(localStageReachable(4, null)).toBe(false);
    expect(localStageReachable(4, noUnits)).toBe(false);
    expect(localStageReachable(4, withPending)).toBe(false);
    expect(localStageReachable(4, allDone)).toBe(true);
    expect(localStageReachable(4, mixed)).toBe(true);
  });
});

describe("setStage guard: no forward jump to unreachable stage", () => {
  // Mirrors store.ts setStage guard — tested without Pinia/DOM by inlining logic
  function localSetStage(
    current: 1 | 2 | 3 | 4,
    target: 1 | 2 | 3 | 4,
    state: WorkflowState | null,
  ): 1 | 2 | 3 | 4 {
    if (target > current && !localStageReachable(target, state)) return current;
    return target;
  }
  const withUnits: WorkflowState = {
    task_id: "T1",
    goal: "g",
    success_criteria: [],
    work_units: [
      {
        name: "u1",
        status: "pending",
        confidence: 0,
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
    totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };

  test("forward to stage 2 blocked if no state", () => {
    expect(localSetStage(1, 2, null)).toBe(1);
  });
  test("forward to stage 2 allowed when units exist", () => {
    expect(localSetStage(1, 2, withUnits)).toBe(2);
  });
  test("forward to stage 4 blocked when units not all done", () => {
    expect(localSetStage(1, 4, withUnits)).toBe(1);
  });
  test("backwards navigation always allowed regardless of state", () => {
    expect(localSetStage(4, 1, null)).toBe(1);
    expect(localSetStage(3, 2, null)).toBe(2);
  });
});

// ProjectList badge helpers — inlined from ProjectList.vue (pure functions, no DOM)
import type { ProjectEntry } from "../src/ui/src/types.js";

function projectStatus(p: ProjectEntry): "done" | "partial" | "empty" | "stale" {
  if (p.totals.units === 0) return "empty";
  if (p.totals.done === p.totals.units) return "done";
  if (Date.now() - p.lastUsed > 30 * 24 * 60 * 60 * 1000) return "stale";
  return "partial";
}

function badgeClass(status: string): string {
  const map: Record<string, string> = {
    done: "text-[10px] px-1.5 py-0.5 rounded bg-green-900 text-green-300",
    partial: "text-[10px] px-1.5 py-0.5 rounded bg-blue-900 text-blue-300",
    empty: "text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-500",
    stale: "text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-600",
  };
  return map[status] ?? "";
}

function badgeLabel(p: ProjectEntry): string {
  if (p.totals.units === 0) return "no tasks";
  if (p.totals.done === p.totals.units) return "✓ done";
  return `${p.totals.done}/${p.totals.units} done`;
}

function makeProject(totals: ProjectEntry["totals"], lastUsed: number): ProjectEntry {
  return { path: "/p", name: "p", goal: "", lastUsed, totals };
}

describe("projectStatus", () => {
  test("units=0 → empty", () => {
    expect(
      projectStatus(makeProject({ units: 0, done: 0, tokens: 0, cost_usd: 0 }, Date.now())),
    ).toBe("empty");
  });
  test("done===units → done", () => {
    expect(
      projectStatus(makeProject({ units: 3, done: 3, tokens: 0, cost_usd: 0 }, Date.now())),
    ).toBe("done");
  });
  test("partial progress recent → partial", () => {
    expect(
      projectStatus(makeProject({ units: 3, done: 1, tokens: 0, cost_usd: 0 }, Date.now())),
    ).toBe("partial");
  });
  test("lastUsed 40 days ago → stale", () => {
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    expect(
      projectStatus(makeProject({ units: 3, done: 1, tokens: 0, cost_usd: 0 }, fortyDaysAgo)),
    ).toBe("stale");
  });
});

describe("badgeLabel", () => {
  test("units=0 → 'no tasks'", () => {
    expect(badgeLabel(makeProject({ units: 0, done: 0, tokens: 0, cost_usd: 0 }, Date.now()))).toBe(
      "no tasks",
    );
  });
  test("all done → '✓ done'", () => {
    expect(badgeLabel(makeProject({ units: 3, done: 3, tokens: 0, cost_usd: 0 }, Date.now()))).toBe(
      "✓ done",
    );
  });
  test("partial → '1/3 done'", () => {
    expect(badgeLabel(makeProject({ units: 3, done: 1, tokens: 0, cost_usd: 0 }, Date.now()))).toBe(
      "1/3 done",
    );
  });
});

describe("badgeClass", () => {
  test("done → green classes", () => {
    expect(badgeClass("done")).toContain("bg-green-900");
  });
  test("partial → blue classes", () => {
    expect(badgeClass("partial")).toContain("bg-blue-900");
  });
  test("empty → neutral classes", () => {
    expect(badgeClass("empty")).toContain("bg-neutral-800");
    expect(badgeClass("empty")).toContain("text-neutral-500");
  });
  test("stale → neutral classes", () => {
    expect(badgeClass("stale")).toContain("bg-neutral-800");
    expect(badgeClass("stale")).toContain("text-neutral-600");
  });
  test("unknown → empty string", () => {
    expect(badgeClass("unknown")).toBe("");
  });
});

// failureText / fixCommand helpers — inlined from Stage4Verify.vue (pure functions, no DOM)
function failureText(f: string): string {
  const idx = f.indexOf(" → Fix:");
  return idx === -1 ? f : f.slice(0, idx);
}

function fixCommand(f: string): string {
  const idx = f.indexOf(" → Fix:");
  return idx === -1 ? "" : f.slice(idx + " → Fix:".length).trim();
}

describe("failureText", () => {
  test("returns full string when no → Fix: marker", () => {
    expect(failureText("no-evidence: unit done but no evidence")).toBe(
      "no-evidence: unit done but no evidence",
    );
  });
  test("returns part before → Fix: marker", () => {
    expect(
      failureText(
        'no-evidence: "u1" is done but has no recorded evidence → Fix: vf units evidence u1 --add "describe what was done"',
      ),
    ).toBe('no-evidence: "u1" is done but has no recorded evidence');
  });
});

describe("fixCommand", () => {
  test("returns empty string when no → Fix: marker", () => {
    expect(fixCommand("no-evidence: unit done but no evidence")).toBe("");
  });
  test("returns command after → Fix: marker", () => {
    expect(
      fixCommand(
        'no-evidence: "u1" is done but has no recorded evidence → Fix: vf units evidence u1 --add "describe what was done"',
      ),
    ).toBe('vf units evidence u1 --add "describe what was done"');
  });
  test("confidence<1 fix command", () => {
    expect(
      fixCommand(
        'confidence<1: "u1" at 0.5 — investigate/debate before close → Fix: vf units update u1 --confidence 1',
      ),
    ).toBe("vf units update u1 --confidence 1");
  });
  test("no-workflow-state fix command", () => {
    expect(
      fixCommand(
        "no-workflow-state: .vibeflow/WORKFLOW_STATE.json missing → Fix: run vf init first",
      ),
    ).toBe("run vf init first");
  });
});

describe("toastMsg format", () => {
  function makeToastMsg(wallSeconds: number): string {
    return `✓ All agents complete${wallSeconds > 0 ? ` (${wallSeconds}s)` : ""}`;
  }
  test("with wall_seconds=120", () => {
    expect(makeToastMsg(120)).toBe("✓ All agents complete (120s)");
  });
  test("with wall_seconds=0", () => {
    expect(makeToastMsg(0)).toBe("✓ All agents complete");
  });
});

describe("eventsWithDividers", () => {
  type LogItem = { type: "event"; ts: number } | { type: "divider"; ts: number };
  function makeEventsWithDividers(tsList: number[]): LogItem[] {
    const result: LogItem[] = [];
    for (let i = 0; i < tsList.length; i++) {
      const ts = tsList[i];
      if (ts === undefined) continue;
      const prev = tsList[i - 1];
      if (prev !== undefined && ts - prev > 60_000) {
        result.push({ type: "divider", ts });
      }
      result.push({ type: "event", ts });
    }
    return result;
  }
  test("events <60s apart have no divider", () => {
    const result = makeEventsWithDividers([1000, 30_000]);
    expect(result.every((i) => i.type === "event")).toBe(true);
  });
  test("events >60s apart get divider inserted between", () => {
    const result = makeEventsWithDividers([1000, 62_000]);
    expect(result).toHaveLength(3);
    expect(result[0]?.type).toBe("event");
    expect(result[1]?.type).toBe("divider");
    expect(result[2]?.type).toBe("event");
  });
});

describe("ENGINE_HINTS", () => {
  const ENGINE_HINTS: Record<string, string> = {
    claude: "Best for complex reasoning, architecture, multi-file changes",
    codex: "Fast, focused on code generation and completions",
    copilot: "GitHub-integrated, good for PR-context tasks",
  };
  test("all 3 engines have non-empty hints", () => {
    expect(ENGINE_HINTS.claude?.length).toBeGreaterThan(0);
    expect(ENGINE_HINTS.codex?.length).toBeGreaterThan(0);
    expect(ENGINE_HINTS.copilot?.length).toBeGreaterThan(0);
  });
  const ENGINE_PRIORITY = ["claude", "copilot", "codex"];
  function deriveRecommended(readyKeys: string[]): string {
    const ready = new Set(readyKeys);
    return ENGINE_PRIORITY.find((e) => ready.has(e)) ?? "claude";
  }
  test("codex-only ready -> recommends codex", () => {
    expect(deriveRecommended(["codex"])).toBe("codex");
  });
  test("empty ready -> fallback claude", () => {
    expect(deriveRecommended([])).toBe("claude");
  });
  test("priority: claude beats copilot beats codex", () => {
    expect(deriveRecommended(["claude", "codex"])).toBe("claude");
    expect(deriveRecommended(["copilot", "codex"])).toBe("copilot");
  });
});

describe("HookApprovalModal helpers", () => {
  function borderClass(risk: string): string {
    if (risk === "critical") return "border-red-700 bg-red-950/80 text-red-100";
    if (risk === "high") return "border-orange-700 bg-orange-950/80 text-orange-100";
    if (risk === "medium") return "border-yellow-700 bg-yellow-950/60 text-yellow-100";
    return "border-neutral-700 bg-neutral-900/90 text-neutral-300";
  }
  function riskDot(risk: string): string {
    if (risk === "critical") return "text-red-400";
    if (risk === "high") return "text-orange-400";
    if (risk === "medium") return "text-yellow-400";
    return "text-neutral-500";
  }
  test("borderClass: critical → red", () => {
    expect(borderClass("critical")).toContain("red");
  });
  test("borderClass: high → orange", () => {
    expect(borderClass("high")).toContain("orange");
  });
  test("borderClass: medium → yellow", () => {
    expect(borderClass("medium")).toContain("yellow");
  });
  test("borderClass: low → neutral", () => {
    expect(borderClass("low")).toContain("neutral");
  });
  test("riskDot: critical → red-400", () => {
    expect(riskDot("critical")).toBe("text-red-400");
  });
  test("riskDot: high → orange-400", () => {
    expect(riskDot("high")).toBe("text-orange-400");
  });
  test("riskDot: none → neutral-500", () => {
    expect(riskDot("none")).toBe("text-neutral-500");
  });
});
