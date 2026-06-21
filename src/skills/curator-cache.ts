import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, writeFileSafe } from "../core.js";

/**
 * Hash-based cache for the deterministic skill-curator output. Lets a
 * re-run of `vf init` on the same project skip the entire ctx7 install
 * + canonical-import + mirror-sync + prune pipeline when the inputs
 * (stack-evidence.md + project-profile.json) have not changed.
 *
 * The skill-curator alone accounts for ~2.4M tokens of the typical
 * `vf init` cost (3 ctx7 installs + 4 meta-skill imports + 6 phase-
 * skill enrichments in a single engine turn), so a cache hit on
 * re-init is the single biggest token saver in the workflow.
 *
 * The cache key is the SHA-256 of (stack-evidence + project-profile),
 * so the cache is automatically invalidated when either input changes
 * (e.g. a new dependency is added to the project). It is NOT
 * invalidated by .vibeflow/SKILL_INDEX.md changes — those are outputs
 * the curator itself produced.
 *
 * Cache file: `.vibeflow/cache/curator-<hash>.json`. Format:
 *   { "hash": "...", "at": "2026-06-19T...", "installed": [...], "unmatched": [...] }
 *
 * The hash is the cache's identity. The stored result is what
 * `curateSkillsFromEvidence` would have returned for that input.
 */

const CACHE_DIR = "cache";
const CACHE_PREFIX = "curator-";

export interface CurateCacheEntry {
  /** SHA-256 of the concatenated inputs. Acts as both key and identity. */
  hash: string;
  /** ISO-8601 timestamp the entry was written. Useful for staleness sweeps. */
  at: string;
  /** Skill names that were installed when this entry was produced. */
  installed: string[];
  /** Tech keywords that were unmatched by the whitelist at write time. */
  unmatched: string[];
  /** Schema version — bump when the entry shape changes. */
  version: 1;
}

function cachePath(base: string, hash: string): string {
  return join(base, CTX_DIR, CACHE_DIR, `${CACHE_PREFIX}${hash}.json`);
}

/**
 * Compute the deterministic cache key for a given set of inputs. The
 * key is the SHA-256 of the concatenated string. Two callers with the
 * same inputs (in the same order) always get the same key.
 */
export function curatorCacheKey(parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  h.update("\u0000");
  return h.digest("hex");
}

/** Compute the cache key from the actual on-disk curator inputs. */
export function curatorCacheKeyForProject(base: string): string | undefined {
  const stackPath = join(base, CTX_DIR, "ai-context", "stack-evidence.md");
  const profilePath = join(base, CTX_DIR, "ai-context", "project-profile.json");
  if (!existsSync(stackPath) || !existsSync(profilePath)) return undefined;
  const stack = readFileSync(stackPath, "utf8");
  const profile = readFileSync(profilePath, "utf8");
  return curatorCacheKey([stack, profile]);
}

/** Look up a cache entry by hash. Returns the entry, or undefined on miss. */
export function readCuratorCache(base: string, hash: string): CurateCacheEntry | undefined {
  const path = cachePath(base, hash);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    const entry = JSON.parse(text) as CurateCacheEntry;
    if (entry.version !== 1) return undefined;
    if (entry.hash !== hash) return undefined;
    return entry;
  } catch {
    return undefined;
  }
}

/** Persist a cache entry atomically. Best-effort — failures are logged
 *  to stderr and swallowed, never thrown (the caller must not let a
 *  cache write fail the rest of the pipeline). */
export function writeCuratorCache(
  base: string,
  hash: string,
  installed: string[],
  unmatched: string[],
): void {
  try {
    mkdirSync(join(base, CTX_DIR, CACHE_DIR), { recursive: true });
    const entry: CurateCacheEntry = {
      hash,
      at: new Date().toISOString(),
      installed,
      unmatched,
      version: 1,
    };
    writeFileSafe(cachePath(base, hash), JSON.stringify(entry, null, 2));
  } catch (err) {
    process.stderr.write(
      `[curator-cache] warning: could not write cache: ${(err as Error).message}\n`,
    );
  }
}

/** Prune cache entries older than `maxAgeMs` (default 7 days). The
 *  cache is small (one entry per unique input hash) and self-pruning
 *  on read is enough; this helper exists for explicit sweeps (e.g.
 *  `vf init --prune-cache`). */
export function pruneCuratorCache(base: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): number {
  const dir = join(base, CTX_DIR, CACHE_DIR);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(CACHE_PREFIX) || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.mtimeMs < cutoff) {
        unlinkSync(path);
        pruned++;
      }
    } catch {
      // best-effort
    }
  }
  return pruned;
}
