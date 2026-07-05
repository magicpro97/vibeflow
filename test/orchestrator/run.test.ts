import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../../src/core.js";
import { orchestrateUnits, runParallel } from "../../src/orchestrator/run.js";

function unit(name: string): WorkUnit {
  return {
    name,
    status: "pending",
    confidence: 0,
    scope: [`src/${name}/`],
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
}

const passDispatcher = async () => ({
  status: "done" as const,
  confidence: 0.9,
  evidence: ["e.log"],
});

const passReviewer = () => ({ pass: true, reason: "ok" });

const alwaysRun = () => () => Promise.resolve("run" as const);

function secResult(verdict: string): string {
  return `SECURITY_CHECK_RESULT\nverdict: ${verdict}\nitems_checked: 10\nitems_failed: none\nevidence: test`;
}

describe("orchestrateUnits — security checkpoint (lines 205-215)", () => {
  test("verdict fail → status blocked, gates.security=fail", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("sec-fail")],
      dispatcher: passDispatcher,
      reviewer: passReviewer,
      security: {
        base: "/tmp",
        askFn: alwaysRun,
        runSkillFn: async () => secResult("fail"),
      },
    });
    const u = units.find((x) => x.name === "sec-fail");
    expect(u).toBeDefined();
    expect(u?.security?.verdict).toBe("fail");
    expect(u?.gates.security).toBe("fail");
  });

  test("verdict pass → gates.security=pass", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("sec-pass")],
      dispatcher: passDispatcher,
      reviewer: passReviewer,
      security: {
        base: "/tmp",
        askFn: alwaysRun,
        runSkillFn: async () => secResult("pass"),
      },
    });
    const u = units.find((x) => x.name === "sec-pass");
    expect(u).toBeDefined();
    expect(u?.security?.verdict).toBe("pass");
    expect(u?.gates.security).toBe("pass");
  });

  test("verdict needs-review → gates.security=pass", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("sec-review")],
      dispatcher: passDispatcher,
      reviewer: passReviewer,
      security: {
        base: "/tmp",
        askFn: alwaysRun,
        runSkillFn: async () => secResult("needs-review"),
      },
    });
    const u = units.find((x) => x.name === "sec-review");
    expect(u).toBeDefined();
    expect(u?.security?.verdict).toBe("needs-review");
    expect(u?.gates.security).toBe("pass");
  });
});

describe("orchestrateUnits — two-stage escalation (#519)", () => {
  test("cheap gate failed → security checkpoint SKIPPED, unit still blocked", async () => {
    let asked = 0;
    const spyAsk = () => () => {
      asked++;
      return Promise.resolve("run" as const);
    };
    const { units } = await orchestrateUnits({
      units: [unit("cheap-fail")],
      // dispatcher reports a failing cheap gate (test) → blocked before expensive stage
      dispatcher: async () => ({
        status: "blocked" as const,
        confidence: 0,
        evidence: ["e.log"],
        gates: { test: "fail" as const },
      }),
      // Production reviewer blocks a failed cheap gate (dispatch-runtime.ts:382);
      // model that here so the unit stays blocked without the security pass.
      reviewer: () => ({ pass: false, reason: "cheap gate test=fail" }),
      security: {
        base: "/tmp",
        askFn: spyAsk,
        runSkillFn: async () => secResult("pass"),
      },
    });
    const u = units.find((x) => x.name === "cheap-fail");
    // askFn NOT called — the expensive/interactive security pass was skipped.
    expect(asked).toBe(0);
    // unit is still blocked (dispatcher status + no security pass to lift it).
    expect(u?.status).toBe("blocked");
    // no security verdict was attached because the checkpoint never ran.
    expect(u?.gates.security).toBeUndefined();
  });

  test("regression: cheap gates pass → security checkpoint runs (askFn called once)", async () => {
    let asked = 0;
    const spyAsk = () => (_q: string) => {
      asked++;
      return Promise.resolve("run" as const);
    };
    const { units } = await orchestrateUnits({
      units: [unit("cheap-pass")],
      dispatcher: async () => ({
        status: "done" as const,
        confidence: 0.9,
        evidence: ["e.log"],
        gates: { build: "pass" as const, lint: "pass" as const, test: "pass" as const },
      }),
      reviewer: passReviewer,
      security: {
        base: "/tmp",
        askFn: spyAsk,
        runSkillFn: async () => secResult("pass"),
      },
    });
    const u = units.find((x) => x.name === "cheap-pass");
    expect(asked).toBe(1);
    expect(u?.gates.security).toBe("pass");
  });

  test("dispatcher THREW → blocked outcome (no gates) → security checkpoint SKIPPED", async () => {
    let asked = 0;
    const spyAsk = () => () => {
      asked++;
      return Promise.resolve("run" as const);
    };
    const { units } = await orchestrateUnits({
      units: [unit("throw-unit")],
      // Dispatcher throws → run.ts catches it into `{ status: "blocked" }` with
      // NO `gates` key. Guard must still short-circuit on the blocked status.
      dispatcher: async () => {
        throw new Error("dispatcher boom");
      },
      // Production reviewer blocks a blocked outcome (dispatch-runtime.ts:382);
      // model that so the unit stays blocked without the security pass.
      reviewer: () => ({ pass: false, reason: "dispatcher threw" }),
      security: {
        base: "/tmp",
        askFn: spyAsk,
        runSkillFn: async () => secResult("pass"),
      },
    });
    const u = units.find((x) => x.name === "throw-unit");
    // askFn NOT called — the expensive/interactive security pass was skipped.
    expect(asked).toBe(0);
    // unit is still blocked (dispatcher-throw outcome, no security pass to lift it).
    expect(u?.status).toBe("blocked");
    // no security verdict was attached because the checkpoint never ran.
    expect(u?.gates.security).toBeUndefined();
  });
});

