// src/typesafe-health.ts — the file-backed System One circuit breaker.
//
// WHY FILE-BACKED: `vf hook` is a fresh process per tool call, so an in-memory breaker would
// never trip. State lives in `~/.vibeflow/typesafe-health.json` (never the repo), reached
// through the generic, injectable disk layer in src/typesafe-health-file.ts.
//
// TRANSITION TABLE (the pure `transition`; all I/O lives in the guard):
//   none -> idle (streak 0, trips 0, cooldown reset to base); disabled -> off; unconfigured ->
//   unconfigured (both with streak 0, trips 0); abort + cooldown -> UNCHANGED and
//   streak-neutral (a slow region must not park the breaker, a refusal must never trip it);
//   auth + budget -> open on the FIRST hit (retrying a bad key or a rate limit burns the clock);
//   network + server + schema + malformed -> streak + 1, open at `failStreakLimit`, with
//   cooldown = min(cap, base * 2 ** (consecutive_trips - 1)).
//
// ALLOW TABLE (`allowCall`): idle/off/unconfigured allow; open inside the cooldown refuses
// (deadline INCLUSIVE — at exactly `cooldown_until` ONE probe is granted and the record flips to
// half-open with `cooldown_until: undefined`); half-open refuses while a PROBE LEASE is held —
// one probe per `cooldown_ms` measured from `opened_at`, and the next caller after the lease
// expires is granted a probe (see the ALLOW TABLE in src/typesafe-breaker.ts, which owns the
// implementation). BOTH refusals stamp COOLDOWN through `transition`, whose COOLDOWN arm is
// streak-neutral, so the refusal contract and the streak ladder share one authority. An `open`
// record with NO deadline is ambiguous and is granted a probe too.
//
// No `enum`: every closed vocabulary is one frozen `as const` authority with an inferred union.
// This module imports NEITHER src/typesafe.ts NOR src/typesafe-settings.ts (the dependency runs
// one way), so it stays testable in isolation and the disabled path never loads the HTTP client.
import { LOG_CHANNEL, LOG_LEVEL, type LogChannel } from "./core/log-contract.js";
export {
  GOAL_HEALTH_FILE,
  PROBE_HEALTH_FILE,
  TYPESAFE_BUDGET_BUCKET,
  type TypesafeBudgetBucket,
  fileForBucket,
  healthPath,
} from "./typesafe-health-file.js";

import {
  TYPESAFE_BUDGET_BUCKET,
  type TypesafeBudgetBucket,
  fileForBucket,
} from "./typesafe-health-file.js";
import {
  FAILURE_CLASS,
  type FailureClass,
  type HealthFileClockIo,
  type HealthFileIo,
  TYPESAFE_STATE,
  healthCodec,
  healthPath,
  readHealthFile,
  updateHealthFile,
  writeHealthFile,
} from "./typesafe-health-file.js";
import type { TypesafeHealth } from "./typesafe-health-file.js";

// The closed vocabularies, the record shape, its total guard and the disk layer live in
// src/typesafe-health-file.ts — the 400-line cap forced that split — and the symbols below are
// re-exported because src/typesafe-health.ts stays the ONE module a call site imports.
export {
  FAILURE_CLASS,
  FAILURE_CLASSES,
  idleHealth,
  isFailureClass,
  isTypesafeHealth,
  isTypesafeState,
  TYPESAFE_STATE,
} from "./typesafe-health-file.js";
export type { FailureClass, TypesafeHealth, TypesafeState } from "./typesafe-health-file.js";

/** The injection seam every health function takes; its fields live with the file layer. */
export type HealthIo = HealthFileIo;
/** `HealthIo` plus the clock seam the guard and the write budget read. */
export type HealthClockIo = HealthFileClockIo;

// The PURE state machine (transition/allowCall/classifiers/tuning) lives in
// src/typesafe-breaker.ts - the 400-line cap forced that split - and is re-exported here, because
// src/typesafe-health.ts stays the ONE module a call site imports.
export {
  BREAKER_DEFAULTS,
  type BreakerTuning,
  allowCall,
  classifyHttp,
  classifyThrown,
  transition,
  tuningFor,
} from "./typesafe-breaker.js";
import {
  BREAKER_DEFAULTS,
  type BreakerTuning,
  allowCall,
  classifyThrown,
  transition,
  tuningFor,
} from "./typesafe-breaker.js";

/** The machine's codec for the record on disk: encode, and decode anything unusable to idle. */
const CODEC = healthCodec(BREAKER_DEFAULTS.cooldownBaseMs);

/** The classified failure a caller's `fn` OBSERVED, handed back WITHOUT a throw: the client
 *  fails open by returning `{ ok: false, class }`, so a guard that classified only `catch` would
 *  record a 401 as a success. */
