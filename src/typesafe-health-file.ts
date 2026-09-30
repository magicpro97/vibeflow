// src/typesafe-health-file.ts — the health RECORD and the disk that holds it.
//
// It owns the breaker vocabulary (one frozen `as const` authority per closed set), the record
// shape and its total guard, the path, the fail-open read, the cross-process lock and the
// budgeted atomic write. src/typesafe-health.ts owns the state MACHINE and the guard and
// re-exports the symbols below, so the dependency runs ONE way and this file never imports the
// breaker (not even for types).
//
// Every failure here is swallowed. The health file is an audit trail, never a gate: an
// unreadable, hostile or unwriteable file must degrade to "idle", never to an error.
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { writeFileSafe } from "./core.js";
import { DEFAULTS } from "./logbus/types.js";
/** The five breaker states — ONE frozen authority, the type inferred from it. */
export const TYPESAFE_STATE = Object.freeze({
  OFF: "off",
  UNCONFIGURED: "unconfigured",
  IDLE: "idle",
  OPEN: "open",
  HALF_OPEN: "half-open",
} as const);
export type TypesafeState = (typeof TYPESAFE_STATE)[keyof typeof TYPESAFE_STATE];

/** Every failure class a caller can report. No `internal`: the bounded attempt loop returns on
 *  each reachable path, so a member for a post-retry "impossible" state would be uncoverable. */
export const FAILURE_CLASS = Object.freeze({
  NONE: "none",
  DISABLED: "disabled",
  UNCONFIGURED: "unconfigured",
  COOLDOWN: "cooldown",
  ABORT: "abort",
  NETWORK: "network",
  AUTH: "auth",
  BUDGET: "budget",
  SCHEMA: "schema",
  SERVER: "server",
  MALFORMED: "malformed",
} as const);
export type FailureClass = (typeof FAILURE_CLASS)[keyof typeof FAILURE_CLASS];
export const FAILURE_CLASSES = Object.freeze(Object.values(FAILURE_CLASS));
export const isFailureClass = (v: unknown): v is FailureClass =>
  typeof v === "string" && (FAILURE_CLASSES as readonly string[]).includes(v);

/** Total guard over the five states, so a partial record can never be returned. */
export const isTypesafeState = (v: unknown): v is TypesafeState =>
  typeof v === "string" && (Object.values(TYPESAFE_STATE) as readonly string[]).includes(v);

export interface TypesafeHealth {
  schema_version: 1;
  state: TypesafeState;
  fail_streak: number;
  consecutive_trips: number;
  cooldown_ms: number;
  opened_at?: string;
  cooldown_until?: string;
  calls?: number;
  last_class: FailureClass;
  last_status?: number;
  last_call?: { at: string; caller: string; status?: number; ms: number };
}

/** The injection seam every health function takes. `lockWaitMs` bounds the LOCK wait and
 *  `writeBudgetMs` reserves the WRITE leg (§ Hook budget arithmetic) — the hook path passes `0`
 *  and `HOOK_HEALTH_WRITE_BUDGET_MS`, so a lost `last_call` line can never cost a tool call; a
 *  caller with no spawn budget (the CLI) omits both and keeps the repo policy. */
export interface HealthFileIo {
  userRoot?: string;
  /** The record's file name under the root. Defaults to the enforcement record; the operator probe
   *  passes its own, so a probe can never open the circuit the hook/verify/review calls depend on. */
  healthFile?: string;
  lockWaitMs?: number;
  writeBudgetMs?: number;
  readFile?: (p: string) => string;
  writeFile?: (p: string, s: string) => void;
  lock?: (p: string, fn: () => void | Promise<void>) => Promise<void>;
}
/** `HealthFileIo` plus the clock seam the write budget reads. */
export type HealthFileClockIo = HealthFileIo & {
  now?: () => number;
  /** The instant this leg began, so `writeBudgetMs` can bound whether a write STARTS. Without it the
   *  budget has nothing to measure against. */
  startedAt?: number;
};

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const optional = (v: unknown, guard: (x: unknown) => boolean): boolean =>
  v === undefined || guard(v);

/** The record guard — the only thing between a hostile file and the breaker. Every field is
 *  validated, so `{ schema_version: 1, state: "open" }` is rejected WHOLE rather than merged and
 *  later stringified into `NaN` counters. */
