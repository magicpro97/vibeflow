// src/commands/hook-risk-integration.ts
//
// The System One risk seam for `vf hook` (plan Task 6). It lives OUTSIDE
// src/commands/hooks.ts on purpose: that file is 699 lines against the 400 cap, held there
// only by an inline waiver for an UNRELATED feature (#462, the web UI approval path), so
// inlining ~35 lines of seam plus ~30 lines of budget commentary would hide unrelated growth
// inside someone else's waiver. `hooks.ts` therefore gains only a dynamic import and a call,
// and every word of the budget arithmetic below lives here.
//
// ## Hook budget arithmetic (FIVE legs, ONE total budget, strictly under the spawn budget)
//
// The agent spawns `vf hook` with `timeout: 10_000` (src/hooks/adapters.ts:281) and turns a
// non-zero exit into `{ decision: "block" }` (:283-284), so the legs must sum STRICTLY below it:
//
//     5_000  stdin drain            (HOOK_STDIN_BUDGET_MS, defined in src/typesafe-settings.ts:107;
//                                    the drain it bounds is src/commands/hooks.ts:118-130)
//   + 1_500  judge HTTP + its one retry, ONE shared AbortSignal deadline (HOOK_TIMEOUT_CAP_MS)
//   +     0  health LOCK wait     (`lockWaitMs: 0` in healthIo below)
//   +   500  health WRITE         (`writeBudgetMs: HOOK_HEALTH_WRITE_BUDGET_MS`, below)
//   + 2_000  audit bus lock wait  (2 x HOOK_BUS_LOCK_RETRIES_MAX x HOOK_BUS_LOCK_RETRY_MS)
//   = 9_000  < 10_000, leaving HOOK_SAFETY_MARGIN_MS (1_000) unspent.
//
// The AUDIT leg is easy to miss because `Logbus.write` LOOKS fire-and-forget. It is not, in
// wall-clock terms: it queues `this.chain = this.chain.then(() => this.writeLocked(ev))`
// (src/logbus.ts:110) and `writeLocked` awaits `acquireLock()` (`:116`) with the repo default
// of `ceil(5000/50) = 100` x `50 ms` (:213) — up to 5 s. src/cli.ts:373 sets
// `process.exitCode` rather than calling `process.exit`, so those pending lock-retry timers
// keep the event loop alive and `vf hook` cannot exit until the chain settles. Contention is
// structural: every concurrent hook process installs its own bus against the same
// repo-relative lock. `lockRetries: 0` makes acquisition fail fast, the event is dropped, and
// the gate returns on time — a lost audit line is fail-open, a blocked tool call is not.
//
// The leg is DOUBLED: a single event can acquire the lock twice, because on ENOENT
// `recoverAndRelock` (src/logbus.ts:123) re-locks via `acquireLock()` (:181), and proper-
// lockfile's `retry` retries every error without an `errorFilter`
// (node_modules/proper-lockfile/lib/lockfile.js:236) — so a missing log dir burns the whole
// first budget before the second acquisition starts. The ceiling is therefore
// HOOK_BUS_LOCK_RETRIES_MAX (20, the RESIDUAL after the other four legs halved for that second
// acquisition), NOT the repo's 100: at 100 the sum above is 17_000 ms and a legal
// `{ hookBusLockRetries: 100 }` alone blocks the tool call. Both health legs are bounded by
// values the SEAM hands in, not by prose: `lockWaitMs: 0` removes the LOCK wait and
// `writeBudgetMs` reserves the WRITE.
import { join } from "node:path";
import type { HookInput } from "../core.js";
import { type SemanticJudge, shouldConsultSemantic } from "../hooks/risk-semantic.js";
import { scoreRisk } from "../hooks/risk.js";
// TYPE-ONLY: erased at compile time, so it evaluates nothing. The HTTP client module is loaded
// by the `await import` inside the enabled gate in `integrateRiskJudge` (C27-c).
import { hooksDisabled } from "../hooks/runner.js";
import type { ResolvedHookPolicy } from "../hooks/templates.js";
import { getLogbus, installLogbus, outBusOnly } from "../logbus.js";
import type { VibeSettings } from "../settings.js";
import { type HealthIo, outcomeProbe, tuningFor, withTypesafeGuard } from "../typesafe-health.js";
import { userVibeflowDir } from "../typesafe-key-file.js";
import {
  HOOK_BUS_LOCK_RETRIES_MAX,
  HOOK_HEALTH_WRITE_BUDGET_MS,
  HOOK_TIMEOUT_CAP_MS,
  isTypesafeEnabled,
} from "../typesafe-settings.js";
import type { TypesafeSettings } from "../typesafe-settings.js";
import type { TypesafeFetch, judgeRisk } from "../typesafe.js";
import { CTX_DIR } from "./_shared.js";