export interface OutcomeSignal {
  cls: FailureClass;
  status?: number;
}
/** The adapter a call site builds once per guarded call and threads into BOTH sides. It clears
 *  on any later `ok`, so a retried-then-succeeded call never trips the breaker. */
export interface OutcomeProbe {
  onOutcome: (o: { ok: boolean; class?: FailureClass; status?: number }) => void;
  outcome: () => OutcomeSignal | undefined;
}
export function outcomeProbe(): OutcomeProbe {
  let seen: OutcomeSignal | undefined;
  return {
    onOutcome: (o) => {
      if (o.ok) seen = undefined;
      else
        seen = {
          cls: o.class ?? FAILURE_CLASS.NETWORK,
          ...(o.status === undefined ? {} : { status: o.status }),
        };
    },
    outcome: () => seen,
  };
}

/** `~/.vibeflow/typesafe-health.json` — the per-user root `vf init` uses, never the repo and
 *  never a git-tracked path. An injected `userRoot` IS that directory. */
export function typesafeHealthPath(userRoot?: string): string {
  return healthPath(userRoot);
}

/** Fail-open read: absent, garbage, hostile or unreadable all mean `idle`. */
export function readHealth(inject: HealthIo = {}): TypesafeHealth {
  return readHealthFile(inject, CODEC);
}

/** Best-effort serialized write (lock + budget + atomic rename); failures are swallowed. */
export async function writeHealth(h: TypesafeHealth, inject: HealthClockIo = {}): Promise<void> {
  await writeHealthFile(inject, CODEC, h);
}

/** The ONLY sanctioned read-modify-write: the lock is held across read + update + write, so a
 *  concurrent writer cannot lower a counter or clear a deadline. `undefined` when the lock is
 *  unavailable — which the guard treats as ALLOW, never as a block. */
export async function mutateHealth<T>(
  update: (h: TypesafeHealth) => { next: TypesafeHealth; result?: T },
  inject: HealthIo = {},
): Promise<T | undefined> {
  return updateHealthFile<TypesafeHealth, T>(inject, CODEC, (current) => {
    const { next, result } = update(current);
    return result === undefined ? { next } : { next, result };
  });
}

/** The per-RUN call budget's storage. Module scope is the point: `vf hook` is a fresh process
 *  per tool call, while the orchestrator's reviewer/planner calls share one.
 *
 *  Three counters, not one. `probeCallsThisRun` exists because a page token can reach
 *  `POST /api/typesafe/test`, which runs through the same guard: charging it here let a client
 *  with no business touching the judge spend the ENFORCEMENT budget, after which every
 *  hook/review call in that process returns `null` - the seam reports fall-through, the
 *  veto is gone, and `GET /api/typesafe` still reads `idle` because a budget stop returns before
 *  `record`. `goalCallsThisRun` splits the goal-coverage seam off the SAME way: it is the one
 *  enforcement call site an HTTP request boundary may spend, so `goalEvalOptions` must restart
 *  the run it is about to make WITHOUT zeroing the counter the hook/review seams share - a
 *  mounted route refunding budget it never spent would re-arm calls a drained run must refuse.
 *  Separation means no bucket can exhaust or refund another.
 *
 *  A long-lived server is NOT a run. `vf serve` answers requests for days, so a counter that only
 *  ever climbs would latch each seam off after its first `maxCalls` calls, for the server's whole
 *  lifetime, with no in-process recovery (a JSON-only `vf config typesafe reset` cannot reach
 *  module memory). Each server request boundary therefore resets the bucket IT is about to spend,
 *  at entry - `goalEvalOptions` (one `POST /api/verify?goal-eval=1`, the GOAL_COVERAGE bucket),
 *  `handleTypesafeTestRoute` (one tested click, the PROBE bucket), and the orchestrate route
 *  (one dispatched plan, the ENFORCEMENT bucket the planner/reviewer seams spend) - which is
 *  exactly the shape of one CLI invocation each. */
let callsThisRun = 0;
let probeCallsThisRun = 0;
let goalCallsThisRun = 0;
export function callsUsedThisRun(): number {
  return callsThisRun;
}
export function probeCallsUsedThisRun(): number {
  return probeCallsThisRun;
}
/** The goal-coverage seam's own count - what a `POST /api/verify?goal-eval=1` restarts. */
export function goalCallsUsedThisRun(): number {
  return goalCallsThisRun;
}
/** Zero one bucket, or all of them when no bucket is named.
 *
 *  Bucket-scoped because a reset is a REQUEST-boundary action: `POST /api/verify` restarts the
 *  goal-coverage count without touching a probe in flight or the enforcement count the hook/review
 *  seams share, a "Test connection" click restarts the probe count alone, and the orchestrate
 *  route restarts the enforcement count alone for the plan it is about to dispatch. Zeroing
 *  another bucket from a route would let one route's boundary silently refund the other's
 *  in-flight call. */