export function isTypesafeHealth(v: unknown): v is TypesafeHealth {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const h = v as Record<string, unknown>;
  if (h.schema_version !== 1 || !isTypesafeState(h.state)) return false;
  if (!isCount(h.fail_streak) || !isCount(h.consecutive_trips) || !isCount(h.cooldown_ms))
    return false;
  if (!isFailureClass(h.last_class)) return false;
  if (!optional(h.opened_at, (x) => typeof x === "string")) return false;
  if (!optional(h.cooldown_until, (x) => typeof x === "string")) return false;
  if (!optional(h.last_status, isCount) || !optional(h.calls, isCount)) return false;
  const call = h.last_call;
  if (call === undefined) return true;
  if (!call || typeof call !== "object" || Array.isArray(call)) return false;
  const c = call as Record<string, unknown>;
  return (
    typeof c.at === "string" &&
    typeof c.caller === "string" &&
    isCount(c.ms) &&
    optional(c.status, isCount)
  );
}

/** The `idle` default every recovery path lands on. `cooldownBaseMs` is passed in because the
 *  tuning defaults belong to the machine, not to the file. */
export const idleHealth = (cooldownBaseMs: number): TypesafeHealth => ({
  schema_version: 1,
  state: TYPESAFE_STATE.IDLE,
  fail_streak: 0,
  consecutive_trips: 0,
  cooldown_ms: cooldownBaseMs,
  last_class: FAILURE_CLASS.NONE,
});

/** How the record is serialised and validated: garbage, a wrong `schema_version` and a partial
 *  record all decode to the idle default, so a read never throws and never returns a partial. */
export const healthCodec = (cooldownBaseMs: number): HealthCodec<TypesafeHealth> => ({
  encode: (h) => JSON.stringify(h, null, 2),
  decode: (raw) => {
    if (raw === undefined) return idleHealth(cooldownBaseMs);
    const parsed: unknown = JSON.parse(raw);
    return isTypesafeHealth(parsed) ? parsed : idleHealth(cooldownBaseMs);
  },
});

/** How the caller serialises and validates its record. `decode` returns the caller's own
 *  fail-open default for garbage, so this layer never needs to know the shape. */
export interface HealthCodec<T> {
  encode(value: T): string;
  /** `raw` is undefined when no usable file exists (absent, a directory, a symlink,
   *  unreadable, garbage, or rejected by the caller's own record guard). */
  decode(raw: string | undefined): T;
}

/** `~/.vibeflow/typesafe-health.json` — the per-user root `vf init` uses, never the repo and
 *  never a git-tracked path. An injected `userRoot` IS that directory. */
/** The enforcement record: the one every hook/verify/review call reads. */
export const ENFORCEMENT_HEALTH_FILE = "typesafe-health.json";

export function healthPath(userRoot?: string, healthFile = ENFORCEMENT_HEALTH_FILE): string {
  const dir = userRoot ?? process.env.VF_USER_VIBEFLOW_ROOT ?? join(homedir(), ".vibeflow");
  return join(dir, healthFile);
}

/** Fail-open read: absent, garbage, hostile or unreadable all fall back to the codec's
 *  default. Never throws. `lstat` (not `stat`) so a symlink planted at the path is rejected
 *  rather than followed out of `~/.vibeflow`. */
export function readHealthFile<T>(io: HealthFileClockIo, codec: HealthCodec<T>): T {
  const path = healthPath(io.userRoot, io.healthFile);
  try {
    if (io.readFile) return codec.decode(io.readFile(path));
    if (!lstatSync(path).isFile()) return codec.decode(undefined);
    return codec.decode(readFileSync(path, "utf8"));
  } catch {
    return codec.decode(undefined);
  }
}

/** The unlocked primitive: ONE `writeFileSafe` (temp file + atomic rename). An exhausted
 *  `writeBudgetMs` reservation DROPS the record instead of adding a write to a path that is
 *  already out of budget. */
function writeUnlocked<T>(io: HealthFileClockIo, codec: HealthCodec<T>, value: T): void {
  const clock = io.now ?? Date.now;
  // A synchronous write cannot be preempted, so the only bound available is whether we START one:
  // `startedAt` is when the caller's health leg began, and a leg that has already spent its budget
  // writes nothing. Reading the clock twice HERE made the comparison vacuous - the two reads were
  // adjacent, so the difference was the cost of reading a clock, and `writeFileSafe` could still
  // block for as long as it liked.
  const since = io.startedAt ?? clock();
  if (io.writeBudgetMs !== undefined && clock() - since > io.writeBudgetMs) return;
  const path = healthPath(io.userRoot, io.healthFile);
  const payload = codec.encode(value);
  if (io.writeFile) io.writeFile(path, payload);
  else writeFileSafe(path, payload);
}

