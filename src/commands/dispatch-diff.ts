// src/commands/dispatch-diff.ts
//
// Diff reading + worktree isolation seam. Extracted from
// src/commands/dispatch-runtime.ts (issue #80) to keep both files under the
// 400-line file-size cap. The extraction also carries the #359 scope-enforcement
// behaviour (whole-tree change list incl. untracked files) — NOT a pure move.

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { defaultWorktreePath, out } from "./_shared.js";

// ── Diff reader (inject seam) ──────────────────────────────────────────────────

/** Reads the set of changed files for scope enforcement. Inject seam for testing. */
export type DiffReader = (scope: readonly string[], cwd: string) => string;

/** Default: whole-tree changed-file list via `git status --porcelain`. Returns empty string on
 *  error or empty scope. Porcelain lists tracked modifications AND untracked new files (a unit
 *  creating a new out-of-scope file would be invisible to `git diff HEAD` — #359). Whole tree,
 *  not scope-filtered, so analyzeDiff can attribute out-of-scope writes. */
export function defaultDiffReader(scope: readonly string[], cwd: string): string {
  if (scope.length === 0) return "";
  try {
    // ponytail: spawnSync array args (no shell injection). --porcelain includes untracked (??).
    const r = spawnSync("git", ["status", "--porcelain"], {
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

export function analyzeDiff(diff: string, scope: readonly string[]): DiffAnalysis {
  if (!diff) return { fail: false, reason: "" };

  // ponytail: parse `git status --porcelain` lines. Each is `XY <path>` (XY = 2-char status,
  // e.g. ` M`, `??`, `A `). Strip the 3-char prefix when present; a bare path (test input) is
  // taken as-is. Rename lines `R  old -> new` keep the new path (after `-> `).
  const changedFiles = diff
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const body = /^[ MADRCU?!]{2} /.test(l) ? l.slice(3) : l.trim();
      const arrow = body.lastIndexOf(" -> ");
      return arrow >= 0 ? body.slice(arrow + 4) : body;
    });

  // Scope creep: files outside unit scope changed.
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

  // ponytail: content-safety (secrets/eval/rm-rf) is NOT checked here — that is the hook
  // PreToolUse boundary's job (#357 token-scan + risk.ts scoreCommand). This function owns
  // scope enforcement only. Add content checks here only if the hook boundary is bypassed.
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
