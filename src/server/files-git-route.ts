// src/server/files-git-route.ts
//
// POST /api/files/stage|unstage — the Changes panel's mutating endpoints.
// argv is exact and separator-guarded: `git add -- <paths>` / `git restore
// --staged -- <paths>`. The caller (server.ts) has ALREADY enforced guarded(req)
// — token + loopback + origin; validateGitPaths re-guards the path list (leading
// `-`, `..`, absolute, control chars, size cap) before anything reaches git.
// Git exit codes are NOT HTTP errors: a failed command still answers 200 with
// { ok: false, reason }. Sync + short-lived like the tree route; no previews.
import { unsafeGitPath } from "../core/file-tree-contract.js";
import type { RunGitResult } from "./files-tree-route.js";

/** Max paths per stage/unstage request; the UI chunks "Stage all" batches by this. */
export const STAGE_BUTTON_CAP = 500;

export interface FilesGitDeps {
  runGit: (args: string[], cwd: string) => RunGitResult;
}

/** Validate a UI-sent path list; null = reject the whole request (→ 400 upstream). */
export function validateGitPaths(paths: unknown): string[] | null {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > STAGE_BUTTON_CAP) {
    return null;
  }
  const safe: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) return null;
    // Belt-and-braces with the argv's explicit `--`: an option-looking path must
    // never reach git even if a future call site drops the separator.
    if (path.startsWith("-") || unsafeGitPath(path)) return null;
    safe.push(path);
  }
  return safe;
}

/** First stderr line as the failure reason; git's multiline noise never leaks. */
function failureReason(result: RunGitResult): string {
  const first = (result.stderr ?? "").split("\n")[0] ?? "";
  return first.trim() || "git command failed";
}

/** One mutating run; git's exit code re-surfaces as ok:false, never an HTTP error. */
function runMutation(prefix: string[], repo: string, paths: string[], deps: FilesGitDeps): Response {
  const result = deps.runGit([...prefix, "--", ...paths], repo);
  if (result.status !== 0) return Response.json({ ok: false, reason: failureReason(result) });
  return Response.json({ ok: true, changed: paths.length });
}

export function handleFilesStageRoute(
  repo: string,
  paths: string[],
  deps: FilesGitDeps,
): Response {
  return runMutation(["add"], repo, paths, deps);
}

/** `restore --staged` — index-only inverse; the worktree copy is never touched. */
export function handleFilesUnstageRoute(
  repo: string,
  paths: string[],
  deps: FilesGitDeps,
): Response {
  return runMutation(["restore", "--staged"], repo, paths, deps);
}
