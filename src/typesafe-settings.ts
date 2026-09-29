import { randomBytes } from "node:crypto";
import {
  constants,
  type Stats,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// The cross-platform private-file authority. Windows has no POSIX mode bits, so `chmod 0600`
// is a no-op there and a mode-bit assertion passes without checking anything; these helpers ask
// the DACL instead and migrate inherited ACEs to owner-only.
import { ensurePrivateDirectory } from "./durability/path.js";
import { hasPrivateMode } from "./durability/posix-fs-semantics.js";
import type { VibeSettings } from "./settings.js";
// src/typesafe-settings.ts
//
// Optional TypeSafe "System One" (Jev) integration — settings + key resolution.
// Split out of src/settings.ts to stay under the 400-line cap and to keep the
// settings module free of filesystem/env policy. No dependency on src/typesafe.ts
// (the HTTP client) so the import graph stays acyclic.
import {
  TYPESAFE_CALL_SITE_NAMES,
  TYPESAFE_REVIEWER_ENGINE_POLICIES,
  type TypesafeCallSites,
  type TypesafeReviewerEnginePolicy,
} from "./typesafe-contract.js";

// The closed vocabularies are declared in src/typesafe-contract.ts (no runtime
// imports) so the web control center can import them without pulling this module's
// node:fs / bun:ffi graph into its type-check. Re-exported here so a Node caller
// keeps importing them from the one settings module it already imports.
export {
  TYPESAFE_CALL_SITE_NAMES,
  TYPESAFE_REVIEWER_ENGINE_POLICIES,
} from "./typesafe-contract.js";
export type {
  TypesafeCallSiteName,
  TypesafeCallSites,
  TypesafeReviewerEnginePolicy,
} from "./typesafe-contract.js";

/** The optional `.vibeflow/SETTINGS.json` block. NEVER carries the API key. */
export interface TypesafeSettings {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  retryBackoffMs: number;
  runAtConfidence: number;
  acceptAtConfidence: number;
  /** Judge scoring policy; every behavior-controlling grade number is user-tunable. */
  judgeScoreLevels: number;
  judgePassLevel: number;
  judgeTestFloor: number;
  /** Reviewer engine policy under per-unit routing. */
  reviewerEngine: TypesafeReviewerEnginePolicy;
  /** Breaker tuning — every number the design uses is a field, never a literal. */
  failStreakLimit: number;
  /** Per-PROCESS ceiling on judge CALLS - counted in guard ENTRIES, not in HTTP requests.
   *  The hard HTTP bound is `2 x maxCalls`, not `maxCalls`: the client retries once on
   *  `network`/`server`, so one budgeted entry can issue two requests. */
  maxCalls: number;
  cooldownBaseMs: number;
  cooldownCapMs: number;
  /** The hook call site's own ceiling; clamped to `min(HOOK_TIMEOUT_CAP_MS, timeoutMs)` by
   *  `coerceTypesafeSettings` so the pre-tool-call gate can never consume the host's
   *  hook spawn budget. */
  hookTimeoutMs: number;
  /** The audit leg's lock-retry budget on the hook path, forwarded to
   *  `installLogbus({ lockRetries })`. Clamped to `0..HOOK_BUS_LOCK_RETRIES_MAX`. */
  hookBusLockRetries: number;
  callSites: TypesafeCallSites;
}

export const DEFAULT_TYPESAFE_SETTINGS: TypesafeSettings = Object.freeze({
  enabled: false,
  model: "jev-latest",
  timeoutMs: 3000,
  retryBackoffMs: 250,
  runAtConfidence: 0.7,
  acceptAtConfidence: 0.85,
  judgeScoreLevels: 3,
  judgePassLevel: 2,
  judgeTestFloor: 0.5,
  reviewerEngine: "unit",
  failStreakLimit: 2,
  maxCalls: 20,
  cooldownBaseMs: 60_000,
  cooldownCapMs: 900_000,
  hookTimeoutMs: 1500,
  hookBusLockRetries: 0,
  callSites: { reviewer: true, risk: true, goalCoverage: true, planner: true },
});

/** The five seam-passed terms of the hook budget (§ Hook budget arithmetic), plus the
 *  1500 ms hard ceiling on the pre-tool-call judge budget. The host kills `vf hook` at
 *  10 s and reads the non-zero exit as a BLOCK, and `hook()` may spend 5 s of that
 *  draining stdin, so capping here keeps a judge timeout fail-OPEN. */
export const HOOK_TIMEOUT_CAP_MS = 1500;
export const HOOK_SPAWN_BUDGET_MS = 10_000;
export const HOOK_STDIN_BUDGET_MS = 5_000;
export const HOOK_HEALTH_WRITE_BUDGET_MS = 500;
export const HOOK_SAFETY_MARGIN_MS = 1_000;
export const HOOK_BUS_LOCK_RETRY_MS = 50;
/** Hard ceiling on the hook audit leg's lock-retry budget. DERIVED from the residual spawn
 *  budget, NOT copied from the repo-wide logbus policy:
 *  `floor((10_000 - 5_000 - 1_500 - 500 - 1_000) / (2 * 50))` = 20. The divisor is `2 *`
 *  because ONE audit event can acquire the lock TWICE (`writeLocked` -> `acquireLock` ->
 *  ENOENT -> `recoverAndRelock` -> `acquireLock`). The repo's `ceil(5000 / 50) = 100` MUST
 *  NOT be reused: at 100 the five-leg sum is 17 000 ms, past the host's 10 s budget. */
export const HOOK_BUS_LOCK_RETRIES_MAX = 20;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Coerce a stored block; absent/garbage yields undefined so the key stays out of SETTINGS.json. */
export function coerceTypesafeSettings(
  raw: unknown,
  /**
   * Block to take UNSENT fields from. The read path uses the shipped defaults; a write passes the
   * stored block, so a payload that names some fields updates those and leaves the rest alone —
   * the same semantics as every other settings block. Starting from the defaults instead made a
   * partial write a silent reset: `{"typesafe":{"model":"x"}}` turned `enabled` back off and
   * relaxed every tightened threshold and call-site toggle.
   */
  base: TypesafeSettings = DEFAULT_TYPESAFE_SETTINGS,
): TypesafeSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: TypesafeSettings = { ...base, callSites: { ...base.callSites } };
  if (typeof obj.enabled === "boolean") out.enabled = obj.enabled;
  if (typeof obj.model === "string" && obj.model.trim().length > 0) out.model = obj.model.trim();
  if (finite(obj.retryBackoffMs))
    out.retryBackoffMs = clamp(Math.round(obj.retryBackoffMs), 0, 10_000);
  if (finite(obj.runAtConfidence)) out.runAtConfidence = clamp(obj.runAtConfidence, 0, 1);
  if (finite(obj.acceptAtConfidence)) out.acceptAtConfidence = clamp(obj.acceptAtConfidence, 0, 1);
  if (finite(obj.judgeScoreLevels)) out.judgeScoreLevels = clamp(obj.judgeScoreLevels, 1, 10);
  if (finite(obj.judgePassLevel))
    out.judgePassLevel = clamp(obj.judgePassLevel, 0, out.judgeScoreLevels);
  if (finite(obj.judgeTestFloor)) out.judgeTestFloor = clamp(obj.judgeTestFloor, 0, 1);
  if (
    typeof obj.reviewerEngine === "string" &&
    (TYPESAFE_REVIEWER_ENGINE_POLICIES as readonly string[]).includes(obj.reviewerEngine)
  ) {
    out.reviewerEngine = obj.reviewerEngine as TypesafeReviewerEnginePolicy;
  }
  if (finite(obj.failStreakLimit))
    out.failStreakLimit = clamp(Math.round(obj.failStreakLimit), 1, 10);
  // Floor of 1: a 0 would silently disable every judge call while `enabled: true` reports
  // the feature as on.
  if (finite(obj.maxCalls)) out.maxCalls = clamp(Math.round(obj.maxCalls), 1, 100);
  if (finite(obj.cooldownBaseMs))
    out.cooldownBaseMs = clamp(Math.round(obj.cooldownBaseMs), 1000, 3_600_000);
  if (finite(obj.cooldownCapMs)) {
    out.cooldownCapMs = clamp(Math.round(obj.cooldownCapMs), out.cooldownBaseMs, 24 * 3_600_000);
  }
  // The session budget MUST be coerced BEFORE the hook clamp below, or `Math.min` compares the
  // hook budget against the DEFAULT constant (3000) instead of the user's effective timeout.
  if (finite(obj.timeoutMs)) out.timeoutMs = clamp(Math.round(obj.timeoutMs), 500, 10_000);
  if (finite(obj.hookTimeoutMs)) {
    out.hookTimeoutMs = clamp(Math.round(obj.hookTimeoutMs), 250, HOOK_TIMEOUT_CAP_MS);
  }
  // Two ceilings, both mandatory (§ Timeout budgets). `HOOK_TIMEOUT_CAP_MS` keeps the enabled
  // hook path far inside the spawn budget the host gives `vf hook`; `Math.min` with `timeoutMs`
  // additionally ensures a LOWERED session budget also lowers the gate, and that a RAISED one
  // can never unbound it.
  out.hookTimeoutMs = Math.min(out.hookTimeoutMs, HOOK_TIMEOUT_CAP_MS, out.timeoutMs);
  if (finite(obj.hookBusLockRetries)) {
    out.hookBusLockRetries = clamp(
      Math.round(obj.hookBusLockRetries),
      0,
      HOOK_BUS_LOCK_RETRIES_MAX,
    );
  }
  const sites = obj.callSites;
  if (sites && typeof sites === "object" && !Array.isArray(sites)) {
    const s = sites as Record<string, unknown>;
    for (const name of TYPESAFE_CALL_SITE_NAMES) {
      if (typeof s[name] === "boolean") out.callSites[name] = s[name];
    }
  }
  return out;
}

