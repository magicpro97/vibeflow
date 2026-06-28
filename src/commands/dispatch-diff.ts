// src/commands/dispatch-diff.ts
//
// Diff reading + worktree isolation seam. Extracted from
// src/commands/dispatch-runtime.ts (issue #80) to keep both files under the
// 400-line file-size cap. Pure mechanical move — no logic change.

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { defaultWorktreePath, out } from "./_shared.js";

// ── Diff reader (inject seam) ──────────────────────────────────────────────────

/** Reads the git diff for a unit's scoped files. Inject seam for testing. */
export type DiffReader = (scope: readonly string[], cwd: string) => string;

/** Default: whole-tree changed-file list (git diff HEAD --name-only). Returns empty string on
 *  error or empty scope. Diffs the WHOLE tree (not scope-filtered) so analyzeDiff can attribute
 *  out-of-scope writes — a scope pathspec would hide the very files the scope-creep check needs (#359). */
export function defaultDiffReader(scope: readonly string[], cwd: string): string {
  if (scope.length === 0) return "";
  try {
    // ponytail: use spawnSync with array args to avoid shell injection
    const r = spawnSync("git", ["diff", "HEAD", "--name-only"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    return r.stdout ?? "";
  } catch {
    return "";
  }
}

interface DiffAnalysis {
  fail: boolean;
  reason: string;
}

const UNSAFE_PATTERNS = [
  /eval\s*\(/,
  /rm\s+-rf/,
  /process\.env\.\w+\s*=/, // writing to env (not reading)
  /\bpassword\b|\bsecret\b|\btoken\b/i,
];

export function analyzeDiff(diff: string, scope: readonly string[]): DiffAnalysis {
  if (!diff) return { fail: false, reason: "" };

  // ponytail: accept BOTH the reader's --name-only output (one bare path per line) and a full
  // unified diff (diff --git headers). A bare path line IS the changed file; a diff --git header
  // names it via the a/ prefix. Diff-metadata lines (@@, +, -, index, ---/+++) are not paths.
  const changedFiles = diff
    .split("\n")
    .map((l) => {
      const header = l.match(/^diff --git a\/(.+?) b\//);
      if (header?.[1]) return header[1];
      if (/^[@+\- ]|^index |^diff /.test(l)) return "";
      return l.trim();
    })
    .filter((f): f is string => !!f);

  // Scope creep: files outside unit scope changed
  // ponytail: file is in-scope if it IS the scope entry or is under that directory.
  // Strip trailing slash so a scope of "src/a/" matches "src/a/x.ts" (no `src/a//` mismatch).
  const outOfScope = changedFiles.filter(
    (f) =>
      !scope.some((raw) => {
        const s = raw.replace(/\/+$/, "");
        return f === s || f.startsWith(`${s}/`) || s.startsWith(`${f}/`);
      }),
  );
  if (outOfScope.length > 0) {
    return { fail: true, reason: `scope creep: ${outOfScope.join(", ")} outside unit scope` };
  }

  // Unsafe edits: check added lines for dangerous patterns
  const addedLines = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  for (const line of addedLines) {
    for (const pat of UNSAFE_PATTERNS) {
      if (pat.test(line)) {
        return { fail: true, reason: `unsafe edit detected: ${pat.source} in added line` };
      }
    }
  }

  return { fail: false, reason: "" };
}

export interface WorktreeOps {
  /** Create a worktree for `branch` off `base` (git ref), return absolute path. */
  create: (branch: string, base: string) => string;
  /** Remove the worktree at `path` (best-effort; never throws). */
  remove: (path: string) => void;
}

/** Build a WorktreeOps backed by `spawn` (defaults to the real spawnSync).
 *  The injectable `spawn` seam lets tests exercise create/remove without
 *  touching real git — pass a fake that returns the desired status/throw. */
export function makeWorktreeOps(spawn: typeof spawnSync = spawnSync): WorktreeOps {
  return {
    create(branch, base) {
      const parentDir = resolve(process.cwd(), "..");
      const wtPath = defaultWorktreePath(branch, parentDir);
      const scriptPath = join(process.cwd(), "scripts", "create-worktree.sh");
      const r = spawn(scriptPath, [branch, wtPath, "--base", base], {
        encoding: "utf8",
        timeout: 60_000,
      });
      if (r.status !== 0) {
        const msg = r.stderr?.toString().trim() || `exit ${r.status}`;
        throw new Error(`worktree create failed for ${branch}: ${msg}`);
      }
      return wtPath;
    },
    remove(path) {
      try {
        spawn("git", ["worktree", "remove", "--force", path], {
          encoding: "utf8",
          timeout: 30_000,
        });
      } catch (e) {
        // biome-ignore format: keep single-line for line-count cap
        out("engine-stderr", `[dispatch] worktree cleanup best-effort failed: ${(e as Error).message}`, { level: "debug" });
      }
    },
  };
}

/** Default WorktreeOps — shells out to scripts/create-worktree.sh for create
 *  and git worktree remove --force for cleanup. Errors are swallowed in remove. */
export const defaultWorktreeOps: WorktreeOps = makeWorktreeOps();
