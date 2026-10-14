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

/** Per-file diff cap: longer output is sliced (never rejected); the UI notes the cut. */
export const DIFF_MAX_CHARS = 200_000;

export interface FilesGitDeps {
  runGit: (args: string[], cwd: string) => RunGitResult;
}

/**
 * A UI-sent path is unsafe when it is empty, option-looking, or escapes the repo.
 * Belt-and-braces with the argv's explicit `--`: an option-looking path must never
 * reach git even if a future call site drops the separator.
 */
function unsafePath(path: unknown): boolean {
  return (
    typeof path !== "string" || path.length === 0 || path.startsWith("-") || unsafeGitPath(path)
  );
}

/** Validate a UI-sent path list; null = reject the whole request (→ 400 upstream). */
export function validateGitPaths(paths: unknown): string[] | null {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > STAGE_BUTTON_CAP) {
    return null;
  }
  const safe: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || unsafePath(path)) return null;
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
function runMutation(
  prefix: string[],
  repo: string,
  paths: string[],
  deps: FilesGitDeps,
): Response {
  const result = deps.runGit([...prefix, "--", ...paths], repo);
  if (result.status !== 0) return Response.json({ ok: false, reason: failureReason(result) });
  return Response.json({ ok: true, changed: paths.length });
}

export function handleFilesStageRoute(repo: string, paths: string[], deps: FilesGitDeps): Response {
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

/**
 * GET /api/files/diff — read-only per-file diff for the Changes panel. `untracked`
 * is the client's group flag: an untracked file has no diff, so the route answers
 * immediately and the UI falls back to the content preview (flag is informational
 * only — no mutation, no extra bytes). A git failure (non-zero exit, or null on a
 * >64 MiB overflow) is not an HTTP error: 200 with { ok:false, reason } → the UI
 * shows "Diff unavailable for this file."
 */
export function handleFilesDiffRoute(
  repo: string,
  path: string,
  staged: boolean,
  untracked: boolean,
  deps: FilesGitDeps,
): Response {
  if (unsafePath(path)) return Response.json({ error: "invalid paths" }, { status: 400 });
  if (untracked) {
    return Response.json({
      ok: true,
      kind: "untracked",
      text: "",
      truncated: false,
      binary: false,
    });
  }
  const result = deps.runGit(
    staged ? ["diff", "--cached", "--no-color", "--", path] : ["diff", "--no-color", "--", path],
    repo,
  );
  if (result.status !== 0) return Response.json({ ok: false, reason: failureReason(result) });
  // git marks a binary pair with this marker instead of a patch body.
  if (result.stdout.includes("Binary files")) {
    return Response.json({ ok: true, kind: "diff", text: "", truncated: false, binary: true });
  }
  if (result.stdout.trim() === "") {
    return Response.json({ ok: true, kind: "empty", text: "", truncated: false, binary: false });
  }
  const truncated = result.stdout.length > DIFF_MAX_CHARS;
  return Response.json({
    ok: true,
    kind: "diff",
    text: truncated ? result.stdout.slice(0, DIFF_MAX_CHARS) : result.stdout,
    truncated,
    binary: false,
  });
}