/** True when the user turned the integration on (key presence not required here). */
export function isTypesafeEnabled(settings: VibeSettings): boolean {
  return settings.typesafe?.enabled === true;
}

// The key file itself lives in `./typesafe-key-file.ts`: everything about its path, its
// symlink-refusing read and its stage-then-rename write.
import { resolveTypesafeKey } from "./typesafe-key-file.js";
export { resolveTypesafeKey, typesafeEnvPath, writeTypesafeEnv } from "./typesafe-key-file.js";
export type { TypesafeKeySource } from "./typesafe-key-file.js";

/** Enabled AND a key resolves — the gate every call site checks before any HTTP work. */
export function isTypesafeConfigured(
  settings: VibeSettings,
  inject: Parameters<typeof resolveTypesafeKey>[0] = {},
): boolean {
  return isTypesafeEnabled(settings) && resolveTypesafeKey(inject) !== null;
}

/** Read-path — materialize the block into `out` only when the stored raw coerces. */
export function applyTypesafeSettings(out: { typesafe?: TypesafeSettings }, raw: unknown): void {
  const settings = coerceTypesafeSettings(raw);
  if (settings) out.typesafe = settings;
}

/** Write-path — replace-on-write; keep the prior block when `next` omits it. */
export function mergeTypesafeSettings(
  merged: { typesafe?: TypesafeSettings },
  next: { typesafe?: TypesafeSettings },
  current: { typesafe?: TypesafeSettings },
): void {
  const typesafeCfg =
    "typesafe" in next
      ? coerceTypesafeSettings(next.typesafe, current.typesafe ?? DEFAULT_TYPESAFE_SETTINGS)
      : current.typesafe;
  if (typesafeCfg) merged.typesafe = typesafeCfg;
}