describe("runParallel — AbortSignal", () => {
  test("stops pulling new items once the signal aborts", async () => {
    const started: number[] = [];
    const ac = new AbortController();
    await runParallel(
      [0, 1, 2, 3, 4, 5],
      async (i) => {
        started.push(i);
        if (i === 1) ac.abort();
        return i;
      },
      1,
      0,
      undefined,
      ac.signal,
    );
    expect(started).toEqual([0, 1]);
  });

  test("no signal — all items run (back-compat)", async () => {
    const started: number[] = [];
    await runParallel(
      [0, 1, 2],
      async (i) => {
        started.push(i);
        return i;
      },
      2,
    );
    expect(started.sort()).toEqual([0, 1, 2]);
  });
});

describe("orchestrateUnits — quota-skip abort", () => {
  test("aborts remaining lanes when a unit returns quota-skip evidence", async () => {
    const called: string[] = [];
    const dispatcher = async (u: WorkUnit) => {
      called.push(u.name);
      if (u.name === "quota-hit") {
        return {
          status: "blocked" as const,
          confidence: 0,
          // Matches the EXACT prefix the dispatcher emits (dispatch-runtime.ts):
          // `skipped: upstream rate limit (${kind})`.
          evidence: ["skipped: upstream rate limit (quota)"],
        };
      }
      return {
        status: "done" as const,
        confidence: 0.9,
        evidence: ["e.log"],
      };
    };
    const reviewer = () => ({ pass: true, reason: "ok" });
    // concurrency 1 → serial. quota-hit triggers abort, should-skip never dispatched.
    const { units, reviews } = await orchestrateUnits({
      units: [unit("quota-hit"), unit("should-skip")],
      dispatcher,
      reviewer,
      concurrency: 1,
    });
    expect(called).toEqual(["quota-hit"]);
    // The skipped unit leaves a sparse hole in the lane arrays; the result must
    // be DENSE (no undefined) so downstream `reviews.map(r => r.unit)` never
    // reads undefined.unit.
    expect(units).toHaveLength(1);
    expect(reviews).toHaveLength(1);
    expect(units.every((u) => u !== undefined)).toBe(true);
    expect(reviews.every((r) => r !== undefined)).toBe(true);
  });
});

describe("orchestrateUnits — self-reported confidence cap (issue #349)", () => {
  test("engine reports confidence 1.0 → capped at 0.5", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("cap-me")],
      dispatcher: async () => ({
        status: "done" as const,
        confidence: 1.0,
        evidence: ["e.log"],
      }),
      reviewer: passReviewer,
      concurrency: 1,
    });
    const u = units.find((x) => x.name === "cap-me");
    expect(u).toBeDefined();
    expect(u?.confidence).toBe(0.5);
  });

  test("engine reports confidence 0.3 → stays 0.3 (below cap)", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("low-conf")],
      dispatcher: async () => ({
        status: "done" as const,
        confidence: 0.3,
        evidence: ["e.log"],
      }),
      reviewer: passReviewer,
      concurrency: 1,
    });
    const u = units.find((x) => x.name === "low-conf");
    expect(u).toBeDefined();
    expect(u?.confidence).toBe(0.3);
  });

  test("engine reports confidence 0 → stays 0", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("zero-conf")],
      dispatcher: async () => ({
        status: "done" as const,
        confidence: 0,
        evidence: ["e.log"],
      }),
      reviewer: passReviewer,
      concurrency: 1,
    });
    const u = units.find((x) => x.name === "zero-conf");
    expect(u).toBeDefined();
    expect(u?.confidence).toBe(0);
  });
});

