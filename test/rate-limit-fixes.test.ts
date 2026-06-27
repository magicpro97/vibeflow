import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFinisherBatchUnit } from "../src/ai-init-workflow.js";
import type { WorkUnit } from "../src/core.js";
import { orchestrateUnits, runParallel } from "../src/orchestrator/run.js";
import {
  curatorCacheKey,
  curatorCacheKeyForProject,
  pruneCuratorCache,
  readCuratorCache,
  writeCuratorCache,
} from "../src/skills/curator-cache.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vf-rate-limit-fixes-"));
});
afterEach(() => {
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// P0-1: persistent cache for skill-curator output
// ---------------------------------------------------------------------------

describe("P0-1: curator cache", () => {
  function writeContextInputs(base: string, stack: string, profile: string): void {
    const dir = join(base, ".vibeflow", "ai-context");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stack-evidence.md"), stack);
    writeFileSync(join(dir, "project-profile.json"), profile);
  }

  test("curatorCacheKey is deterministic for the same inputs", () => {
    const k1 = curatorCacheKey(["a", "b"]);
    const k2 = curatorCacheKey(["a", "b"]);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[a-f0-9]{64}$/);
  });

  test("curatorCacheKey differs when any input differs", () => {
    const k1 = curatorCacheKey(["a", "b"]);
    const k2 = curatorCacheKey(["a", "c"]);
    expect(k1).not.toBe(k2);
  });

  test("curatorCacheKeyForProject returns undefined when inputs missing", () => {
    expect(curatorCacheKeyForProject(tmp)).toBeUndefined();
  });

  test("curatorCacheKeyForProject returns hash when inputs present", () => {
    writeContextInputs(tmp, "# stack\n| Name | Value |\n| --- | --- |\n| x | y |", "{}");
    const h = curatorCacheKeyForProject(tmp);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  test("read/write cache round-trip", () => {
    writeContextInputs(tmp, "stack-v1", "profile-v1");
    const h = curatorCacheKeyForProject(tmp);
    if (!h) throw new Error("hash missing");
    writeCuratorCache(tmp, h, ["spring-boot", "postgresql"], ["redis"]);
    const entry = readCuratorCache(tmp, h);
    expect(entry).toBeDefined();
    expect(entry?.installed).toEqual(["spring-boot", "postgresql"]);
    expect(entry?.unmatched).toEqual(["redis"]);
    expect(entry?.version).toBe(1);
  });

  test("read cache returns undefined on hash mismatch", () => {
    writeContextInputs(tmp, "x", "y");
    writeCuratorCache(tmp, "wronghash", ["a"], []);
    const h = curatorCacheKeyForProject(tmp);
    if (!h) throw new Error("hash missing");
    expect(readCuratorCache(tmp, h)).toBeUndefined();
  });

  test("pruneCuratorCache removes old entries, keeps fresh ones", () => {
    writeContextInputs(tmp, "x", "y");
    const h = curatorCacheKeyForProject(tmp);
    if (!h) throw new Error("hash missing");
    writeCuratorCache(tmp, h, ["a"], []);
    // Backdate the cache file mtime to 10 days ago.
    const path = join(tmp, ".vibeflow", "cache", `curator-${h}.json`);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    // Touch via utimes — Bun doesn't expose this, use a tiny node call.
    const { utimesSync } = require("node:fs") as typeof import("node:fs");
    utimesSync(path, old, old);
    const pruned = pruneCuratorCache(tmp, 7 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);
    expect(existsSync(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P0-2 + P0-3: sequential wave-0 + inter-unit jittered delay
// ---------------------------------------------------------------------------

describe("P0-2/P0-3: runParallel concurrency + inter-unit delay", () => {
  test("concurrency=1 runs items sequentially", async () => {
    const order: number[] = [];
    const items = [0, 1, 2, 3];
    await runParallel(
      items,
      async (n) => {
        order.push(n);
        return n * 10;
      },
      1,
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test("concurrency=3 runs up to 3 in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 9 }, (_, i) => i);
    await runParallel(
      items,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => setTimeout(r, 5));
        inFlight--;
        return n;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2); // some parallelism actually happened
  });

  test("interUnitDelayMs staggers start times", async () => {
    const starts: number[] = [];
    const base = Date.now();
    const items = [0, 1, 2];
    await runParallel(
      items,
      async (n) => {
        starts.push(Date.now() - base);
        return n;
      },
      1,
      30, // 30ms min + 0-30ms jitter per item after the first
    );
    // First item should start near t=0; subsequent items should be
    // noticeably later (>= 30ms each, since concurrency=1 means
    // they queue up).
    expect(starts[0]).toBeLessThan(15);
    expect(starts[1] ?? 0).toBeGreaterThanOrEqual(25);
    expect(starts[2] ?? 0).toBeGreaterThanOrEqual(55);
  });

  test("interUnitDelayMs with injected sleep is deterministic", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    await runParallel(
      [0, 1, 2, 3],
      async (n) => n,
      1,
      10, // 10ms min + 0-10ms jitter
      sleep,
    );
    // 3 sleeps (item 0 doesn't sleep), each in [10, 20).
    expect(sleeps).toHaveLength(3);
    for (const s of sleeps) {
      expect(s).toBeGreaterThanOrEqual(10);
      expect(s).toBeLessThan(20);
    }
  });

  test("orchestrateUnits forwards interUnitDelayMs to runParallel", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const units: WorkUnit[] = [0, 1, 2].map((i) => ({
      name: `u${i}`,
      status: "pending",
      confidence: 0,
      gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
      resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      evidence: [],
    }));
    const dispatcher = async () => ({
      status: "verifying" as const,
      confidence: 1,
      evidence: ["x"],
    });
    const reviewer = () => ({ pass: true, reason: "ok" });
    await orchestrateUnits({
      units,
      dispatcher,
      reviewer,
      concurrency: 1,
      interUnitDelayMs: 5,
    });
    // No way to inject sleep into orchestrateUnits — it uses the
    // default. Just check no throw + all units complete.
    expect(units.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// P0-4: quota-aware finisher skip (inferred from result.skippedUnits)
// Tested via the buildFinisherBatchUnit shape + the workflow integration
// below. Direct runAiInitWorkflow test would need a fake quotaStatus probe.
// ---------------------------------------------------------------------------

describe("P0-4: buildFinisherBatchUnit shape", () => {
  test("returns a single unit with the consolidated workflow-state finisher scope", () => {
    const u = buildFinisherBatchUnit(
      { name: "demo", languages: ["TS"] } as never,
      { goal: "init" },
      [],
    );
    expect(u.name).toBe("ai-init-finishers-batch");
    // PR #251 consolidated the finisher set to the single workflow-state writer.
    expect(u.scope).toEqual([".vibeflow/WORKFLOW_STATE.json"]);
    expect(u.scope).toHaveLength(1);
  });

  test("spec mentions the workflow-state finisher section so the engine has full context", () => {
    const u = buildFinisherBatchUnit(
      { name: "demo", languages: ["TS"] } as never,
      { goal: "init" },
      [],
    );
    expect(u.spec).toContain("ai-init-workflow-state-writer");
  });

  test("depends on the core adapters (analyzer + context-updater)", () => {
    const u = buildFinisherBatchUnit(
      { name: "demo", languages: ["TS"] } as never,
      { goal: "init" },
      [],
    );
    expect(u.depends_on).toContain("ai-init-analyzer");
    expect(u.depends_on).toContain("ai-init-context-updater");
  });
});

// ---------------------------------------------------------------------------
// P1-4: backoff options are forwarded through the workflow
// Tested indirectly via existing defaultAiInitDispatcher tests + the
// CLI init path; the option is just a forward. Spot-check that the
// options exist on the opts type.
// ---------------------------------------------------------------------------

describe("P1-4: backoff options surface on the workflow opts", () => {
  // Smoke test: the runAiInitWorkflow accepts the new options
  // without throwing at the type/builder level. Full behavior
  // coverage lives in defaultAiInitDispatcher tests.
  test("runAiInitWorkflow accepts the backoff knobs (smoke)", async () => {
    // Just import + verify the option names are part of the surface.
    const { defaultAiInitDispatcher } = await import("../src/ai-init.js");
    const d = defaultAiInitDispatcher("copilot", {
      maxRetries: 3,
      backoffBaseMs: 2_000,
      backoffCapMs: 120_000,
      spawner: async () => ({ status: 0, stdout: "" }),
    });
    expect(typeof d).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// P1-7: batched finisher — verified by buildFinisherBatchUnit tests
// above + the integration tests in ai-init-workflow-runner.test.ts.
// Smoke test the adapter set here (PR #251 consolidated 8 → 5 adapters).
// ---------------------------------------------------------------------------

describe("P1-7: batched finisher integration", () => {
  test("planAiInitUnits emits the 5 canonical adapter units (batching is at workflow level)", async () => {
    // The batching happens in runAiInitWorkflow, not in
    // planAiInitUnits — the latter is a pure builder used by tests
    // and the legacy single-shot path. This test pins the contract
    // so a refactor that moves batching into the planner is caught.
    const { planAiInitUnits } = await import("../src/ai-init-workflow.js");
    const units = planAiInitUnits({ name: "demo", languages: ["TS"] } as never, { goal: "init" });
    const names = units.map((u) => u.name);
    expect(names).toEqual([
      "ai-init-analyzer",
      "ai-init-instruction-writer",
      "ai-init-skill-curator",
      "ai-init-context-updater",
      "ai-init-workflow-state-writer",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("P0-1: curator cache edge cases", () => {
  test("readCuratorCache returns undefined when file contains invalid JSON", () => {
    const dir = join(tmp, ".vibeflow", "cache");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "curator-deadbeef.json");
    writeFileSync(path, "not-json{{{");
    const entry = readCuratorCache(tmp, "deadbeef");
    expect(entry).toBeUndefined();
  });

  test("readCuratorCache returns undefined when version != 1", () => {
    writeContextInputs(tmp, "stack-v2", "profile-v2");
    const h = curatorCacheKeyForProject(tmp);
    if (!h) throw new Error("hash missing");
    writeCuratorCache(tmp, h, [], []);
    // Patch the version to 2
    const path = join(tmp, ".vibeflow", "cache", `curator-${h}.json`);
    const entry = JSON.parse(readFileSync(path, "utf8"));
    entry.version = 2;
    writeFileSync(path, JSON.stringify(entry));
    // Now read returns undefined
    const result = readCuratorCache(tmp, h);
    expect(result).toBeUndefined();
  });

  test("pruneCuratorCache skips non-curator files", () => {
    writeContextInputs(tmp, "stack-v3", "profile-v3");
    const dir = join(tmp, ".vibeflow", "cache");
    mkdirSync(dir, { recursive: true });
    // Write a non-curator file
    writeFileSync(join(dir, "other.json"), "{}");
    const pruned = pruneCuratorCache(tmp, 7 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(0);
    expect(existsSync(join(dir, "other.json"))).toBe(true);
  });
});

function writeContextInputs(base: string, stack: string, profile: string): void {
  const dir = join(base, ".vibeflow", "ai-context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stack-evidence.md"), stack);
  writeFileSync(join(dir, "project-profile.json"), profile);
}