/**
 * Refuse a System One write that is malformed or does not name the repository it was read from.
 *
 * This block is replace-on-write on mere key PRESENCE (`mergeTypesafeSettings` above), so any
 * caller that posts a settings snapshot it took earlier silently overwrites the judge - enabled
 * flag, model, thresholds, call-site toggles - in whichever repo is active by then. The write
 * target is a process-global in the server, so "the settings the panel loaded" and "the settings
 * that get written" are not the same repo without this check.
 *
 * It is asserted from `writeSettings` rather than from a route because there are two routes into
 * disk: `/api/settings` and `/api/settings/apply`, the second reached through the policy preview in
 * `policy-route.ts`, which does not consult the first. `writeSettings` is the one place both pass
 * through, and the only place the target repo is known. Guarding routes makes the rule per-route.
 *
 * `expectRepo` is compared, never stored: `writeSettings` builds its result field by field.
 */
export function assertTypesafeWriteAllowed(
  base: string,
  next: { typesafe?: unknown; expectRepo?: string },
): void {
  if (!("typesafe" in next) || next.typesafe === undefined) return;
  // A value that is not a plain object is not a partial update. `null`, a string and an array all
  // coerce to `undefined`, which the merge reads as "no block" and DELETES the stored one - the
  // guardrail's configuration gone, reported as success. Omitting the key is the documented way to
  // leave the block alone.
  const block = next.typesafe;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new Error("a System One write must send a block object");
  }
  if (next.expectRepo !== base) {
    throw new Error("a System One write must name the repository it was read from");
  }
}