describe("orchestrateUnits — onProgress callback", () => {
  test("fires start then done for each unit with index/total/pass", async () => {
    const events: Array<{
      phase: string;
      unit: string;
      index: number;
      total: number;
      pass?: boolean;
    }> = [];
    await orchestrateUnits({
      units: [unit("a"), unit("b")],
      dispatcher: passDispatcher,
      reviewer: passReviewer,
      concurrency: 1,
      onProgress: (ev) => events.push(ev),
    });
    // 2 units → 2 start + 2 done = 4 events
    expect(events).toHaveLength(4);
    // serial (concurrency 1): a starts, a done, b starts, b done
    expect(events.map((e) => `${e.phase}:${e.unit}`)).toEqual([
      "start:a",
      "done:a",
      "start:b",
      "done:b",
    ]);
    // every event carries the right total; done events carry pass
    expect(events.every((e) => e.total === 2)).toBe(true);
    expect(events.filter((e) => e.phase === "done").every((e) => e.pass === true)).toBe(true);
    // start events carry the unit's list index
    expect(events.find((e) => e.phase === "start" && e.unit === "a")?.index).toBe(0);
    expect(events.find((e) => e.phase === "start" && e.unit === "b")?.index).toBe(1);
  });

  test("done event carries pass=false when the reviewer blocks the unit", async () => {
    const events: Array<{ phase: string; pass?: boolean }> = [];
    await orchestrateUnits({
      units: [unit("blocked")],
      dispatcher: passDispatcher,
      reviewer: () => ({ pass: false, reason: "nope" }),
      concurrency: 1,
      onProgress: (ev) => events.push(ev),
    });
    const doneEv = events.find((e) => e.phase === "done");
    expect(doneEv?.pass).toBe(false);
  });

  test("omitting onProgress is a no-op (back-compat)", async () => {
    // No onProgress — must not throw and must still produce results.
    const { units, reviews } = await orchestrateUnits({
      units: [unit("solo")],
      dispatcher: passDispatcher,
      reviewer: passReviewer,
      concurrency: 1,
    });
    expect(units).toHaveLength(1);
    expect(reviews).toHaveLength(1);
  });
});

describe("orchestrateUnits — evidence freshness stamp (#517)", () => {
  test("stamps new evidence keys with the injected clock", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("stamp-me")],
      dispatcher: passDispatcher,
      reviewer: passReviewer,
      concurrency: 1,
      now: () => "2021-06-06T00:00:00.000Z",
    });
    const u = units.find((x) => x.name === "stamp-me");
    expect(u?.evidence_at?.["e.log"]).toBe("2021-06-06T00:00:00.000Z");
  });

  test("re-dispatch does NOT overwrite an existing timestamp (stamp-once)", async () => {
    // Seed a unit that already carries evidence + a timestamp, re-run with a NEW clock.
    const seeded: WorkUnit = {
      ...unit("keep-ts"),
      evidence: ["e.log"],
      evidence_at: { "e.log": "2020-01-01T00:00:00.000Z" },
    };
    const { units } = await orchestrateUnits({
      units: [seeded],
      dispatcher: passDispatcher, // re-reports evidence ["e.log"]
      reviewer: passReviewer,
      concurrency: 1,
      now: () => "2099-12-31T00:00:00.000Z",
    });
    const u = units.find((x) => x.name === "keep-ts");
    expect(u?.evidence_at?.["e.log"]).toBe("2020-01-01T00:00:00.000Z");
  });

  test("default clock stamps a valid ISO string when now is omitted", async () => {
    const { units } = await orchestrateUnits({
      units: [unit("default-clock")],
      dispatcher: passDispatcher,
      reviewer: passReviewer,
      concurrency: 1,
    });
    const ts = units[0]?.evidence_at?.["e.log"];
    expect(typeof ts).toBe("string");
    expect(ts).toBe(new Date(ts as string).toISOString());
  });

  // #534: stamp ONLY the current outcome's fresh evidence — legacy evidence
  // (carried on the unit but NOT re-produced this run) has an unknown true
  // capture time and must NOT get a fresh `now()` (that would mask staleness).
  test("legacy evidence not re-produced by the outcome is NOT stamped (#534)", async () => {
    const seeded: WorkUnit = {
      ...unit("legacy-mix"),
      evidence: ["legacy.log"], // predates evidence_at, dispatcher won't re-report it
      // no evidence_at → migration-era unit
    };
    const { units } = await orchestrateUnits({
      units: [seeded],
      // dispatcher produces DIFFERENT, fresh evidence this run
      dispatcher: async () => ({
        status: "done" as const,
        confidence: 0.9,
        evidence: ["fresh.log"],
      }),
      reviewer: passReviewer,
      concurrency: 1,
      now: () => "2099-01-01T00:00:00.000Z",
    });
    const u = units.find((x) => x.name === "legacy-mix");
    // fresh evidence IS stamped with the clock…
    expect(u?.evidence_at?.["fresh.log"]).toBe("2099-01-01T00:00:00.000Z");
    // …but legacy evidence is left UNSTAMPED (no fabricated capture time).
    expect(u?.evidence_at?.["legacy.log"]).toBeUndefined();
    // union still carries both strings for retention.
    expect(u?.evidence).toEqual(["legacy.log", "fresh.log"]);
  });
});
