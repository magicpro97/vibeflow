import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../src/core.js";
import { investigateUnit, thresholdFor } from "../src/orchestrator/investigate.js";
import { DEFAULT_CONCURRENCY, orchestrateUnits, runParallel } from "../src/orchestrator/run.js";

function unit(name: string, overrides: Partial<WorkUnit> = {}): WorkUnit {
  return {
    name,
    status: "pending",
    confidence: 0,
    scope: [`src/${name}/`],
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    ...overrides,
  };
}

/** Deferred gate: a promise that resolves only when `release()` is called. */
function gate() {
  let release = () => {};
  const promise = new Promise<void>((res) => {
    release = res;
  });
  return { promise, release };
}

describe("runParallel — proven overlap (defect #3)", () => {
  test("concurrency=3 with 3 async tasks reaches 3 in-flight simultaneously", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const gates = [gate(), gate(), gate()];
    const started = [gate(), gate(), gate()];

    const run = runParallel(
      [0, 1, 2],
      async (i) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started[i]?.release();
        await gates[i]?.promise;
        inFlight--;
        return i;
      },
      3,
    );

    // Wait until all three have entered before releasing any — this is only possible if the
    // lanes truly overlap. A serial spawnSync-style worker would never get past task 0.
    await Promise.all(started.map((s) => s.promise));
    expect(maxInFlight).toBe(3);
    for (const g of gates) g.release();
    expect(await run).toEqual([0, 1, 2]);
  });

  test("bounds concurrency: never more than N in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await runParallel(
      [1, 2, 3, 4, 5],
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight--;
        return n * 2;
      },
      2,
    );
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  test("DEFAULT_CONCURRENCY is the named constant", () => {
    expect(DEFAULT_CONCURRENCY).toBe(3);
  });
});

describe("orchestrateUnits — reviewer blocks on failed review (defect #4)", () => {
  test('a "verifying" unit (production status) with confidence<1 ends up blocked/review=fail', async () => {
    const { units, reviews } = await orchestrateUnits({
      units: [unit("a")],
      dispatcher: async () => ({ status: "verifying", confidence: 0.5, evidence: ["e.log"] }),
      reviewer: (_u, o) =>
        o.confidence >= 1 ? { pass: true, reason: "ok" } : { pass: false, reason: "low conf" },
    });
    const a = units.find((u) => u.name === "a");
    // This assertion FAILS against the old `=== "done"` guard (status stays "verifying").
    expect(a?.status).toBe("blocked");
    expect(a?.gates.review).toBe("fail");
    expect(reviews[0]?.pass).toBe(false);
  });

  test("passed review transitions status to done even when dispatcher returns verifying", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("a")],
      // Production dispatcher always returns "verifying" — our fix must still yield "done"
      dispatcher: async () => ({ status: "verifying", confidence: 1, evidence: ["e.log"] }),
      reviewer: () => ({ pass: true, reason: "ok" }),
    });
    const a = units.find((u) => u.name === "a");
    expect(a?.status).toBe("done"); // would fail without fix
    expect(a?.gates.review).toBe("pass");
  });

  test("failed review transitions status to blocked regardless of dispatcher status", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("b")],
      // Even with high confidence and evidence, a failing reviewer blocks the unit
      dispatcher: async () => ({ status: "verifying", confidence: 0.9, evidence: ["e.log"] }),
      reviewer: () => ({ pass: false, reason: "manual reject" }),
    });
    const b = units.find((u) => u.name === "b");
    expect(b?.status).toBe("blocked");
    expect(b?.gates.review).toBe("fail");
  });

  // Cross-debate review #1 (PR #43): a custom dispatcher that throws
  // synchronously must NOT abort the whole workflow. The orchestrator
  // treats the throw as a per-unit "blocked" outcome so siblings still
  // complete and `reviews[]` is fully populated.
  test("throwing dispatcher: per-unit outcome is blocked, workflow continues, reviews[] populated", async () => {
    const { units, reviews } = await orchestrateUnits({
      units: [unit("a"), unit("b"), unit("c")],
      dispatcher: async (u) => {
        if (u.name === "b") throw new Error("dispatcher boom");
        return { status: "verifying", confidence: 1, evidence: [`${u.name}.log`] };
      },
      // Reviewer treats the throw's outcome (status=blocked) as a fail
      // because the default aiInitReviewer maps "blocked" → pass=false.
      reviewer: (_u, o) =>
        o.status === "blocked"
          ? { pass: false, reason: "dispatcher reported blocked" }
          : { pass: true, reason: "ok" },
    });
    const a = units.find((u) => u.name === "a");
    const b = units.find((u) => u.name === "b");
    const c = units.find((u) => u.name === "c");
    expect(a?.status).toBe("done");
    expect(b?.status).toBe("blocked");
    expect(b?.gates.review).toBe("fail");
    expect(c?.status).toBe("done");
    // reviews[] is fully populated (no undefined slots from a Promise.all rejection)
    expect(reviews).toHaveLength(3);
    expect(reviews[0]?.pass).toBe(true);
    expect(reviews[1]?.pass).toBe(false);
    expect(reviews[2]?.pass).toBe(true);
  });

  test("reviews are ordered by input index (deterministic)", async () => {
    const { reviews } = await orchestrateUnits({
      units: [unit("a"), unit("b"), unit("c")],
      concurrency: 3,
      // b resolves first, c second, a last — reviews must still be [a, b, c].
      dispatcher: async (u) => {
        const delay = u.name === "a" ? 9 : u.name === "b" ? 1 : 4;
        await new Promise((r) => setTimeout(r, delay));
        return { status: "verifying", confidence: 1, evidence: ["e"] };
      },
      reviewer: () => ({ pass: true, reason: "ok" }),
    });
    expect(reviews.map((r) => r.unit)).toEqual(["a", "b", "c"]);
  });

  test("applyOutcome carries the skills-first fields onto the unit", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("a")],
      dispatcher: async () => ({
        status: "verifying",
        confidence: 1,
        evidence: ["e"],
        knowledge_heavy: true,
        knowledge_heavy_source: "regex",
        skills_injected: ["x", "y"],
        skills_required: ["x"],
        skills_used: ["x"],
      }),
      reviewer: () => ({ pass: true, reason: "ok" }),
    });
    const a = units.find((u) => u.name === "a");
    expect(a?.knowledge_heavy).toBe(true);
    expect(a?.knowledge_heavy_source).toBe("regex");
    expect(a?.skills_injected).toEqual(["x", "y"]);
    expect(a?.skills_required).toEqual(["x"]);
    expect(a?.skills_used).toEqual(["x"]);
  });

  test("applyOutcome keeps existing field values when the outcome omits them", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("a", { knowledge_heavy: true, skills_required: ["pre"] })],
      // dispatcher reports nothing skills-related → existing values must survive (no undefined clobber).
      dispatcher: async () => ({ status: "verifying", confidence: 1, evidence: ["e"] }),
      reviewer: () => ({ pass: true, reason: "ok" }),
    });
    const a = units.find((u) => u.name === "a");
    expect(a?.knowledge_heavy).toBe(true);
    expect(a?.skills_required).toEqual(["pre"]);
  });
});