/** The audit bus install, as `hook()` performs it — injected so a test never touches disk. */
export type BusInstall = (opts: { dir: string; lockRetries?: number }) => unknown;
/** The two disk bounds the seam hands the breaker, observed as a whole (a test seam). */
export type HealthIoProbe = { lockWaitMs?: number; writeBudgetMs?: number; now?: () => number };

/** Everything `hook()` may inject for this seam. Disabled settings reach NONE of it. */
export interface RiskJudgeInject {
  /** Overrides the stored `settings.typesafe` block; `undefined` keeps the stored one. */
  typesafe?: TypesafeSettings;
  userRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  installLogbus?: BusInstall;
  healthIo?: (io: HealthIoProbe) => void;
  /** The breaker's cross-process lock seam (`HealthIo.lock`) — a test holds it by throwing. */
  lock?: HealthIo["lock"];
  judgeRisk?: typeof judgeRisk;
  /** The wire seam, forwarded to `judgeRisk`. Without it an end-to-end test through `hook()` cannot
   *  observe what this seam sends or how it classifies an answer — only a `judgeRisk` double, which
   *  is exactly the level the seam's own behaviour must not be tested at. */
  fetchFn?: TypesafeFetch;
}

export interface RiskJudgeDeps {
  input: HookInput;
  settings: VibeSettings;
  policy?: ResolvedHookPolicy;
  /** The repo root the audit bus and the policy are read from. */
  base: string;
  inject?: RiskJudgeInject;
}

/**
 * Build the OPTIONAL semantic judge for one hook event, or `undefined` when the integration
 * is off / unconfigured / already decided by the local gate. Every failure here returns
 * `undefined` (fail-open): the caller then evaluates exactly as it did before this module
 * existed, byte-for-byte.
 */
