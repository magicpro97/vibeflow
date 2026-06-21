import { execFileSync } from "node:child_process";
import { hasCommand } from "../core.js";

/**
 * P1-10: resolve a list of candidate "owner/name" GitHub repos
 * (the format `ctx7 skills install` expects) to the subset that
 * actually exists and is publicly fetchable. Uses the
 * authenticated `gh api repos/{owner}/{name}` call when available,
 * falls back to `git ls-remote` (works without `gh`).
 *
 * Why: when the engine specs `npx ctx7 skills install <repo>`, it
 * currently has no signal for which repo is valid. The
 * production-log failure mode (see issue #XX) is the engine trying
 * 4-5 candidate names sequentially, each burning a turn + tokens
 * on a `404 not found` response. Pre-resolving at the CLI side
 * gives the engine a small `verified_repos: [...]` list it can
 * consume directly, eliminating the try-fail loop.
 *
 * Constraints:
 *  - Pure CLI side; never runs from the engine.
 *  - Network-bound; respects the supplied timeout (default 5s).
 *  - Never throws on per-repo failure; returns the resolved subset
 *    plus a `notFound` list so the caller can still surface the
 *    misses to the user.
 *  - Injected `runner` seam for unit tests.
 */

const DEFAULT_TIMEOUT_MS = 5_000;
const GITHUB_API_TIMEOUT_MS = 4_000;

export interface ResolveOpts {
  /** Per-repo timeout (ms). Default 5000. */
  timeoutMs?: number;
  /** Injectable runner (test seam). Defaults to execFileSync('gh', ...). */
  runner?: (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string };
  /** When true, also accept private repos the gh token can see. */
  includePrivate?: boolean;
}

export interface ResolveResult {
  ok: boolean;
  /** Repos confirmed to exist (and accessible to the gh token). */
  found: string[];
  /** Repos that returned 404 / no remote / not accessible. */
  notFound: string[];
  /** True if `gh` is not installed / not authenticated. The caller
   *  should treat this as "skip resolve, let the engine try" and
   *  NOT block on the failure. */
  ghUnavailable: boolean;
  /** Why `gh` is unavailable (only set when ghUnavailable=true). */
  reason?: string;
}

function defaultRunner(
  cmd: string,
  args: string[],
  timeoutMs: number,
): { status: number; stdout: string; stderr: string } {
  try {
    const out = execFileSync(cmd, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: out, stderr: "" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      status: typeof e.status === "number" ? e.status : 1,
      stdout: typeof e.stdout === "string" ? e.stdout : e.stdout ? String(e.stdout) : "",
      stderr: typeof e.stderr === "string" ? e.stderr : e.stderr ? String(e.stderr) : "",
    };
  }
}

/** Validate the "owner/name" shape. The ctx7 install command
 *  expects a GitHub-style repo slug (lowercase, alnum + hyphens,
 *  one slash). Reject anything else early so the engine never
 *  sees a malformed input. */
function isRepoSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(s);
}

/**
 * Resolve a list of candidate repos to the subset that exists.
 * Never throws. Returns `{ ok: false, ghUnavailable: true, ... }`
 * if `gh` is not available; the caller should treat this as
 * "best-effort skip" and let the engine try the candidates.
 */
export function resolveCtx7Repos(candidates: string[], opts: ResolveOpts = {}): ResolveResult {
  // Dedupe + filter to valid slugs. Junk in the candidate list
  // (a trailing slash, a comma-separated list) gets dropped here
  // so the engine never sees a malformed argument.
  const clean = Array.from(new Set(candidates.map((c) => c.trim()).filter(isRepoSlug)));
  if (clean.length === 0) {
    return { ok: true, found: [], notFound: [], ghUnavailable: false };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = opts.runner
    ? opts.runner
    : (cmd: string, args: string[]) => defaultRunner(cmd, args, timeoutMs);

  // Step 1: check `gh` is available + authenticated. `gh api user`
  // returns 200 with the current user when authenticated, 401 when
  // not. A 404 here means `gh` is installed but the user is not
  // logged in (treat as "unavailable" — the engine should be told
  // to use ctx7 docs HTTP API instead).
  if (!hasCommand("gh")) {
    return {
      ok: false,
      found: [],
      notFound: clean,
      ghUnavailable: true,
      reason: "gh not on PATH",
    };
  }
  const authCheck = run("gh", ["auth", "status"]);
  if (authCheck.status !== 0) {
    return {
      ok: false,
      found: [],
      notFound: clean,
      ghUnavailable: true,
      reason: `gh auth status failed (exit ${authCheck.status}): ${authCheck.stderr.slice(0, 200)}`,
    };
  }

  // Step 2: probe each candidate. `gh api repos/{owner}/{name} -q .name`
  // returns the canonical name on 200, empty / error on 404. We do
  // these SEQUENTIALLY (not in parallel) to keep the gh process
  // pool small and to bound the total wall clock — the candidates
  // list is small (usually <10).
  const found: string[] = [];
  const notFound: string[] = [];
  for (const repo of clean) {
    const args = ["api", `repos/${repo}`, "-q", ".name"];
    if (opts.includePrivate) args.push("--include-private");
    const r = run("gh", args);
    if (r.status === 0 && r.stdout.trim().length > 0) {
      found.push(repo);
    } else {
      notFound.push(repo);
    }
  }

  return { ok: true, found, notFound, ghUnavailable: false };
}

/**
 * Format the resolved-repos hint for injection into an engine
 * spec. Returns "" when nothing was found (so the spec simply
 * omits the hint). When `gh` is unavailable, returns a "fallback"
 * hint that tells the engine to use ctx7 docs HTTP API directly.
 */
export function formatResolvedReposHint(result: ResolveResult): string {
  if (result.ghUnavailable) {
    return [
      "## ctx7 repo resolve — UNAVAILABLE",
      "`gh` is not installed or not authenticated. The verified-repos list",
      "below is EMPTY. Use `npx ctx7 docs <library>` (the HTTP-backed CLI)",
      "to look up libraries one at a time, OR fall back to writing a",
      "skill from project conventions only (status: experimental).",
    ].join("\n");
  }
  if (result.found.length === 0) {
    return [
      "## ctx7 repo resolve — NO VERIFIED REPOS",
      "None of the candidate repos returned a hit on the GitHub API.",
      "Do NOT call `npx ctx7 skills install <repo>` blindly. Either:",
      "  (a) try `npx ctx7 docs <library>` for a per-library lookup, OR",
      "  (b) write a project-conventions-only skill with status=experimental.",
    ].join("\n");
  }
  return [
    "## ctx7 repo resolve — VERIFIED (CLI pre-checked)",
    "The following repos are confirmed to exist (gh API 200):",
    ...result.found.map((r) => `  - ${r}`),
    ...(result.notFound.length > 0
      ? ["", "Skipped (404 or no remote):", ...result.notFound.map((r) => `  - ${r}`)]
      : []),
    "",
    "Use ONLY the verified repos in `npx ctx7 skills install <repo> <skill>`.",
  ].join("\n");
}
