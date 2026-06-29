import { ENGINES, type Engine, hasCommand, resolveCommand, resolveEngineBinary } from "./core.js";
import { checkEngineAsync, runAttempts } from "./preflight/check-async.js";
import {
  GH_AUTH_TIMEOUT_MS,
  checkCopilotAuth,
  defaultSpawner,
  engineBinary,
  engineBinaryResolved,
  installHint,
  probeTimeoutMs,
  runProbeSafe,
} from "./preflight/probe.js";
import type { EngineReadiness, PreflightOpts, ReadinessLevel } from "./preflight/types.js";

// Re-export public types so the 14 importers see no change
export type {
  ReadinessLevel,
  EngineReadiness,
  ProbeSpawner,
  PreflightOpts,
} from "./preflight/types.js";

// Re-export moved functions for the original public surface
export { probeInvocation } from "./preflight/probe.js";
export { checkEngineAsync, runAttempts };

// ponytail: inlined from probe-cache.ts (#393)
const DEFAULT_TTL_MS = 60_000;
const SHORT_TTL_MS = 5_000;
type CacheClass = "stable" | "short";
interface CacheEntry {
  result: EngineReadiness;
  expiresAt: number;
}
export interface ProbeCacheOpts {
  ttlMs?: number;
  shortTtlMs?: number;
  now?: () => number;
}
export class ProbeCache {
  private map = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly shortTtlMs: number;
  private readonly now: () => number;
  constructor(opts: ProbeCacheOpts = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.shortTtlMs = opts.shortTtlMs ?? SHORT_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }
  private key(engine: string, repo: string, args: readonly string[]): string {
    return `${engine}|${repo}|${args.join("\u0001")}`;
  }
  get(
    engine: string,
    repo: string,
    args: readonly string[],
    at?: Date,
  ): EngineReadiness | undefined {
    const k = this.key(engine, repo, args);
    const entry = this.map.get(k);
    if (!entry) return undefined;
    const t = at ? at.getTime() : this.now();
    if (t >= entry.expiresAt) {
      this.map.delete(k);
      return undefined;
    }
    return entry.result;
  }
  set(
    engine: string,
    repo: string,
    args: readonly string[],
    result: EngineReadiness,
    at?: Date,
    class_: CacheClass = "stable",
  ): void {
    const t = at ? at.getTime() : this.now();
    this.map.set(this.key(engine, repo, args), {
      result,
      expiresAt: t + (class_ === "short" ? this.shortTtlMs : this.ttlMs),
    });
  }
  invalidate(engine: string): void {
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(`${engine}|`)) this.map.delete(k);
    }
  }
  invalidateAll(): void {
    this.map.clear();
  }
  size(): number {
    return this.map.size;
  }
}
let _sharedCache: ProbeCache | undefined;
export function getSharedCache(): ProbeCache {
  if (!_sharedCache) _sharedCache = new ProbeCache();
  return _sharedCache;
}
export function setSharedCache(c: ProbeCache | undefined): void {
  _sharedCache = c;
}
export function getCachedProbe(
  engine: string,
  repo: string,
  args: readonly string[],
): EngineReadiness | undefined {
  return getSharedCache().get(engine, repo, args);
}
export function setCachedProbe(
  engine: string,
  repo: string,
  args: readonly string[],
  result: EngineReadiness,
): void {
  const class_: CacheClass = result.level === "probe-failed" ? "short" : "stable";
  getSharedCache().set(engine, repo, args, result, undefined, class_);
}
export function invalidateProbe(engine: string): void {
  getSharedCache().invalidate(engine);
}
export function invalidateAllProbes(): void {
  getSharedCache().invalidateAll();
}

/**
 * Staged, short-circuiting readiness check: presence → auth → live probe. Each stage that fails
 * stops the chain with the most actionable level. Never throws — a misbehaving spawner is caught.
 */
export function checkEngine(engine: Engine, opts: PreflightOpts = {}): EngineReadiness {
  const has = opts.has ?? hasCommand;
  const spawner =
    opts.spawner ??
    ((cmd: string, args: string[], input: string) =>
      defaultSpawner(cmd, args, input, cmd === "gh" ? GH_AUTH_TIMEOUT_MS : probeTimeoutMs(engine)));
  const now = opts.now ?? (() => new Date().toISOString());
  const stamp = (level: ReadinessLevel, detail: string): EngineReadiness => ({
    engine,
    level,
    detail,
    checkedAt: now(),
  });

  // Cache lookup: short-circuit when fresh
  if (!opts.skipCache) {
    const cache = getSharedCache();
    const cacheRepo = opts.cacheKey ?? process.cwd();
    const hit = cache.get(engine, cacheRepo, [], undefined);
    if (hit) return hit;
  }

  const cmd = engineBinary(engine);
  const usesDefaultHas = opts.has === undefined;
  if (!has(cmd)) {
    const shimCheck = usesDefaultHas ? resolveEngineBinary(cmd) : undefined;
    if (shimCheck === undefined) {
      const r = stamp("no-binary", installHint(engine));
      writeToCache(engine, opts, r);
      return r;
    }
  }
  const effectiveCmd = engineBinaryResolved(engine);
  const resolvedCmd =
    opts.spawner !== undefined ? effectiveCmd : (resolveCommand(effectiveCmd) ?? effectiveCmd);

  if (engine === "copilot") {
    try {
      const auth = checkCopilotAuth(has, spawner, usesDefaultHas);
      const r = stamp(auth.level, auth.detail);
      writeToCache(engine, opts, r);
      return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const r = stamp("probe-failed", `${engine}: probe failed (${msg})`);
      writeToCache(engine, opts, r);
      return r;
    }
  }

  if (opts.probe === false) {
    const r = stamp("ready", `${engine}: installed (probe skipped)`);
    writeToCache(engine, opts, r);
    return r;
  }

  const probe = runProbeSafe(engine, (probeCmd, args, input) =>
    spawner(probeCmd === cmd ? resolvedCmd : probeCmd, args, input),
  );
  const r = stamp(probe.level, probe.detail);
  writeToCache(engine, opts, r);
  return r;
}

function writeToCache(engine: Engine, opts: PreflightOpts, r: EngineReadiness): void {
  if (opts.skipCache) return;
  const repo = opts.cacheKey ?? process.cwd();
  setCachedProbe(engine, repo, [], r);
}

/** De-duplicated, ENGINES-validated subset of the requested engines, in canonical order. */
function normalizeEngines(engines: Engine[]): Engine[] {
  const requested = new Set(engines);
  return ENGINES.filter((e) => requested.has(e));
}

/** Check every (valid, deduped) engine. Synchronous to match doctor's simplicity. */
export function preflightAll(engines: Engine[], opts: PreflightOpts = {}): EngineReadiness[] {
  return normalizeEngines(engines).map((e) => checkEngine(e, opts));
}

/** Run all probes in parallel via the async path. Returns in ~max(probe) instead of sum(probes). */
export function preflightAllAsync(
  engines: Engine[],
  opts: PreflightOpts = {},
): Promise<EngineReadiness[]> {
  return Promise.all(normalizeEngines(engines).map((e) => checkEngineAsync(e, opts)));
}

/** True if at least one engine is fully ready (the gate the next agent uses to allow creation). */
export function anyReady(list: EngineReadiness[]): boolean {
  return list.some((r) => r.level === "ready");
}

/** The engines that are fully ready, in input order. */
export function readyEngines(list: EngineReadiness[]): Engine[] {
  return list.filter((r) => r.level === "ready").map((r) => r.engine);
}