describe("investigateUnit — bounded async investigation (defect #5)", () => {
  test("never exceeds maxRounds", async () => {
    const r = await investigateUnit(unit("u", { confidence: 0.2 }), {
      riskClass: "security",
      maxRounds: 3,
      // Confidence rises each round but never reaches 0.95 → exhausts the round budget.
      research: async (round) => ({ findings: [`new${round}`], confidence: 0.2 + round * 0.1 }),
    });
    expect(r.rounds.length).toBe(3);
    expect(r.stoppedBy).toBe("max-rounds");
    expect(r.proceed).toBe(false);
  });

  test("stops early on no-new-evidence", async () => {
    const r = await investigateUnit(unit("u", { confidence: 0.5 }), {
      riskClass: "feature",
      research: async () => ({ findings: [], confidence: 0.5 }),
    });
    expect(r.rounds.length).toBe(1);
    expect(r.stoppedBy).toBe("no-new-evidence");
  });

  test("stops on blocked-by-missing-input", async () => {
    const r = await investigateUnit(unit("u", { confidence: 0.4 }), {
      riskClass: "feature",
      research: async () => ({ findings: ["partial"], confidence: 0.6, blocked: true }),
    });
    expect(r.stoppedBy).toBe("blocked-by-missing-input");
    expect(r.proceed).toBe(false);
  });

  test("records rounds + evidence and proceeds when threshold met", async () => {
    const r = await investigateUnit(unit("u", { confidence: 0.5 }), {
      riskClass: "docs", // threshold 0.7
      research: async (round) => ({ findings: [`f${round}`], confidence: 0.5 + round * 0.2 }),
    });
    expect(r.stoppedBy).toBe("threshold-met");
    expect(r.proceed).toBe(true);
    expect(r.finalConfidence).toBeGreaterThanOrEqual(thresholdFor("docs"));
    expect(r.rounds.length).toBeGreaterThan(0);
    expect(r.rounds[0]?.findings).toEqual(["f1"]);
  });

  test("blocked research with above-threshold start stops with blocked-by-missing-input (B1+B2 integrate)", async () => {
    const r = await investigateUnit(
      { name: "u", confidence: 0.9, owner_agent: undefined },
      {
        riskClass: "docs", // threshold 0.7
        research: async () => ({ findings: ["stale"], confidence: 0, blocked: true }),
      },
    );
    // Old code: Math.max(0.9, 0) = 0.9 → threshold-met. Fix: blocked → blocked-by-missing-input
    expect(r.stoppedBy).toBe("blocked-by-missing-input");
    expect(r.proceed).toBe(true); // confidence 0.9 >= 0.7 — blocked status doesn't change proceed
    expect(r.finalConfidence).toBe(0.9);
  });

  test("threshold-aware reviewer passes at-confidence and blocks below (B4 pattern)", async () => {
    const threshold = 0.85;
    const { units: pass } = await orchestrateUnits({
      units: [
        {
          name: "a",
          status: "pending",
          confidence: 0,
          scope: ["src/a/"],
          gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      concurrency: 1,
      dispatcher: async () => ({ status: "verifying", confidence: 0.85, evidence: ["e.log"] }),
      reviewer: (_u, o) =>
        o.confidence >= threshold && o.evidence.length
          ? { pass: true, reason: "ok" }
          : { pass: false, reason: "low" },
    });
    expect(pass.find((u) => u.name === "a")?.gates.review as string).toBe("pass");
    const { units: fail } = await orchestrateUnits({
      units: [
        {
          name: "b",
          status: "pending",
          confidence: 0,
          scope: ["src/b/"],
          gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
          resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
        },
      ],
      concurrency: 1,
      dispatcher: async () => ({ status: "verifying", confidence: 0.6, evidence: ["e.log"] }),
      reviewer: (_u, o) =>
        o.confidence >= threshold && o.evidence.length
          ? { pass: true, reason: "ok" }
          : { pass: false, reason: "low" },
    });
    expect(fail.find((u) => u.name === "b")?.status as string).toBe("blocked");
    expect(fail.find((u) => u.name === "b")?.gates.review as string).toBe("fail");
  });
});
