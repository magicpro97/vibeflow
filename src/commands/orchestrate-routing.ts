// Planner engine routing (Task 7) — kept OUT of orchestrate.ts so that cap-bound file
// only delegates. `orchestrate.ts` reaches this module through a DYNAMIC import (issue #80:
// a static sibling edge would be an ESM cycle). The System One judge may name WHICH ready engine implements a
// unit; it may never widen the ready set and it may never become a default: a null answer
// leaves `unit.engine` undefined so dispatch keeps the run-global `resolveEngine(flags)`.

import { ENGINES, type Engine, type WorkUnit } from "../core/types.js";
import { outBusOnly } from "../logbus.js";
import {
  type EngineReadiness,
  preflightAll,
  preflightAllAsync,
  readyEngines,
} from "../preflight.js";
import { outcomeProbe, tuningFor, withTypesafeGuard } from "../typesafe-health.js";
import type { TypesafeSettings } from "../typesafe-settings.js";
// TYPE-ONLY: erased at compile time, so it evaluates nothing. The HTTP client module is
// loaded by the `await import` inside the gate below.
import type { judgeEngineKey } from "../typesafe.js";
import type { PreflightFn } from "./_shared.js";

/** Membership in the ready pool, as a TYPE GUARD, so the branch that assigns `unit.engine`
 *  narrows `string` to `Engine` at compile time. `judgeEngineKey` already filters its own
 *  answer (src/typesafe.ts:346); this is the seam-side authority, and it must compare against
 *  the SAME `pool` array the judge was handed — not against ENGINES — because a user's
 *  `callSites`-independent `--engine` choice and preflight's readiness are different things. */
function inPool(pool: readonly Engine[], name: string): name is Engine {
  return (pool as readonly string[]).includes(name);
}

/** The ONE field list for this seam. It is NOT a `JudgeInject`: it is destructured
 *  field-by-field and its parts are forwarded explicitly, so nothing unreviewed can leak
 *  into a judge call. */
export interface RoutingInject {
  judge?: typeof judgeEngineKey;
  settings?: TypesafeSettings;
  env?: NodeJS.ProcessEnv;
  userRoot?: string;
}

/** The orchestrate-side wiring: probe the ready set, then delegate. The two gates live here
 *  so `orchestrate.ts` gains ONE branch-free line and a disabled run never probes. */
export interface RouteForDispatchOpts {
  preflight?: PreflightFn;
  userRoot?: string;
  env?: NodeJS.ProcessEnv;
  judge?: typeof judgeEngineKey;
}

/**
 * Assign `unit.engine` ONLY from a successful judge answer. Fail-open is a NO-OP, never a
 * default pick: there is no `?? pool[0]`, because `pool[0]` is preflight input order rather
 * than the user's selection — defaulting to it would turn a judge failure into a positive
 * routing decision that silently overrides the run-global engine.
 */
export async function routeUnits(
  units: WorkUnit[],
  ready: readonly EngineReadiness[],
  inject: RoutingInject = {},
): Promise<WorkUnit[]> {
  const pool = readyEngines([...ready]); // one engine = nothing to choose
  if (pool.length < 2) return units;
  const { judge, settings, env, userRoot } = inject;
  if (!settings?.enabled || !settings.callSites.planner) return units;
  const timeoutMs = settings.timeoutMs;
  // C27-c: `src/typesafe.ts` (the HTTP client) is evaluated ONLY here, inside the gate. BOTH
  // guards above precede this line, so a disabled run — and the `pool.length < 2` early
  // return — never load the only socket-bearing module in the repo.
  const judgeFn = judge ?? (await import("../typesafe.js")).judgeEngineKey;
  // SEQUENTIAL on purpose, and bounded by the SHARED per-run budget: with `Promise.all` every
  // call read health state before any of them resolved, so one unreachable vendor meant N hung
  // requests instead of one observed failure. The call ceiling is NOT counted here —
  // `withTypesafeGuard` owns `callsThisRun` and refuses at `tuning.maxCalls`, so the reviewer
  // and goalCoverage seams running alongside it are bounded by the same number.
  const out: WorkUnit[] = [];
  for (const u of units) {
    if (u.engine) {
      out.push(u);
      continue;
    }
    const probe = outcomeProbe();
    const routed = await withTypesafeGuard(
      "planner",
      // Explicit JudgeInject field list; never a `{ ...inject }` spread.
      () =>
        judgeFn(u, pool, {
          settings,
          env,
          timeoutMs,
          onOutcome: probe.onOutcome,
          ...(userRoot === undefined ? {} : { userRoot }),
        }),
      {
        out: outBusOnly,
        tuning: tuningFor(settings),
        outcome: probe.outcome,
        ...(userRoot === undefined ? {} : { userRoot }),
      },
    );
    // READY-SET GUARD (Task 10): the pool `preflight` found is the ONLY authority on which
    // engine may implement a unit. `judgeEngineKey` filters its own answer against the pool
    // it was handed (src/typesafe.ts:346), but a client regression, a parse slip, or a
    // future seam that builds its own prompt would hand back a name that was never verified
    // as runnable — and `unit.engine` is what dispatch acts on, so an unverified name marks an
    // UNREADY plan ready and the failure surfaces as a dispatch error, not a routing no-op.
    // The guard is deliberately COMPILE-CHECKED: `inPool` narrows `string` to `Engine` on the
    // branch that passes, so a later edit that widens `pool` to a non-engine string fails to
    // typecheck instead of silently assigning an unverified name to a unit.
    const admissible = routed !== null && inPool(pool, routed) ? routed : undefined;
    // fail-open: no admissible judge answer ⇒ no routing decision, dispatch keeps
    // resolveEngine(flags)
    out.push(admissible === undefined ? u : { ...u, engine: admissible });
  }
  return out;
}

/** orchestrate's entry point: the enabled/planner gates plus the ready-set probe, so the
 *  cap-bound `orchestrate.ts` stays a single delegation. */
/**
 * The production preflight for dispatch routing: the ASYNC probe.
 *
 * A synchronous probe cannot durably own a spawned process, so `checkEngine` answers
 * `probe-failed` for every engine that needs one (`src/preflight.ts:169-173`). Used as the routing
 * default it meant no live-probe engine was ever ready outside tests, and the planner routing this
 * module exists for never happened in a real `vf orchestrate`.
 */
export const defaultPreflight: PreflightFn = (engines) => preflightAllAsync(engines);

export async function routeForDispatch(
  units: WorkUnit[],
  settings: TypesafeSettings | undefined,
  inject: RouteForDispatchOpts = {},
): Promise<WorkUnit[]> {
  if (!settings?.enabled || !settings.callSites.planner) return units;
  const ready = inject.preflight
    ? await inject.preflight([...ENGINES])
    : preflightAll([...ENGINES]);
  return routeUnits(units, ready, {
    settings,
    ...(inject.userRoot === undefined ? {} : { userRoot: inject.userRoot }),
    ...(inject.env === undefined ? {} : { env: inject.env }),
    ...(inject.judge === undefined ? {} : { judge: inject.judge }),
  });
}