export function resetCallBudget(bucket?: TypesafeBudgetBucket): void {
  if (bucket === undefined || bucket === TYPESAFE_BUDGET_BUCKET.ENFORCEMENT) callsThisRun = 0;
  if (bucket === undefined || bucket === TYPESAFE_BUDGET_BUCKET.PROBE) probeCallsThisRun = 0;
  if (bucket === undefined || bucket === TYPESAFE_BUDGET_BUCKET.GOAL_COVERAGE) goalCallsThisRun = 0;
}

/** One bucket's used count. `undefined` bucket = the enforcement bucket, the guard's default. */
function usedForBucket(bucket: TypesafeBudgetBucket | undefined): number {
  if (bucket === TYPESAFE_BUDGET_BUCKET.PROBE) return probeCallsThisRun;
  if (bucket === TYPESAFE_BUDGET_BUCKET.GOAL_COVERAGE) return goalCallsThisRun;
  return callsThisRun;
}
function chargeForBucket(bucket: TypesafeBudgetBucket | undefined): void {
  if (bucket === TYPESAFE_BUDGET_BUCKET.PROBE) probeCallsThisRun += 1;
  else if (bucket === TYPESAFE_BUDGET_BUCKET.GOAL_COVERAGE) goalCallsThisRun += 1;
  else callsThisRun += 1;
}
/** One line per TRANSITION (never per call), shaped by the user-facing error table. */
function transitionLine(
  prev: TypesafeHealth,
  next: TypesafeHealth,
  cls: FailureClass,
): string | undefined {
  if (next.state === TYPESAFE_STATE.OPEN && prev.state !== TYPESAFE_STATE.OPEN) {
    if (cls === FAILURE_CLASS.AUTH)
      return `System One: 401 unauthorized — judge disabled until ${next.cooldown_until}`;
    if (cls === FAILURE_CLASS.BUDGET)
      return `System One: rate limited (${next.last_status}) — judge paused until ${next.cooldown_until}`;
    return `System One: circuit open after ${next.fail_streak} failures — retry at ${next.cooldown_until}`;
  }
  if (next.state !== prev.state && cls === FAILURE_CLASS.NONE) return "System One: recovered";
  if (cls === FAILURE_CLASS.SCHEMA)
    return "System One: response shape changed (422) — integration is a no-op until updated";
  if (cls === FAILURE_CLASS.ABORT) return "System One: unreachable (timeout) — judge skipped";
  return undefined;
}

/** The guard's own injection shape. `out` is deliberately the SAME shape as `out` from
 *  src/logbus/out.ts — a `(channel, ...parts) => void` line sink, NOT a string printer — so a
 *  call site passes `outBusOnly` directly with no adapter. */
export type GuardIo = HealthClockIo & {
  /** Defaults to the enforcement bucket; the probe route names PROBE explicitly. */
  bucket?: TypesafeBudgetBucket;
  out?: (channel: LogChannel, ...parts: unknown[]) => void;
  tuning?: BreakerTuning;
  outcome?: () => OutcomeSignal | undefined;
  signal?: AbortSignal;
};

/** Record one call's outcome and announce at most one line. `fresh` is re-read UNDER the lock,
 *  so a peer's trip that landed while `fn` was in flight survives this update. */
async function record(
  caller: string,
  cls: FailureClass,
  status: number | undefined,
  startedAt: number,
  inject: GuardIo,
): Promise<void> {
  const at = (inject.now ?? Date.now)();
  const tuning = inject.tuning ? tuningFor(inject.tuning) : BREAKER_DEFAULTS;
  // `writeBudgetMs` bounds whether a WRITE starts, so it must be measured from the start of THIS
  // write leg — not from guard entry. Threading the guard's `startedAt` (which also covers the
  // judge round-trip, up to `hookTimeoutMs`) meant every judge call slower than the hook's 500 ms
  // reservation had its outcome silently dropped, leaving the file-backed breaker — the only
  // ceiling `vf hook` has, since `callsThisRun` restarts per process — inert. A fresh instant here
  // charges only the record's own disk work.
  const writeIo: GuardIo = { ...inject, startedAt: at };
  let line: string | undefined;
  const changed = await mutateHealth((fresh) => {
    // A record that is open WITHOUT a deadline is ambiguous, so it is honoured as open: an
    // ambiguous record must never re-arm a breaker a peer just tripped.
    const holdingOpen =
      fresh.state === TYPESAFE_STATE.OPEN &&
      (fresh.cooldown_until === undefined || at < Date.parse(fresh.cooldown_until));
    const next = holdingOpen ? { ...fresh } : transition(fresh, cls, at, tuning, status);
    next.last_call = {
      at: new Date(at).toISOString(),
      caller,
      ms: Math.max(0, at - startedAt),
      ...(status !== undefined ? { status } : {}),
    };
    // The bucket's OWN counter, never a blanket one: a record that stored another bucket's usage
    // permanently misreported it, which is the split these counters exist to enforce.
    next.calls = usedForBucket(inject.bucket);
    line = transitionLine(fresh, next, cls);
    return { next, result: next.state !== fresh.state };
  }, writeIo);
  if (inject.out === undefined || line === undefined) return;
  const announced = changed === true;
  inject.out(
    announced ? LOG_CHANNEL.VIBE_FLOW : LOG_CHANNEL.HOOK,
    {
      level: announced ? LOG_LEVEL.WARN : LOG_LEVEL.DEBUG,
    },
    line,
  );
}

