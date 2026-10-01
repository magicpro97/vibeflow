// src/typesafe-breaker.ts
//
// The PURE state machine of the file-backed System One circuit breaker: no fs, no clock, no
// settings module. Every external dependency (clock instant, tuning, failure class) is an
// argument, so the transition table is testable in isolation and the guard in
// src/typesafe-health.ts is the only thing that touches disk.
//
// Extracted from src/typesafe-health.ts when the round-43 fixes pushed that file past the
// 400-line cap. `src/typesafe-health.ts` re-exports every symbol below, so call sites and tests
// keep importing from ONE module.
//
// THE TABLES (kept here, next to the code that implements them):
//
// TRANSITION TABLE (`transition`):
//   none -> idle (streak 0, trips 0, cooldown reset to base); disabled -> off; unconfigured ->
//   unconfigured (both with streak 0, trips 0); abort + cooldown -> UNCHANGED and
//   streak-neutral (a slow region must not park the breaker, a refusal must never trip it);
//   auth + budget -> open on the FIRST hit (retrying a bad key or a rate limit burns the clock);
//   network + server + schema + malformed -> streak + 1, open at `failStreakLimit`, with
//   cooldown = min(cap, base * 2 ** (consecutive_trips - 1)).
//
//   The two streak-neutral classes DO restamp `last_class` (via `base`), because the coverage
//   gate needs the `cls === COOLDOWN` arm reachable and `last_class` is the record's "last
//   transition" field. `last_status` survives, so a diagnosis is not lost - what a refusal
//   changes is the class of the LATEST event, not the state, streak, or deadline.
//
// ALLOW TABLE (`allowCall`): idle/off/unconfigured allow; open inside the cooldown refuses
// (deadline INCLUSIVE - at exactly `cooldown_until` ONE probe is granted and the record flips to
// half-open); half-open holds a PROBE LEASE measured from `opened_at` - a concurrent caller
// inside the lease short-circuits to null, and an expired lease grants the next probe. BOTH
// refusals stamp COOLDOWN through `transition`, whose COOLDOWN arm is streak-neutral, so the
// refusal contract and the streak ladder share one authority. An `open` record with NO deadline
// is ambiguous and is granted a probe too.
import {
  FAILURE_CLASS,
  type FailureClass,
  TYPESAFE_STATE,
  type TypesafeHealth,
} from "./typesafe-health-file.js";

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

/** See the ALLOW TABLE in the file header: one `half-open` probe per lease, refusals stamped
 *  through `transition`. */
export function allowCall(
  h: TypesafeHealth,
  now: number,
): { allow: boolean; next: TypesafeHealth } {
  if (h.state === TYPESAFE_STATE.HALF_OPEN) {
    // The probe LEASE. Half-open grants exactly ONE probe per `cooldown_ms` window, and the
    // window is measured from `opened_at` - the instant this state was entered. Without a
    // deadline here the state was absorbing: a probe whose outcome was streak-neutral (`abort`,
    // `cooldown`) left the record half-open with no deadline, and the unconditional refusal held
    // it there FOREVER - one slow network (a hook timeout is 1500 ms) disabled the judge for every
    // later call until a manual `reset` or a key rotation. A lease that expires re-grants, which
    // is what keeps "exactly one probe at a time" a property rather than a permanent sentence. A
    // hostile record with no parseable `opened_at` is granted a probe too: the breaker must fail
    // OPEN when it cannot be read.
    const opened = h.opened_at === undefined ? Number.NaN : Date.parse(h.opened_at);
    if (Number.isFinite(opened) && now - opened < h.cooldown_ms) {
      return { allow: false, next: transition(h, FAILURE_CLASS.COOLDOWN, now) };
    }
    return { allow: true, next: { ...h, opened_at: new Date(now).toISOString() } };
  }
  if (h.state === TYPESAFE_STATE.OPEN) {
    const until = h.cooldown_until === undefined ? undefined : Date.parse(h.cooldown_until);
    if (until !== undefined && now < until) {
      return { allow: false, next: transition(h, FAILURE_CLASS.COOLDOWN, now) };
    }
    return {
      allow: true,
      next: {
        ...h,
        state: TYPESAFE_STATE.HALF_OPEN,
        // The lease starts NOW: `opened_at` was the trip time, and a lease measured from the trip
        // would already be expired for a long cooldown, granting concurrent probes.
        opened_at: new Date(now).toISOString(),
        cooldown_until: undefined,
      },
    };
  }
  return { allow: true, next: h };
}
