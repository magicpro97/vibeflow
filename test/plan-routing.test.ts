import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReviewer } from "../src/commands/dispatch-reviewer.js";
import {
  defaultPreflight,
  routeForDispatch,
  routeUnits,
} from "../src/commands/orchestrate-routing.js";
import { ENGINES, type WorkUnit } from "../src/core.js";
import { type EngineReadiness, preflightAll } from "../src/preflight.js";
import { resetCallBudget } from "../src/typesafe-health.js";
import { DEFAULT_TYPESAFE_SETTINGS, type TypesafeSettings } from "../src/typesafe-settings.js";

function unit(name: string): WorkUnit {
  return {
    name,
    status: "pending",
    confidence: 0,
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
}

const units: WorkUnit[] = [unit("a"), unit("b")];

const ready = (engine: EngineReadiness["engine"]): EngineReadiness => ({
  engine,
  level: "ready",
  detail: "ready (injected)",
  checkedAt: "",
});

/** The shared enabled fixture: `callSites.planner` defaults true. */
const plannerOn: TypesafeSettings = { ...DEFAULT_TYPESAFE_SETTINGS, enabled: true };

let userRoot: string;

beforeEach(() => {
  // The breaker owns a per-run call counter and a health file; both are reset so a test
  // never depends on (or leaks into) another test's budget.
  resetCallBudget();
  userRoot = mkdtempSync(join(tmpdir(), "vf-plan-routing-"));
});

describe("routeUnits (planner / engine routing)", () => {
  test("routing is a no-op with a single ready engine (no API call)", async () => {
    let calls = 0;
    const out = await routeUnits(units, [ready("claude")], {
      userRoot,
      judge: async () => {
        calls++;
        return "claude";
      },
    });
    expect(calls).toBe(0);
    expect(out.every((u) => u.engine === undefined)).toBe(true);
  });

  test("an empty ready set disables routing entirely", async () => {
    let calls = 0;
    const out = await routeUnits(units, [], {
      userRoot,
      judge: async () => {
        calls++;
        return "claude";
      },
    });
    expect(calls).toBe(0);
    expect(out).toEqual(units);
  });

  test("a confident judge answer routes the unit and never mutates the input", async () => {
    const out = await routeUnits(units, [ready("claude"), ready("codex")], {
      settings: plannerOn,
      userRoot,
      judge: async () => "codex",
    });
    expect(out.every((u) => u.engine === "codex")).toBe(true);
    expect(units.every((u) => u.engine === undefined)).toBe(true);
  });

  test("a null judge leaves every engine undefined (fail-open no-op)", async () => {
    const out = await routeUnits(units, [ready("claude"), ready("codex")], {
      settings: plannerOn,
      userRoot,
      judge: async () => null,
    });
    expect(out).toEqual(units);
    expect(out.every((u) => u.engine === undefined)).toBe(true);
  });

  test("a THROWING judge cannot reject the routing promise nor pick an engine", async () => {
    const out = await routeUnits(units, [ready("claude"), ready("codex")], {
      settings: plannerOn,
      userRoot,
      judge: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(out).toEqual(units);
    expect(out.every((u) => u.engine === undefined)).toBe(true);
  });

  test("callSites.planner off makes no judge call with the feature still enabled", async () => {
    let calls = 0;
    const out = await routeUnits(units, [ready("claude"), ready("codex")], {
      settings: { ...plannerOn, callSites: { ...plannerOn.callSites, planner: false } },
      userRoot,
      judge: async () => {
        calls++;
        return "codex";
      },
    });
    expect(calls).toBe(0);
    expect(out).toEqual(units);
    expect(out.every((u) => u.engine === undefined)).toBe(true);
  });

  test("the global gate is distinct from the planner toggle (enabled false, planner on)", async () => {
    let calls = 0;
    const out = await routeUnits(units, [ready("claude"), ready("codex")], {
      settings: { ...plannerOn, enabled: false },
      userRoot,
      judge: async () => {
        calls++;
        return "codex";
      },
    });
    expect(calls).toBe(0);
    expect(out.every((u) => u.engine === undefined)).toBe(true);
  });

  test("the planner judge receives the settings timeout explicitly", async () => {
    let seen: number | undefined;
    await routeUnits(units, [ready("claude"), ready("codex")], {
      settings: { ...plannerOn, timeoutMs: 4321 },
      userRoot,
      judge: async (_unit, _pool, opts) => {
        seen = opts?.timeoutMs;
        return null;
      },
    });
    expect(seen).toBe(4321);
  });

  test("an already-routed unit is left exactly as it is (no second judge call)", async () => {
    const pinned: WorkUnit[] = [{ ...unit("a"), engine: "claude" }, unit("b")];
    let calls = 0;
    const out = await routeUnits(pinned, [ready("claude"), ready("codex")], {
      settings: plannerOn,
      userRoot,
      judge: async () => {
        calls++;
        return "codex";
      },
    });
    // one call only: the pre-routed unit short-circuits, the other one is asked
    expect(calls).toBe(1);
    expect(out[0]).toBe(pinned[0]);
    expect(out[1]?.engine).toBe("codex");
  });

  test("no settings at all: the planner never calls out", async () => {
    let calls = 0;
    const out = await routeUnits(units, [ready("claude"), ready("codex")], {
      userRoot,
      judge: async () => {
        calls++;
        return "codex";
      },
    });
    expect(calls).toBe(0);
    expect(out).toEqual(units);
  });
});

describe("routeForDispatch (orchestrate wiring)", () => {
  test("no typesafe settings: units pass through untouched and no probe runs", async () => {
    let probed = 0;
    const out = await routeForDispatch(units, undefined, {
      userRoot,
      preflight: () => {
        probed++;
        return [ready("claude"), ready("codex")];
      },
    });
    expect(probed).toBe(0);
    expect(out).toEqual(units);
  });

  test("planner disabled: units pass through and no probe runs", async () => {
    let probed = 0;
    const out = await routeForDispatch(
      units,
      { ...plannerOn, callSites: { ...plannerOn.callSites, planner: false } },
      {
        userRoot,
        preflight: () => {
          probed++;
          return [ready("claude"), ready("codex")];
        },
      },
    );
    expect(probed).toBe(0);
    expect(out).toEqual(units);
  });

  test("enabled with an injected preflight: the ready set is probed and routed", async () => {
    const out = await routeForDispatch(units, plannerOn, {
      userRoot,
      preflight: () => [ready("claude"), ready("codex")],
      judge: async () => "codex",
    });
    expect(out.every((u) => u.engine === "codex")).toBe(true);
  });

  test("enabled without an injected preflight: the engine set is probed for real", async () => {
    // No live spawner, so nothing can be `ready` — the pool guard keeps this a no-op
    // rather than routing to a machine-dependent default.
    const out = await routeForDispatch(units, plannerOn, { userRoot });
    expect(out).toEqual(units);
    expect(out.every((u) => u.engine === undefined)).toBe(true);
  });
});

describe("reviewer implementer resolution", () => {
  // The seam reads the repo's settings ONCE per `makeReviewer` (via `cwd`), so every test pins an
  // explicit base directory: defaulting to `process.cwd()` silently read whatever this repo had
  // saved, and left "no block at all" indistinguishable from "opted in".
  const judgeBase = (reviewerEngine?: "unit" | "global"): string => {
    const base = mkdtempSync(join(tmpdir(), "vf-reviewer-"));
    mkdirSync(join(base, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(base, ".vibeflow", "SETTINGS.json"),
      JSON.stringify({
        typesafe: reviewerEngine ? { enabled: true, reviewerEngine } : { enabled: true },
      }),
    );
    return base;
  };

  test("the reviewer follows the UNIT's engine when the judge is installed", () => {
    // An installed block defaults to `reviewerEngine: "unit"` (coerceTypesafeSettings), and a
    // routed unit is the opt-in contract: the reviewer runs on the engine the unit ran on.
    const base = judgeBase();
    try {
      const mk = makeReviewer("cli", 0.8, { implementer: "claude", cwd: base });
      expect(mk.__implementerFor({ ...unit("a"), engine: "codex" })).toBe("codex");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an unrouted unit falls back to the run-global implementer", () => {
    const base = judgeBase();
    try {
      const mk = makeReviewer("cli", 0.8, { implementer: "claude", cwd: base });
      expect(mk.__implementerFor(unit("a"))).toBe("claude");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an install with no typesafe block keeps the run-global reviewer, engine or not", () => {
    // The off path stays byte-for-byte: with no block at all the policy resolves to `"global"`,
    // so a unit that carries an engine (state written while the judge was on, a hand-edited
    // ledger) must NOT silently re-route its reviewer onto it.
    const base = mkdtempSync(join(tmpdir(), "vf-reviewer-off-"));
    try {
      const mk = makeReviewer("cli", 0.8, { implementer: "claude", cwd: base });
      expect(mk.__implementerFor({ ...unit("a"), engine: "codex" })).toBe("claude");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("reviewerEngine 'global' pins the run-global implementer", () => {
    const base = judgeBase("global");
    try {
      const mk = makeReviewer("cli", 0.8, { implementer: "claude", cwd: base });
      expect(mk.__implementerFor({ ...unit("a"), engine: "codex" })).toBe("claude");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("with no inject implementer at all the seam resolves to the unit's engine", () => {
    const base = judgeBase();
    try {
      const mk = makeReviewer("cli", 0.8, { cwd: base });
      expect(mk.__implementerFor({ ...unit("a"), engine: "codex" })).toBe("codex");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a non-canonical unit engine never steers the reviewer", () => {
    // `unit.engine` arrives from plan/state JSON (`WorkUnit.engine` is `Engine`, but the file
    // can carry any string). `pickReviewerEngine` picks the first available engine that merely
    // `!==` its `implementer`, so a foreign id silently loses the cross-review invariant (the
    // reviewer could resolve back to the ACTUAL implementer). The seam must validate against
    // `ENGINES` and fall back to the run-global pin.
    const base = judgeBase();
    try {
      const mk = makeReviewer("cli", 0.8, { implementer: "claude", cwd: base });
      expect(mk.__implementerFor({ ...unit("a"), engine: "not-an-engine" as never })).toBe(
        "claude",
      );
      const bare = makeReviewer("cli", 0.8, { cwd: base });
      expect(
        bare.__implementerFor({ ...unit("a"), engine: "not-an-engine" as never }),
      ).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("the dispatch-routing preflight default", () => {
  test("is not the synchronous probe, which answers probe-failed for a live-probe engine", () => {
    // `checkEngine` cannot durably own a spawned process, so it stamps
    // `probe-failed: "<engine>: live probe requires async owned execution"` (src/preflight.ts:169-173).
    // This assertion pins the REASON the routing default cannot be it - and stays cheap: the sync
    // probe spawns nothing, so it is deterministic, unlike asserting on real async probe results.
    // `skipCache` is what keeps this honest: the probe cache is shared across the suite, so a
    // cached "ready" from an earlier file made this assertion fail in a full run while it passed
    // when this file ran alone - the assertion read the cache, not the synchronous probe.
    // `has: () => true` is what makes this machine-independent. Without it the sync probe answers
    // "no-binary" (the install hint) whenever the engines are not installed, and the detail this
    // assertion looks for only appears once the binary EXISTS - so the case passed on a developer
    // machine that had them and failed on CI, which has none. Probed by running this file under
    // `env -i PATH=/usr/bin:/bin`: the failure reproduces locally, and this seam removes it.
    const sync = preflightAll([...ENGINES], {
      skipCache: true,
      has: () => true,
    }) as { detail?: string }[];
    expect(
      sync.some((x) => String(x.detail ?? "").includes("requires async owned execution")),
    ).toBe(true);
  });

  test("and the routing default answers with a promise, even for no engines", async () => {
    // Identity cannot express this: wrapping the sync probe in an arrow makes a new function, so
    // `not.toBe(preflightAll)` stayed green when the regression was reintroduced (probe E1). An empty
    // engine list keeps this cheap - the async probe resolves immediately and spawns nothing, while the
    // sync one returns a plain array.
    const r = defaultPreflight([]);
    expect(typeof (r as unknown as { then?: unknown }).then).toBe("function");
    await r;
  });
});