/**
 * The single choke point every call site goes through: budget → decide under the lock → run
 * `fn` OUTSIDE the lock (it costs up to `timeoutMs`) → record the outcome. A throw, a classified
 * failure, a budget stop and an unreadable breaker ALL return `null` and leave the caller's
 * existing local gate authoritative: no failure can open a gate or change a verdict.
 */
export async function withTypesafeGuard<T>(
  caller: string,
  fn: () => Promise<T | null>,
  inject: GuardIo = {},
): Promise<T | null> {
  const now = (inject.now ?? Date.now)();
  // Every read and write below goes through this, not `inject`, so the probe's outcome lands in its
  // own record and can never transition the enforcement circuit. `startedAt` is deliberately NOT
  // stamped here: `writeUnlocked` compares it against `writeBudgetMs` to bound whether a WRITE
  // starts, and the guard's leg also covers the judge round-trip (`hookTimeoutMs`, 3x the hook's
  // write reservation). `record()` stamps a fresh instant for its own write instead; the pre-fix
  // code fell back to `clock()` adjacent to the write, so the reservation bounded nothing.
  const io: GuardIo = {
    ...inject,
    healthFile: fileForBucket(inject.bucket),
    // Bounds the ALLOW-path write, which happens here at entry. `record()` re-stamps this for its
    // own (post-judge) write, so the judge round-trip never charges the write reservation.
    startedAt: inject.startedAt ?? now,
  };
  const maxCalls = inject.tuning?.maxCalls ?? BREAKER_DEFAULTS.maxCalls;
  // Fast path: an already-spent bucket never cycles the health file. The REAL ceiling check runs
  // below, under the lock: checked outside and charged only after `mutateHealth` resolved, two
  // guarded calls started in one tick each read the same pre-charge count and each charged - the
  // run spent one over `maxCalls` (`vf serve` keeps the guard process-wide).
  if (usedForBucket(inject.bucket) >= maxCalls) return null;
  const allow = await mutateHealth((h) => {
    // Re-checked INSIDE the callback: read, check, and charge now run under the lock, the one
    // place a concurrent writer cannot slip between them.
    if (usedForBucket(inject.bucket) >= maxCalls) return { next: h, result: false };
    const r = allowCall(h, now);
    // Charged only once the call is actually allowed: incrementing at entry spent a unit on a call
    // the breaker had already refused, so `maxCalls` refused calls exhausted the whole per-run
    // budget and every later legitimate call returned null for the rest of the process.
    if (r.allow) chargeForBucket(inject.bucket);
    return { next: r.next, result: r.allow };
  }, io);
  if (allow === false) return null;
  // A lock failure (`undefined`) still ALLOWED the call - never a block - so its spend still counts.
  if (allow === undefined) chargeForBucket(inject.bucket);
  try {
    const value = await fn();
    const signal = inject.outcome?.();
    const cls = signal?.cls ?? FAILURE_CLASS.NONE;
    await record(caller, cls, signal?.status, now, io);
    // ANY classified failure is a REFUSAL, not an answer: `disabled`/`unconfigured` mean no key or
    // no permission, and auth/budget/server/schema/malformed/network mean the judge could not
    // answer. Whatever `fn` returned in those cases is not a verdict the seam may act on - treating
    // only the first two as refusals delegated this last-line defence to each caller, so one helper
    // returning a cached value would let a verdict through a failed call. The record is still
    // written (so `status` tells the truth) and the caller gets the `null` for its fallback.
    if (cls !== FAILURE_CLASS.NONE) return null;
    return value;
  } catch (err) {
    await record(caller, classifyThrown(err, inject.signal?.aborted ?? false), undefined, now, io);
    return null;
  }
}
