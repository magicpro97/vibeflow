// src/update-check.ts
//
// Update notifier: tell the user when a newer VibeFlow is on npm.
//
// Two surfaces:
//   (A) `vf update-check`  — explicit, always fetches live, reports + caches.
//   (B) notifyUpdate()     — passive 1-line nudge printed on any command. The
//                             nudge itself is instant (read from a 24h cache, no
//                             await). When the cache is stale it kicks a
//                             fire-and-forget refresh; that un-awaited fetch is
//                             NOT detached, so on the ~once-a-day stale run the
//                             process can stay alive until the fetch settles
//                             (≤ FETCH_TIMEOUT_MS, longer under Node if the
//                             socket lingers). The command's OUTPUT is never
//                             delayed — only process exit, once a day, and only
//                             in an interactive TTY. A detached/unref'd refresh
//                             would remove even that; skipped as over-engineering
//                             for a best-effort nudge (ponytail).
//
// Design notes (ponytail):
//   - No `update-notifier`/`semver` dep — a 6-line compare + a `fetch` call to
//     the npm registry cover it. `fetch` + `AbortSignal.timeout` are stdlib on
//     node>=18 (package.json engines).
//   - Cache lives in ~/.vibeflow/ next to projects.json (registry.ts convention).
//   - Every I/O boundary (fetch, fs, clock, env, TTY, sink) is injectable so the
//     module hits 100% line coverage under bun:test without touching the network
//     or the real home dir.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION, c, writeFileSafe } from "./core.js";
import { out } from "./logbus.js";
import type { Channel } from "./logbus.js";

const PKG = "@magicpro97/vibeflow";
const CACHE_PATH = join(homedir(), ".vibeflow", "update-check.json");
const TTL_MS = 24 * 60 * 60 * 1000; // one passive network refresh per day
const FETCH_TIMEOUT_MS = 2000; // never make the CLI wait on a slow registry

/** Sink shape (mirrors state.ts OutFn) so callers can capture output in tests. */
type OutFn = (channel: Channel, ...parts: unknown[]) => void;

/** The narrow slice of `fetch` we depend on. Declaring it here (instead of
 *  `typeof fetch`) keeps test stubs from having to implement `preconnect` etc. */
type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface UpdateCache {
  checkedAt: number;
  latest: string;
}

/** Accept only a plain dotted-numeric version, optionally with a
 *  prerelease/build suffix (`1.2.3`, `1.2.3-rc.1`, `1.2.3+build`). This is the
 *  trust gate on the version string BEFORE it is cached or printed: the npm
 *  registry response (and the on-disk cache) are untrusted, and the string is
 *  rendered straight to the terminal — a value carrying ANSI/control chars
 *  would inject terminal escapes. `cmpSemver` already coerces to numbers so
 *  comparison is safe; this closes the DISPLAY vector. */
export function isValidVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+([-+][\w.]+)*$/.test(v);
}

/** Compare two semver-ish strings: 1 if a>b, -1 if a<b, 0 if equal.
 *  Only the numeric MAJOR.MINOR.PATCH is compared (prerelease/build after the
 *  first `-`/`+` is ignored) — enough to answer "is a newer release out?".
 *  By design a prerelease compares EQUAL to its release (`1.0.0-rc.1` == `1.0.0`);
 *  npm `/latest` points at a stable tag so this is the right scope for a nudge.
 *  Non-numeric segments coerce to 0. */