/** Best-effort lock: the repo's stale/retry policy, or the seam's `lockWaitMs` budget. Every
 *  failure (acquire, work, release) is swallowed. */
async function withLock(io: HealthFileClockIo, fn: () => void | Promise<void>): Promise<void> {
  const path = healthPath(io.userRoot, io.healthFile);
  const budgetMs = io.lockWaitMs ?? DEFAULTS.lockTimeoutMs;
  if (io.lock) {
    try {
      await io.lock(path, fn);
    } catch {
      /* swallowed */
    }
    return;
  }
  let release: (() => Promise<void>) | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    release = await lockfile.lock(path, {
      realpath: false,
      lockfilePath: `${path}.lock`,
      retries: {
        retries: Math.ceil(budgetMs / DEFAULTS.lockRetryMs),
        factor: 1,
        minTimeout: DEFAULTS.lockRetryMs,
        maxTimeout: DEFAULTS.lockRetryMs,
      },
      stale: 2_000,
    });
  } catch {
    return; // lock unavailable → skip rather than queue behind a concurrent writer
  }
  try {
    await fn();
  } catch {
    /* swallowed */
  } finally {
    try {
      await release();
    } catch {
      /* swallowed */
    }
  }
}

export async function writeHealthFile<T>(
  io: HealthFileClockIo,
  codec: HealthCodec<T>,
  value: T,
): Promise<void> {
  await withLock(io, () => writeUnlocked(io, codec, value));
}

/** The ONLY sanctioned read-modify-write: the lock is held across read + update + write, so a
 *  concurrent writer cannot lower a counter or clear a deadline. Resolves `undefined` when the
 *  lock could not be taken. */
export async function updateHealthFile<T, R>(
  io: HealthFileClockIo,
  codec: HealthCodec<T>,
  update: (current: T) => { next: T; result?: R },
): Promise<R | undefined> {
  let taken = false;
  let out: R | undefined;
  await withLock(io, () => {
    taken = true;
    const { next, result } = update(readHealthFile(io, codec));
    writeUnlocked(io, codec, next);
    out = result;
  });
  return taken ? out : undefined;
}

/** Which counter a call charges. Frozen runtime authority, the repo's convention for a closed
 *  vocabulary: the two buckets are NOT interchangeable, and the Spy/typesafe-ui panel writes one
 *  of them, so a bare string that drifts would silently re-merge them. */
export const TYPESAFE_BUDGET_BUCKET = Object.freeze({
  /** Hook, verify, review: the calls whose refusal is the judge losing its veto. */
  ENFORCEMENT: "enforcement",
  /** The operator-triggered "test connection" probe. */
  PROBE: "probe",
} as const);
export type TypesafeBudgetBucket =
  (typeof TYPESAFE_BUDGET_BUCKET)[keyof typeof TYPESAFE_BUDGET_BUCKET];

/**
 * Bucket -> record file, so the two buckets cannot share a breaker.
 *
 * They already had separate in-process counters; the RECORD was still shared, which meant two failed
 * probe requests (an invalid key answering `auth`, say) could open the circuit that the
 * hook/verify/review calls then refuse against for the whole cooldown. A caller holding only a page
 * token could therefore disable enforcement without spending a unit of the budget the counter split
 * was protecting.
 */
export const HEALTH_FILE_BY_BUCKET = Object.freeze({
  [TYPESAFE_BUDGET_BUCKET.ENFORCEMENT]: ENFORCEMENT_HEALTH_FILE,
  [TYPESAFE_BUDGET_BUCKET.PROBE]: "typesafe-health.probe.json",
} as const);

/** The operator probe's own record - what `vf config typesafe status` shows as a separate section. */
export const PROBE_HEALTH_FILE = HEALTH_FILE_BY_BUCKET[TYPESAFE_BUDGET_BUCKET.PROBE];

/** Guard-internal: which record a bucket's reads and writes go to. */
export const fileForBucket = (bucket: TypesafeBudgetBucket | undefined): string =>
  HEALTH_FILE_BY_BUCKET[bucket ?? TYPESAFE_BUDGET_BUCKET.ENFORCEMENT];
