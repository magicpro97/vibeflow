import type { Engine } from "../core.js";
import type { OwnedAiRouteRunner } from "../dispatch/owned-ai-route.js";

/**
 * Engine readiness levels (most-actionable first):
 *  - "ready"        engine is installed, authed (where checkable) and a live probe replied OK
 *  - "no-binary"    the engine CLI is not on PATH         → install it
 *  - "no-auth"      reserved for engines with a reliable standalone auth-status gate
 *  - "probe-failed" installed/authed but the live probe failed (nonzero, missing token, timeout)
 *                     codex uses `doctor`; copilot uses `gh auth status` instead of a prompt probe
 *  - "unknown"      we could not determine readiness (defensive; should be rare)
 */
export type ReadinessLevel = "ready" | "no-binary" | "no-auth" | "probe-failed" | "unknown";

export interface EngineReadiness {
  engine: Engine;
  level: ReadinessLevel;
  /** Human-readable status or a fix hint, e.g. "claude: probe OK" / "install the codex CLI". */
  detail: string;
  /** ISO timestamp; injected via opts.now so tests can pin a deterministic clock. */
  checkedAt: string;
}

/**
 * Injectable spawn seam — mirrors dispatch.ts's Spawner shape. The prompt is always passed via
 * argv or `input` (stdin) without shell interpolation. Tests inject a fake to avoid launching a
 * real engine.
 */
export interface ProbeResult {
  status: number;
  stdout: string;
  stderr?: string;
  code?: string;
}

export type ProbeSpawner = (cmd: string, args: string[], input: string) => ProbeResult;

export interface PreflightOpts {
  /** PATH-presence check (defaults to core.hasCommand). */
  has?: (cmd: string) => boolean;
  /** Process launcher (defaults to a bounded spawnSync). */
  spawner?: ProbeSpawner;
  /** Clock for checkedAt (defaults to wall-clock ISO). */
  now?: () => string;
  /** When false, stop after presencia/auth and skip the live probe (fast path). Default true. */
  probe?: boolean;
  /** Skip cache lookup AND skip cache write. Used by `vf doctor --refresh`. */
  skipCache?: boolean;
  /** Base dir for the cache key (defaults to process.cwd()). */
  cacheKey?: string;
  /** Override the per-probe timeout (test seam, line 380). Production: undefined. */
  probeTimeoutMs?: number;
  /** Canonical owned-process AI route seam for live round-trip probes. */
  ownedRoute?: OwnedAiRouteRunner;
}