export function cmpSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    (v.split(/[-+]/)[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Fetch the latest published version from the npm registry. Best-effort:
 *  any network error, non-2xx, malformed, or non-semver body yields `null`
 *  (never throws). */
export async function fetchLatest(inject: { fetch?: FetchFn } = {}): Promise<string | null> {
  const _fetch: FetchFn = inject.fetch ?? (fetch as unknown as FetchFn);
  try {
    const res = await _fetch(`https://registry.npmjs.org/${PKG}/latest`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" && isValidVersion(data.version) ? data.version : null;
  } catch {
    return null;
  }
}

/** Read the cache. `null` when absent, unreadable, malformed, or carrying a
 *  non-semver `latest` (a hand-edited / poisoned cache must not reach the
 *  terminal — same trust gate as `fetchLatest`, applied on the read side). */
export function readCache(
  inject: { readFileSync?: (p: string, e: string) => string } = {},
): UpdateCache | null {
  const _read = inject.readFileSync ?? readFileSync;
  try {
    const data = JSON.parse(_read(CACHE_PATH, "utf8")) as UpdateCache;
    if (
      typeof data.checkedAt === "number" &&
      typeof data.latest === "string" &&
      isValidVersion(data.latest)
    ) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/** Write the cache atomically. Best-effort — never breaks the caller. */
export function writeCache(
  cache: UpdateCache,
  inject: { writeFileSafe?: typeof writeFileSafe } = {},
): void {
  try {
    (inject.writeFileSafe ?? writeFileSafe)(CACHE_PATH, JSON.stringify(cache));
  } catch {
    /* best-effort */
  }
}

/** `vf update-check` — force a live check, report, and refresh the cache.
 *  Returns 0 on a successful check (up-to-date OR update-available), 1 when the
 *  registry is unreachable. */
export async function updateCheck(
  inject: {
    fetch?: FetchFn;
    writeFileSafe?: typeof writeFileSafe;
    now?: () => number;
    current?: string;
    outFn?: OutFn;
  } = {},
): Promise<number> {
  const outFn = inject.outFn ?? out;
  const current = inject.current ?? VERSION;
  const latest = await fetchLatest(inject);
  if (latest === null) {
    outFn("vf", c.yellow("Could not reach the npm registry to check for updates."), {
      level: "warn",
    });
    return 1;
  }
  writeCache({ checkedAt: (inject.now ?? Date.now)(), latest }, inject);
  if (cmpSemver(latest, current) > 0) {
    outFn("vf", updateAvailableLine(current, latest));
  } else {
    outFn("vf", c.green(`VibeFlow v${current} is up to date.`));
  }
  return 0;
}

/** The one-line "update available" nudge, shared by the command and the banner. */
export function updateAvailableLine(current: string, latest: string): string {
  return `${c.yellow("Update available:")} ${c.dim(`v${current}`)} → ${c.green(
    `v${latest}`,
  )}  ·  run ${c.cyan(`npm i -g ${PKG}`)}`;
}

/** Is the passive check allowed to run? Off in CI, non-interactive shells, or
 *  when the user opts out via VIBEFLOW_NO_UPDATE_CHECK=1. */
export function updateCheckEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
  if (env.VIBEFLOW_NO_UPDATE_CHECK === "1") return false;
  if (env.CI) return false;
  if (!isTTY) return false;
  return true;
}

/** Background cache refresh: fetch latest, persist if we got one. Awaitable in
 *  tests; fire-and-forget in production. Never throws. */
export async function refreshCacheInBackground(
  inject: {
    fetch?: FetchFn;
    writeCache?: (cache: UpdateCache, inj?: { writeFileSafe?: typeof writeFileSafe }) => void;
    now?: () => number;
  } = {},
): Promise<void> {
  const latest = await fetchLatest(inject);
  if (latest === null) return;
  (inject.writeCache ?? writeCache)({ checkedAt: (inject.now ?? Date.now)(), latest });
}

/** Passive nudge: print "update available" from the cache (instant — no await),
 *  and kick a fire-and-forget refresh when the cache is missing or older than the
 *  TTL. The nudge never delays command OUTPUT; the un-awaited refresh can delay
 *  process EXIT by up to FETCH_TIMEOUT_MS on the once-a-day stale run (see the
 *  file header). Best-effort — never throws. */
export function notifyUpdate(
  inject: {
    env?: NodeJS.ProcessEnv;
    isTTY?: boolean;
    now?: () => number;
    current?: string;
    readCache?: () => UpdateCache | null;
    refresh?: () => void;
    outFn?: OutFn;
  } = {},
): void {
  if (!updateCheckEnabled(inject.env, inject.isTTY)) return;
  const outFn = inject.outFn ?? out;
  const current = inject.current ?? VERSION;
  const now = (inject.now ?? Date.now)();
  const cache = (inject.readCache ?? readCache)();
  if (cache && cmpSemver(cache.latest, current) > 0) {
    outFn("vf", updateAvailableLine(current, cache.latest));
  }
  if (!cache || now - cache.checkedAt > TTL_MS) {
    (inject.refresh ?? (() => void refreshCacheInBackground()))();
  }
}
