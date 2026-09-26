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
// half-open with `cooldown_until: undefined`); half-open always refuses, so a concurrent caller
// during a probe short-circuits to null. BOTH refusals stamp COOLDOWN through `transition`,
// whose COOLDOWN arm is streak-neutral, so the refusal contract and the streak ladder share one
// authority. An `open` record with NO deadline is ambiguous and is granted a probe too.
//
// No `enum`: every closed vocabulary is one frozen `as const` authority with an inferred union.
// This module imports NEITHER src/typesafe.ts NOR src/typesafe-settings.ts (the dependency runs
// one way), so it stays testable in isolation and the disabled path never loads the HTTP client.
import { LOG_CHANNEL, LOG_LEVEL, type LogChannel } from "./core/log-contract.js";
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

/** The four user-tunable breaker numbers. `maxCalls` travels HERE so ONE `tuning` object reaches
 *  every call site — a per-seam parameter could be forgotten by a future one. */
export interface BreakerTuning {
  failStreakLimit: number;
  cooldownBaseMs: number;
  cooldownCapMs: number;
  maxCalls: number;
}
/** DEFAULTS ONLY, for tests and for callers with no settings in hand; production threads the
 *  settings values through `tuningFor`, so a user retunes the breaker without editing source.
 *  Every number here also exists as a `TypesafeSettings` field. */
export const BREAKER_DEFAULTS: BreakerTuning = Object.freeze({
  failStreakLimit: 2,
  cooldownBaseMs: 60_000,
  cooldownCapMs: 900_000,
  maxCalls: 20,
});

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

/** Structural, NOT an import of src/typesafe-settings.ts (the isolation rule holds). */
export function tuningFor(s: BreakerTuning): BreakerTuning {
  return {
    failStreakLimit: s.failStreakLimit,
    cooldownBaseMs: s.cooldownBaseMs,
    cooldownCapMs: s.cooldownCapMs,
    maxCalls: s.maxCalls,
  };
}

/** 401/403 → auth (trip now), 429/529 → budget (trip now), 422 → schema, other 5xx → server
 *  (retryable), any other non-2xx → malformed (a rejected request, counted but never retried),
 *  2xx → none. */
export function classifyHttp(status: number): FailureClass {
  if (status >= 200 && status < 300) return FAILURE_CLASS.NONE;
  if (status === 401 || status === 403) return FAILURE_CLASS.AUTH;
  if (status === 429 || status === 529) return FAILURE_CLASS.BUDGET;
  if (status === 422) return FAILURE_CLASS.SCHEMA;
  if (status >= 500) return FAILURE_CLASS.SERVER;
  return FAILURE_CLASS.MALFORMED;
}

/** The caller's own signal, or a Timeout/Abort error, is an `abort`: streak-neutral, never
 *  retried (a second attempt only doubles the wait). Everything else is a transport failure. */
export function classifyThrown(err: unknown, aborted: boolean): FailureClass {
  if (aborted) return FAILURE_CLASS.ABORT;
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return FAILURE_CLASS.ABORT;
  return FAILURE_CLASS.NETWORK;
}

/** The pure state function. Every external dependency (fs, clock, settings, key) is an argument
 *  or absent: the off/unconfigured arms are reached by CALLING it with those classes. */
export function transition(
  prev: TypesafeHealth,
  cls: FailureClass,
  now: number,
  tuning: BreakerTuning = BREAKER_DEFAULTS,
  status?: number,
): TypesafeHealth {
  const base: TypesafeHealth = {
    ...prev,
    last_class: cls,
    ...(status !== undefined ? { last_status: status } : {}),
  };
  if (cls === FAILURE_CLASS.NONE) {
    return {
      ...base,
      state: TYPESAFE_STATE.IDLE,
      fail_streak: 0,
      consecutive_trips: 0,
      cooldown_ms: tuning.cooldownBaseMs,
      opened_at: undefined,
      cooldown_until: undefined,
    };
  }
  if (cls === FAILURE_CLASS.DISABLED) {
    return { ...base, state: TYPESAFE_STATE.OFF, fail_streak: 0, consecutive_trips: 0 };
  }
  if (cls === FAILURE_CLASS.UNCONFIGURED) {
    return { ...base, state: TYPESAFE_STATE.UNCONFIGURED, fail_streak: 0, consecutive_trips: 0 };
  }
  if (cls === FAILURE_CLASS.ABORT || cls === FAILURE_CLASS.COOLDOWN) return base;
  const tripsNow = cls === FAILURE_CLASS.AUTH || cls === FAILURE_CLASS.BUDGET;
  const streak = prev.fail_streak + 1;
  if (!tripsNow && streak < tuning.failStreakLimit) return { ...base, fail_streak: streak };
  const consecutiveTrips = prev.consecutive_trips + 1;
  const cooldownMs = Math.min(
    tuning.cooldownCapMs,
    tuning.cooldownBaseMs * 2 ** (consecutiveTrips - 1),
  );
  return {
    ...base,
    state: TYPESAFE_STATE.OPEN,
    fail_streak: streak,
    consecutive_trips: consecutiveTrips,
    cooldown_ms: cooldownMs,
    opened_at: new Date(now).toISOString(),
    cooldown_until: new Date(now + cooldownMs).toISOString(),
  };
}

/** See the ALLOW TABLE in the header: one `half-open` probe per cooldown, refusals stamped
 *  through `transition`. */
export function allowCall(
  h: TypesafeHealth,
  now: number,
): { allow: boolean; next: TypesafeHealth } {
  if (h.state === TYPESAFE_STATE.HALF_OPEN) {
    return { allow: false, next: transition(h, FAILURE_CLASS.COOLDOWN, now) };
  }
  if (h.state === TYPESAFE_STATE.OPEN) {
    const until = h.cooldown_until === undefined ? undefined : Date.parse(h.cooldown_until);
    if (until !== undefined && now < until) {
      return { allow: false, next: transition(h, FAILURE_CLASS.COOLDOWN, now) };
    }
    return {
      allow: true,
      next: { ...h, state: TYPESAFE_STATE.HALF_OPEN, cooldown_until: undefined },
    };
  }
  return { allow: true, next: h };
}

/** The per-RUN call budget's storage. Module scope is the point: `vf hook` is a fresh process
 *  per tool call, while the orchestrator's reviewer/goalCoverage/planner calls share one. */
let callsThisRun = 0;
export function callsUsedThisRun(): number {
  return callsThisRun;
}
export function resetCallBudget(): void {
  callsThisRun = 0;
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
  const tuning = inject.tuning ?? BREAKER_DEFAULTS;
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
    next.calls = callsUsedThisRun();
    line = transitionLine(fresh, next, cls);
    return { next, result: next.state !== fresh.state };
  }, inject);
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
  const maxCalls = inject.tuning?.maxCalls ?? BREAKER_DEFAULTS.maxCalls;
  if (callsThisRun >= maxCalls) return null;
  callsThisRun += 1;
  const allow = await mutateHealth((h) => {
    const r = allowCall(h, now);
    return { next: r.next, result: r.allow };
  }, inject);
  // `undefined` (the lock was lost) is treated as ALLOW: a breaker that cannot be read must
  // not block a run, and a dropped record can only lose an increment.
  if (allow === false) return null;
  try {
    const value = await fn();
    const signal = inject.outcome?.();
    await record(caller, signal?.cls ?? FAILURE_CLASS.NONE, signal?.status, now, inject);
    return value;
  } catch (err) {
    await record(
      caller,
      classifyThrown(err, inject.signal?.aborted ?? false),
      undefined,
      now,
      inject,
    );
    return null;
  }
}