export async function integrateRiskJudge(deps: RiskJudgeDeps): Promise<SemanticJudge | undefined> {
  const { input, settings, base } = deps;
  const inject = deps.inject ?? {};
  const ts = settings.typesafe;
  // Re-apply BOTH ceilings here, exactly as the coercion does
  // (`Math.min(out.hookTimeoutMs, HOOK_TIMEOUT_CAP_MS, out.timeoutMs)`): a
  // `settings.typesafe` built by hand (a test, a future caller) never went through
  // `coerceTypesafeSettings`, and this process is about to spawn an HTTP request inside a hook
  // the agent can kill. Binding the raw `ts.hookTimeoutMs` here is what would make the
  // hand-built-settings budget escape the tool gate.
  const bounded = ts ? Math.min(ts.hookTimeoutMs, HOOK_TIMEOUT_CAP_MS, ts.timeoutMs) : undefined;
  // The budget must be a FINITE number BEFORE the call — an `undefined` here would let
  // systemOne fall back to the session-wide settings.timeoutMs.
  const hookTimeoutMs = bounded !== undefined && Number.isFinite(bounded) ? bounded : undefined;
  const healthIo: HealthIo = {
    // The shared per-user root, NOT `$HOME`: the bare home dir made the hook look for
    // `~/typesafe.env` and write `~/typesafe-health.json`, so it missed keys that `vf config
    // typesafe key` had written and dropped a file in the home directory. One authority
    // (`userVibeflowDir`) so the `VF_USER_VIBEFLOW_ROOT` override and the default agree on both sides.
    userRoot: inject.userRoot ?? userVibeflowDir(),
    lockWaitMs: 0,
    writeBudgetMs: HOOK_HEALTH_WRITE_BUDGET_MS,
    // Threaded through, not dropped: a caller that injects a clock must get it in the breaker's
    // record too, or `cooldown_until`/`last_call.ms`/`holdingOpen` are untimeable through this seam.
    ...(inject.now === undefined ? {} : { now: inject.now }),
    ...(inject.lock ? { lock: inject.lock } : {}),
  };
  inject.healthIo?.(healthIo);
  // The audit leg's lock-retry budget, SAME reasoning as the zero `lockWaitMs` above but a
  // settings field (C05): `hookBusLockRetries` defaults to 0 (fail fast, drop the event) and
  // `coerceTypesafeSettings` clamps it to `0..HOOK_BUS_LOCK_RETRIES_MAX`, so a user can
  // SHORTEN the audit leg without editing source but can NEVER lengthen the five-leg sum past
  // the spawn budget. Re-clamped HERE for the same defence-in-depth reason as `hookTimeoutMs`
  // (a hand-built settings object never ran coercion); the literal never reaches the install.
  const hookBusLockRetries = Math.max(
    0,
    Math.min(ts?.hookBusLockRetries ?? 0, HOOK_BUS_LOCK_RETRIES_MAX),
  );
  // Defence layer 3: score deterministically FIRST (`scoreRisk` is pure) so this costs no API
  // call, no disk work and no bus install. The judge is consulted ONLY when the deterministic
  // tier returned none/low on a non-trivial command, which is exactly the predicate
  // `shouldConsultSemantic(regexRisk, command)` already encodes and which `scoreRisk` re-runs
  // internally once a judge is injected.
  const deterministic = scoreRisk(input, deps.policy);
  const command = input.command ?? "";
  if (
    // The kill-switch, checked HERE as well as at the caller: `VIBEFLOW_HOOKS=off` means the
    // hook-decision layer is off, and leaving the guard to `hooks.ts` meant any other caller - or a
    // future reordering - POSTed the raw command to the vendor on a disarmed run.
    hooksDisabled(inject.env ?? process.env) ||
    !shouldConsultSemantic(deterministic.risk, command) ||
    !isTypesafeEnabled(settings) ||
    ts?.callSites.risk !== true ||
    hookTimeoutMs === undefined
  ) {
    return undefined;
  }
  // The bus install happens INSIDE the guarded lambda below, once `allowCall` has allowed the
  // call: installing here (before the guard) replaced the process-wide bus even when the guard
  // then REFUSED on budget/breaker — a side effect of a call that never happened. `installLogbus`
  // is NOT fail-safe OR idempotent: `new Logbus(...)` runs mkdirSync / appendFileSync / chmodSync
  // / statSync (src/logbus.ts:60-67), throws on EROFS/EACCES/ENOSPC, and stamps a fresh
  // `runId` — which is why the DEFAULT install is additionally seeded-if-absent.
  // C27-c: the HTTP client module is evaluated ONLY here, inside the enabled gate — a disabled
  // hook, or `callSites.risk: false` above, never loads it. No try/catch: unlike `installLogbus`
  // (mkdir / appendFile / chmod at construction) a module import performs no I/O, so a load
  // cannot throw inside this gate.
  const judge = inject.judgeRisk ?? (await import("../typesafe.js")).judgeRisk;
  // `outcome: probe.outcome` is REQUIRED, not decoration. The guard reads `inject.outcome?.()`
  // and falls back to `FAILURE_CLASS.NONE`, so a guard call that omits it records every vendor
  // failure as a SUCCESS: the failStreakLimit ladder never advances and the file-backed breaker
  // can never trip on this path. That matters most here — `vf hook` is a fresh process per tool
  // call, so `callsThisRun` restarts at 0 and the breaker is the ONLY ceiling this seam has.
  // `judgeRisk` never throws (classified failures collapse to null), so the guard's catch arm
  // cannot classify in its place. Mirrors src/commands/dispatch-reviewer-llm.ts.
  const probe = outcomeProbe();
  const tier = await withTypesafeGuard(
    "risk",
    async () => {
      // Only past `allowCall`, and (for the DEFAULT installer) only when no bus is active: an
      // in-process caller's own routing must survive the seam rather than be replaced by a
      // fresh runId (splitting one process's audit lines across two). An INJECTED installer is
      // an explicit override and always runs — same contract as before (test doubles, embedders).
      // `lockRetries` is what keeps the audit leg inside the tool-call budget; the catch keeps
      // the audit sink degradable to a no-op (`outBusOnly` no-ops on a null bus, so the breaker
      // still records to the health file and the tool gate is unaffected).
      if (inject.installLogbus !== undefined || getLogbus() === null) {
        try {
          (inject.installLogbus ?? installLogbus)({
            dir: join(base, CTX_DIR, "logs"),
            lockRetries: hookBusLockRetries,
          });
        } catch {
          // Degraded audit sink; the verdict is unaffected.
        }
      }
      return judge(command, {
        settings: ts,
        env: inject.env ?? process.env,
        userRoot: healthIo.userRoot as string,
        timeoutMs: hookTimeoutMs,
        onOutcome: probe.onOutcome,
        ...(inject.fetchFn === undefined ? {} : { fetchFn: inject.fetchFn }),
      });
    },
    // Transition lines only; the per-call audit record uses outBusOnly directly. `tuning`
    // MUST come from settings or the breaker ignores failStreakLimit/cooldown* entirely, and
    // `...healthIo` carries the two seam-passed disk bounds so the breaker's own I/O legs stay
    // inside the arithmetic above.
    {
      ...healthIo,
      out: outBusOnly,
      tuning: tuningFor(ts as TypesafeSettings),
      outcome: probe.outcome,
    },
  );
  // `scoreRisk` re-applies the raise-only merge (src/hooks/risk.ts:176) — there is exactly ONE
  // comparator; this seam only decides WHETHER the judge has an opinion.
  return tier ? () => tier : undefined;
}
