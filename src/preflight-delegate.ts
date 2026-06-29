import type { Engine } from "./core.js";
import { ENGINES } from "./core.js";
import { type QuotaStatus, checkEngineQuota } from "./engine-quota.js";
import { type EngineReadiness, type ProbeCache, checkEngine, getSharedCache } from "./preflight.js";

export type DelegateLevel =
  | "ready"
  | "warning"
  | "exhausted"
  | "rate-limited"
  | "forbidden"
  | "not-logged-in";

export interface DelegateGate {
  allowed: boolean;
  level: DelegateLevel;
  detail: string;
  fallbackEngine?: Engine;
  quota?: QuotaStatus;
}

export interface PreflightDelegateOpts {
  cache?: ProbeCache;
  skipQuotaCheck?: boolean;
  /** Override the quota probe (test seam). */
  quotaProbe?: (engine: Engine) => Promise<QuotaStatus> | QuotaStatus;
  /** Override the engine check (test seam). */
  presenceCheck?: (engine: Engine) => EngineReadiness;
  /** Override the engine binary detector (test seam, line 110). */
  has?: (cmd: string) => boolean;
  /** Override the next-engine picker (test seam). */
  pickFallback?: (exclude: Engine) => Engine | undefined;
  /** Base dir for default presence check (test seam). */
  base?: string;
}

export async function preflightDelegate(
  base: string,
  engine: Engine,
  opts: PreflightDelegateOpts = {},
): Promise<DelegateGate> {
  // Layer 1: presence + auth
  const presence = opts.presenceCheck?.(engine) ?? defaultPresenceCheck(base, engine, opts);
  if (presence.level === "no-binary") {
    return { allowed: false, level: "exhausted", detail: presence.detail };
  }
  if (presence.level === "no-auth") {
    return { allowed: false, level: "not-logged-in", detail: presence.detail };
  }
  if (presence.level === "probe-failed" || presence.level === "unknown") {
    return { allowed: false, level: "exhausted", detail: presence.detail };
  }

  // Layer 2: quota probe
  if (opts.skipQuotaCheck) {
    return { allowed: true, level: "ready", detail: "quota check skipped" };
  }
  const quota: QuotaStatus = opts.quotaProbe ? await opts.quotaProbe(engine) : { level: "ready" };
  if (quota.level === "exhausted" || quota.level === "rate-limited") {
    const fallback = opts.pickFallback ? opts.pickFallback(engine) : defaultPickFallback(engine);
    if (fallback) {
      return {
        allowed: true,
        level: "ready",
        detail: `primary ${engine} ${quota.level}; falling back to ${fallback}`,
        fallbackEngine: fallback,
        quota,
      };
    }
    return {
      allowed: false,
      level: quota.level,
      detail: quota.error ?? "quota exhausted",
      quota,
    };
  }
  if (quota.level === "forbidden" || quota.level === "not-logged-in") {
    return {
      allowed: false,
      level: quota.level,
      detail: quota.error ?? "auth failed",
      quota,
    };
  }
  if (quota.level === "warning") {
    return {
      allowed: true,
      level: "warning",
      detail: quota.error ?? "quota low",
      quota,
    };
  }
  if (quota.level === "unknown") {
    return {
      allowed: true,
      level: "warning",
      detail: quota.error ?? "quota status unknown — proceeding with caution",
      quota,
    };
  }
  return { allowed: true, level: "ready", detail: "ready", quota };
}

// Test seams: exported so unit tests can exercise the default
// presencia/fallback paths. Both functions shell out to checkEngine
// (the real engine probe), so they are only unit-testable in env
// where the engines are absent (so has() returns false → no-binary).
// The `_opts.has` test seam lets us inject a fake `has` predicate.
export function defaultPresenceCheck(
  base: string,
  engine: Engine,
  opts: PreflightDelegateOpts,
): EngineReadiness {
  // Reuse the existing checkEngine from preflight. Presence is fast and the
  // existing function already does the right thing for known engines.
  // Skip spawner (we don't have one in the delegate context); this means we
  // only do presencia + (if copilot) auth, no live probe. The full live probe
  // happens in applyDispatch's runProbe path.
  const has = opts.has ?? ((cmd: string) => cmd !== "missing");
  return checkEngine(engine, { has });
}

export function defaultPickFallback(
  exclude: Engine,
  has?: (cmd: string) => boolean,
): Engine | undefined {
  const probe = has ?? ((cmd: string) => cmd !== "missing");
  for (const candidate of ENGINES) {
    if (candidate === exclude) continue;
    const r = checkEngine(candidate, { has: probe });
    if (r.level === "ready") return candidate;
  }
  return undefined;
}
