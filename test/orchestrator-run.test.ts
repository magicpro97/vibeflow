import { describe, expect, test, afterEach } from "bun:test";
import { cleanupMarker } from "../src/orchestrator/marker";
import {
  DEFAULT_CONCURRENCY,
  goalEval,
  orchestrateUnits,
  runParallel,
  type UnitDispatcher,
  type UnitOutcome,
} from "../src/orchestrator/run";
import type { WorkUnit, WorkflowState } from "../src/core";

const TEST_PREFIX = `run-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

/** Build a minimal valid WorkUnit for tests. */
function makeUnit(name: string, overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    name,
    status: "pending",
    confidence: 0,
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    ...overrides,
  };
}

/** No-op dispatcher that always reports a "verifying" outcome with given evidence. */
function fixedDispatcher(
  outcome: Partial<UnitOutcome> & { status: UnitOutcome["status"]; confidence: number },
): UnitDispatcher {
  return async () => {
    // Preserve `evidence: undefined` (omitted) so line 56's `?? []` branch fires.
    // The default only applies when `evidence` is genuinely missing.
    const result: UnitOutcome = {
      status: outcome.status,
      confidence: outcome.confidence,
    };
    if ("evidence" in outcome) result.evidence = outcome.evidence;
    else result.evidence = [];
    if (outcome.gates !== undefined) result.gates = outcome.gates;
    if (outcome.resources !== undefined) result.resources = outcome.resources;
    if (outcome.knowledge_heavy !== undefined) result.knowledge_heavy = outcome.knowledge_heavy;
    if (outcome.knowledge_heavy_source !== undefined) result.knowledge_heavy_source = outcome.knowledge_heavy_source;
    if (outcome.skills_injected !== undefined) result.skills_injected = outcome.skills_injected;
    if (outcome.skills_required !== undefined) result.skills_required = outcome.skills_required;
    if (outcome.skills_used !== undefined) result.skills_used = outcome.skills_used;
    return result;
  };
}

/** Dispatcher that returns the outcome with `evidence` field omitted (truly undefined on the object). */
function dispatcherEvidenceOmitted(
  outcome: Pick<UnitOutcome, "status" | "confidence">,
): UnitDispatcher {
  return async () => {
    // Build the result with NO `evidence` property at all so line 56's
    // `outcome.evidence ?? []` takes the `undefined` branch.
    const result: { status: UnitOutcome["status"]; confidence: number; evidence?: string[] } = {
      status: outcome.status,
      confidence: outcome.confidence,
    };
    return result as UnitOutcome;
  };
}

afterEach(() => {
  // Clean up any markers the orchestration step created
  const names = [TEST_PREFIX, `${TEST_PREFIX}-a`, `${TEST_PREFIX}-b`, `${TEST_PREFIX}-c`];
  for (const n of names) {
    try {
      cleanupMarker(n);
    } catch {}
  }
});

describe("runParallel", () => {
  test("uses concurrency=1 for empty items array (no lanes spawned)", async () => {
    // Branch: items.length === 0 -> Math.max(1, ... || 1) = 1
    const calls: number[] = [];
    const results = await runParallel(
      [],
      async (_item, i) => {
        calls.push(i);
        return i;
      },
      5,
    );
    expect(results).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("clamps concurrency to items.length when concurrency > items.length", async () => {
    // Branch: Math.min(concurrency, items.length || 1) -> items.length
    const seen: number[] = [];
    const results = await runParallel(
      [10, 20, 30],
      async (item, i) => {
        seen.push(i);
        return item * 2;
      },
      99,
    );
    expect(results).toEqual([20, 40, 60]);
    expect(seen).toEqual([0, 1, 2]);
  });

  test("clamps concurrency to 1 when concurrency < 1 (e.g. 0)", async () => {
    // Branch: Math.max(1, Math.min(0, n)) = 1
    const seen: number[] = [];
    const results = await runParallel(
      ["a", "b", "c"],
      async (item, i) => {
        seen.push(i);
        return item.toUpperCase();
      },
      0,
    );
    expect(results).toEqual(["A", "B", "C"]);
    // With concurrency=1, work happens in order; indices should be sequential
    expect(seen).toEqual([0, 1, 2]);
  });

  test("honors DEFAULT_CONCURRENCY when not specified", async () => {
    expect(DEFAULT_CONCURRENCY).toBe(3);
    const results = await runParallel([1, 2, 3], async (n) => n + 1);
    expect(results).toEqual([2, 3, 4]);
  });
});

describe("applyOutcome (via orchestrateUnits)", () => {
  test("dedupes evidence when both unit and outcome carry overlapping paths", async () => {
    // Branch on line 56: both unit.evidence and outcome.evidence defined,
    // exercising the Set dedupe path with a duplicate.
    const u = makeUnit(`${TEST_PREFIX}-a`, {
      evidence: ["path/a", "path/b"],
    });
    const dispatcher = fixedDispatcher({
      status: "verifying",
      confidence: 0.5,
      evidence: ["path/b", "path/c"], // "path/b" duplicates
    });
    const reviewer = () => ({ pass: true, reason: "ok" });

    const { units } = await orchestrateUnits({
      units: [u],
      dispatcher,
      reviewer,
    });
    expect(units[0]!.evidence).toEqual(["path/a", "path/b", "path/c"]);
  });

  test("handles unit.evidence undefined and outcome.evidence undefined (both ?? [] hit)", async () => {
    // Branch on line 56: both unit.evidence and outcome.evidence are undefined,
    // so the `?? []` on each side fires.
    const u = makeUnit(`${TEST_PREFIX}-a`);
    // strip evidence from unit (it's optional)
    delete u.evidence;
    // Use a dispatcher that omits `evidence` from the returned object entirely,
    // so `outcome.evidence` is `undefined` (not `[]`) when applyOutcome reads it.
    const dispatcher = dispatcherEvidenceOmitted({
      status: "verifying",
      confidence: 0.5,
    });
    const reviewer = () => ({ pass: true, reason: "ok" });

    const { units } = await orchestrateUnits({
      units: [u],
      dispatcher,
      reviewer,
    });
    expect(units[0]!.evidence).toEqual([]);
  });

  test("handles unit.evidence defined and outcome.evidence undefined", async () => {
    // Branch on line 56: unit.evidence defined (no ?? fallback needed),
    // outcome.evidence undefined -> outcome.evidence ?? [] fires.
    const u = makeUnit(`${TEST_PREFIX}-a`, {
      evidence: ["u-only.json"],
    });
    // Omit `evidence` on outcome so the `?? []` branch on outcome.evidence fires.
    const dispatcher = dispatcherEvidenceOmitted({
      status: "verifying",
      confidence: 0.5,
    });
    const reviewer = () => ({ pass: true, reason: "ok" });

    const { units } = await orchestrateUnits({
      units: [u],
      dispatcher,
      reviewer,
    });
    expect(units[0]!.evidence).toEqual(["u-only.json"]);
  });

  test("handles unit.evidence undefined and outcome.evidence defined", async () => {
    // Branch on line 56: unit.evidence undefined -> unit.evidence ?? [] fires,
    // outcome.evidence defined (no ?? fallback needed).
    const u = makeUnit(`${TEST_PREFIX}-a`);
    delete u.evidence;
    const dispatcher = fixedDispatcher({
      status: "verifying",
      confidence: 0.5,
      evidence: ["o-only.json"],
    });
    const reviewer = () => ({ pass: true, reason: "ok" });

    const { units } = await orchestrateUnits({
      units: [u],
      dispatcher,
      reviewer,
    });
    expect(units[0]!.evidence).toEqual(["o-only.json"]);
  });
});

describe("orchestrateUnits", () => {
  test("runs multiple units with passing review", async () => {
    const u1 = makeUnit(`${TEST_PREFIX}-a`);
    const u2 = makeUnit(`${TEST_PREFIX}-b`);
    const dispatcher: UnitDispatcher = async (u) => ({
      status: "verifying",
      confidence: 0.9,
      evidence: [`out/${u.name}`],
    });
    const reviewer = () => ({ pass: true, reason: "looks good" });
    const { units, reviews } = await orchestrateUnits({
      units: [u1, u2],
      dispatcher,
      reviewer,
    });
    expect(units).toHaveLength(2);
    expect(units.every((u) => u.status === "done")).toBe(true);
    expect(units.every((u) => u.gates.review === "pass")).toBe(true);
    expect(reviews).toEqual([
      { unit: `${TEST_PREFIX}-a`, pass: true, reason: "looks good" },
      { unit: `${TEST_PREFIX}-b`, pass: true, reason: "looks good" },
    ]);
  });

  test("blocks unit and sets gates.review=fail when reviewer rejects", async () => {
    const u = makeUnit(`${TEST_PREFIX}-a`);
    const dispatcher: UnitDispatcher = async () => ({
      status: "verifying",
      confidence: 0.5,
      evidence: ["x.json"],
    });
    const reviewer = () => ({ pass: false, reason: "evidence missing" });
    const { units, reviews } = await orchestrateUnits({
      units: [u],
      dispatcher,
      reviewer,
    });
    expect(units[0]!.status).toBe("blocked");
    expect(units[0]!.gates.review).toBe("fail");
    expect(reviews[0]!).toEqual({
      unit: `${TEST_PREFIX}-a`,
      pass: false,
      reason: "evidence missing",
    });
  });
});

describe("goalEval", () => {
  function makeState(work_units: WorkUnit[]): WorkflowState {
    return {
      task_id: "t1",
      goal: "test goal",
      success_criteria: [],
      work_units,
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
  }

  test("returns partial when state.work_units is missing (undefined)", () => {
    // Branch on line 152: state.work_units undefined -> units = [] -> !units.length
    const state = makeState(undefined as unknown as WorkUnit[]);
    const result = goalEval(state);
    expect(result.verdict).toBe("partial");
    expect(result.reasons).toEqual(["no work units to evaluate"]);
  });

  test("returns partial when work_units is an empty array", () => {
    // Branch on line 154: !units.length path with empty array
    const state = makeState([]);
    const result = goalEval(state);
    expect(result.verdict).toBe("partial");
    expect(result.reasons).toEqual(["no work units to evaluate"]);
  });

  test("returns met when all units done with confidence 1.0 and evidence", () => {
    const state = makeState([
      makeUnit(`${TEST_PREFIX}-a`, {
        status: "done",
        confidence: 1,
        evidence: ["a.json"],
      }),
    ]);
    const result = goalEval(state);
    expect(result.verdict).toBe("met");
    expect(result.reasons).toEqual(["all units done at confidence 1.0 with evidence"]);
  });

  test("returns blocked when any unit is blocked", () => {
    const state = makeState([
      makeUnit(`${TEST_PREFIX}-a`, { status: "done", confidence: 1, evidence: ["a.json"] }),
      makeUnit(`${TEST_PREFIX}-b`, { status: "blocked" }),
    ]);
    const result = goalEval(state);
    expect(result.verdict).toBe("blocked");
    expect(result.reasons).toEqual([`blocked: ${TEST_PREFIX}-b`]);
  });

  test("returns partial when unit is incomplete (status != done, conf<1, or no evidence)", () => {
    // Branch on line 167: u.evidence?.length ?? 0 -> when u.evidence is undefined
    const state = makeState([
      makeUnit(`${TEST_PREFIX}-a`, { status: "done", confidence: 1, evidence: ["a.json"] }),
      // Missing evidence entirely -> u.evidence?.length is undefined -> ?? 0
      makeUnit(`${TEST_PREFIX}-b`, { status: "done", confidence: 1 }),
      makeUnit(`${TEST_PREFIX}-c`, { status: "verifying", confidence: 0.5, evidence: ["c.json"] }),
    ]);
    const result = goalEval(state);
    expect(result.verdict).toBe("partial");
    // Should include both incomplete units
    expect(result.reasons.length).toBe(2);
    expect(result.reasons.some((r) => r.startsWith(`incomplete: ${TEST_PREFIX}-b`))).toBe(true);
    expect(result.reasons.some((r) => r.startsWith(`incomplete: ${TEST_PREFIX}-c`))).toBe(true);
    // Specifically the missing-evidence unit should show evidence=0
    const bReason = result.reasons.find((r) => r.includes(`${TEST_PREFIX}-b`));
    expect(bReason).toContain("evidence=0");
  });
});
