import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
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
export function coerceTypesafeSettings(raw: unknown): TypesafeSettings | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const out: TypesafeSettings = {
    ...DEFAULT_TYPESAFE_SETTINGS,
    callSites: { ...DEFAULT_TYPESAFE_SETTINGS.callSites },
  };
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

/** The per-user `~/.vibeflow` root — the same root `vf init` resolves, so an injected
 *  `userRoot` is that DIRECTORY (a test injects a temp dir) and the `VF_USER_VIBEFLOW_ROOT`
 *  override wins when nothing is injected. */
function userVibeflowDir(userRoot?: string): string {
  return userRoot ?? process.env.VF_USER_VIBEFLOW_ROOT ?? join(homedir(), ".vibeflow");
}

/** `~/.vibeflow/typesafe.env` (the same per-user root `vf init` uses). */
export function typesafeEnvPath(userRoot?: string): string {
  return join(userVibeflowDir(userRoot), "typesafe.env");
}

export type TypesafeKeySource = { key: string; source: "env" | "file" } | null;

/**
 * Resolve the API key: `TYPESAFE_API_KEY` first, then `~/.vibeflow/typesafe.env`.
 * The file is parsed line-wise (`KEY=VALUE`, `#` comments) so a hand-edited file
 * cannot smuggle extra whitespace into the bearer token. Returns null when neither
 * source carries a non-empty key — callers treat that as "integration unavailable".
 */
export function resolveTypesafeKey(
  inject: {
    env?: NodeJS.ProcessEnv;
    userRoot?: string;
    readFile?: (p: string) => string;
  } = {},
): TypesafeKeySource {
  const env = inject.env ?? process.env;
  const fromEnv = env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  const path = typesafeEnvPath(inject.userRoot);
  const read = inject.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  if (!existsSync(path)) return null;
  try {
    for (const line of read(path).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      if (trimmed.slice(0, eq).trim() !== "TYPESAFE_API_KEY") continue;
      const value = trimmed.slice(eq + 1).trim();
      if (value) return { key: value, source: "file" };
    }
  } catch {
    /* unreadable file → treat as absent */
  }
  return null;
}

/**
 * Write the key to `~/.vibeflow/typesafe.env` as an owner-only file and return the path.
 *
 * `chmod 0600` is a no-op on Windows and `stat().mode` reports `0o666` there, so a mode-bit
 * assertion would pass there without checking anything. The durability layer already owns the
 * cross-platform answer, so this reuses it:
 *
 *   - `ensurePrivateDirectory` creates and verifies `~/.vibeflow` as owner-only on BOTH
 *     platforms (POSIX mode bits; a migrated owner-only DACL on Windows).
 *   - The key is staged with `O_CREAT | O_EXCL | O_NOFOLLOW` + `fchmodSync(fd, 0o600)`, fsynced,
 *     then renamed into place, so a pre-existing symlink or a concurrent writer cannot capture it.
 *   - `hasPrivateMode(stat, 0o777, 0o600, path, fd)` verifies the RESULT, bound to the descriptor
 *     it stat'ed so a leaf swapped in afterwards cannot answer in its name.
 *
 * A failure to reach owner-only privacy is a hard error, not a warning: continuing would store an
 * API key at a path this module calls protected.
 *
 * `inject.verifyPrivate` is the ONE seam: it lets a test drive the "not owner-only" refusal that
 * a POSIX `O_EXCL` + `fchmodSync(0o600)` write cannot produce by itself (it is a real refusal on
 * Windows, where the DACL migration can fail). Everything platform-specific stays inside
 * `hasPrivateMode`; nothing else about the write is injectable.
 */
export function writeTypesafeEnv(
  key: string,
  inject: { userRoot?: string; verifyPrivate?: (path: string, fd: number) => boolean } = {},
): string {
  const path = typesafeEnvPath(inject.userRoot);
  ensurePrivateDirectory(dirname(path));
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `TYPESAFE_API_KEY=${key}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    // A leaf that cannot be replaced (a directory, a foreign mount) must not leave the staged
    // key sitting in `~/.vibeflow` under a name no reader looks at.
    rmSync(temporary, { force: true });
    throw error;
  }
  const opened = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const verify =
      inject.verifyPrivate ??
      ((p: string, f: number) => hasPrivateMode(fstatSync(f), 0o777, 0o600, p, f));
    if (!verify(path, opened)) {
      // Never leave a key at a path this module calls protected, not even for the caller to read.
      rmSync(path, { force: true });
      throw new Error(`typesafe.env is not owner-only at ${path}`);
    }
  } finally {
    closeSync(opened);
  }
  return path;
}

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
  const typesafeCfg = "typesafe" in next ? coerceTypesafeSettings(next.typesafe) : current.typesafe;
  if (typesafeCfg) merged.typesafe = typesafeCfg;
}
