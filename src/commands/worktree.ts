// src/commands/worktree.ts
//
// A6 of the orchestrator-first plan (issue #172): `vf worktree
// create|remove|list` — symlink node_modules, skip `bun install`.
//
// The shell side of A6 lives in `scripts/create-worktree.sh` (the
// ~100-LOC helper that does `git worktree add` + the symlink).
// This file is the thin TS wrapper that:
//   1. dispatches the right subcommand based on `args[0]`
//   2. shells out to `git` / the helper script via an injected
//      `runCommandSync` so the contract is testable in isolation
//      (same pattern as `vf review` — see ./review.ts)
//   3. prints the worktree path + a one-line `cd` hint on success
//   4. refuses to clobber an existing worktree (exit 2, never silent)
//
// === Command signatures (A6 spec) ===
//   vf worktree create <branch> [--base <base>]
//   vf worktree remove <branch>
//   vf worktree list
//
// === Exit codes ===
//   0  success
//   1  failure (helper script exited non-zero, or remove failed)
//   2  usage error (missing args, unknown sub-action, or clobber-refused)
//
// === Inject seam (test seam, like review.ts) ===
//   inject.runCommandSync — defaults to spawning `git` / the
//     helper script via node:child_process. Tests inject a stub
//     to verify the routing without touching the filesystem.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { c, cwd, out, spawnSync } from "./_shared.js";

/** The A6 sub-actions. */
export type WorktreeAction = "create" | "remove" | "list";

/** The result of a `runCommandSync` call. Mirrors child_process.SpawnSyncReturns
 *  with the fields the worktree code actually consumes. */
export interface RunCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** The inject seam. `runCommandSync` defaults to a real child_process
 *  spawn — tests pass a stub so they can verify the routing without
 *  touching the filesystem. */
export interface WorktreeInject {
  runCommandSync?: (
    cmd: string,
    args: readonly string[],
    opts?: { cwd?: string; encoding?: BufferEncoding },
  ) => RunCommandResult;
}

/** Default `runCommandSync` — delegates to node:child_process.spawnSync.
 *  We don't use the spawnSync export directly here (so the test seam
 *  has a stable signature) but we route through the real one. */
function defaultRunCommandSync(
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; encoding?: BufferEncoding } = {},
): RunCommandResult {
  // We pass the encoding so stdout/stderr come back as strings (the
  // real spawnSync types declare them as string | Buffer depending
  // on the encoding option).
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? cwd(),
    encoding: opts.encoding ?? "utf8",
  });
  return {
    status: r.status,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
    error: r.error,
  };
}

/** The worktree path under the parent repo. Convention: every
 *  worktree lives in a sibling of the parent (e.g.
 *  `/Users/linhn/vf-wt-<branch>` next to `/Users/linhn/vibeflow-docs`).
 *  We use the parent dir + `<branch>` as the default path; the
 *  caller can override via the `--path` flag. */
export function defaultWorktreePath(branch: string, parentDir?: string): string {
  const base = parentDir ?? cwd();
  const parent = isAbsolute(base) ? base : resolve(base);
  return join(parent, `vf-wt-${branch}`);
}

/** Build the helper-script argv. Pulled out as a pure function so
 *  tests can verify the wiring (the helper is the one that does
 *  the actual `git worktree add` + symlink). */
export function buildCreateArgs(
  branch: string,
  path: string,
  base?: string,
): { cmd: string; args: string[] } {
  const scriptPath = join(cwd(), "scripts", "create-worktree.sh");
  const args = [branch, path];
  if (base && base.length > 0) args.push("--base", base);
  return { cmd: scriptPath, args };
}

/** `vf worktree create <branch> [--base <base>] [--path <path>]` */
export function worktreeCreate(
  args: string[],
  flags: Record<string, string | boolean>,
  inject: WorktreeInject = {},
): number {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  const branch = args[0];
  if (typeof branch !== "string" || branch.length === 0) {
    out(
      "vf",
      c.red(
        "vf worktree create: missing <branch>. Usage: vf worktree create <branch> [--base <base>]",
      ),
      { level: "error" },
    );
    return 2;
  }
  const base = typeof flags.base === "string" ? flags.base : undefined;
  const pathFlag = typeof flags.path === "string" ? flags.path : undefined;
  const wtPath = pathFlag && pathFlag.length > 0 ? pathFlag : defaultWorktreePath(branch);

  // Sentinel: refuse to clobber. If the worktree path already
  // exists, error out with a clear message (A6 spec: "no silent
  // clobber"). The helper script does the same check, but we
  // surface it here so the exit code is right (2 = usage/refuse,
  // not 1 = helper failure).
  if (existsSync(wtPath)) {
    out("vf", c.red(`vf worktree create: path already exists: ${wtPath} (refusing to clobber)`), {
      level: "error",
    });
    return 2;
  }

  const { cmd, args: helperArgs } = buildCreateArgs(branch, wtPath, base);
  out("vf", c.dim(`vf worktree create: ${cmd} ${helperArgs.join(" ")}`), {
    meta: { kind: "worktree-create", branch, path: wtPath, base: base ?? "HEAD" },
  });
  const r = run(cmd, helperArgs, { cwd: cwd() });
  if (r.error) {
    out("vf", c.red(`vf worktree create: failed to spawn helper: ${r.error.message}`), {
      level: "error",
    });
    return 1;
  }
  if (r.status !== 0) {
    // The helper script prints its own error to stderr; we relay
    // it on failure so the operator sees why the create failed.
    const detail = r.stderr.trim() || `exit ${r.status}`;
    out("vf", c.red(`vf worktree create: ${detail}`), { level: "error" });
    return 1;
  }

  out("vf", c.green(`worktree created: ${wtPath}`), {
    meta: { kind: "worktree-created", branch, path: wtPath },
  });
  // One-line `cd` hint (per A6 spec: "Print worktree path +
  // one-line `cd` hint.").
  out("vf", `cd ${wtPath}`);
  return 0;
}

/** `vf worktree remove <branch>` — prune + force-remove merged
 *  worktrees. We delegate to `git worktree remove --force` after
 *  resolving the branch's worktree path. */
export function worktreeRemove(
  args: string[],
  _flags: Record<string, string | boolean>,
  inject: WorktreeInject = {},
): number {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  const branch = args[0];
  if (typeof branch !== "string" || branch.length === 0) {
    out("vf", c.red("vf worktree remove: missing <branch>. Usage: vf worktree remove <branch>"), {
      level: "error",
    });
    return 2;
  }

  // Resolve the worktree path for the branch via `git worktree list
  // --porcelain` (same pattern the shell helper uses). We do this
  // here so the error message can name the actual path.
  const listResult = run("git", ["worktree", "list", "--porcelain"], { cwd: cwd() });
  if (listResult.status !== 0) {
    out("vf", c.red(`vf worktree remove: git worktree list failed: ${listResult.stderr.trim()}`), {
      level: "error",
    });
    return 1;
  }
  let wtPath: string | null = null;
  let currentPath: string | null = null;
  for (const line of listResult.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line === `branch refs/heads/${branch}`) {
      wtPath = currentPath;
      break;
    }
  }
  if (!wtPath) {
    out("vf", c.red(`vf worktree remove: branch '${branch}' has no registered worktree`), {
      level: "error",
    });
    return 2;
  }

  // `git worktree remove --force` — the `--force` matches the A6
  // spec's "prune + force-remove merged worktrees" (a worktree
  // with uncommitted changes needs --force; for already-merged
  // branches this is the standard path).
  const r = run("git", ["worktree", "remove", "--force", wtPath], { cwd: cwd() });
  if (r.status !== 0) {
    out(
      "vf",
      c.red(`vf worktree remove: git worktree remove ${wtPath} failed: ${r.stderr.trim()}`),
      { level: "error" },
    );
    return 1;
  }
  out("vf", c.green(`worktree removed: ${wtPath}`), {
    meta: { kind: "worktree-removed", branch, path: wtPath },
  });
  return 0;
}

/** `vf worktree list` — show registered worktrees as a
 *  `<branch> <tab> <path>` table (one row per worktree). The
 *  raw `git worktree list --porcelain` is parsed here so the
 *  operator gets a one-row-per-worktree summary instead of the
 *  multi-line porcelain stream. */
export function worktreeList(
  _args: string[],
  _flags: Record<string, string | boolean>,
  inject: WorktreeInject = {},
): number {
  const run = inject.runCommandSync ?? defaultRunCommandSync;
  const r = run("git", ["worktree", "list", "--porcelain"], { cwd: cwd() });
  if (r.status !== 0) {
    out("vf", c.red(`vf worktree list: git worktree list failed: ${r.stderr.trim()}`), {
      level: "error",
    });
    return 1;
  }
  // Each worktree block is 4 lines (worktree / HEAD / branch /
  // separated by a blank line). We print one line per worktree.
  const lines = r.stdout.split("\n");
  let path = "";
  let branch = "(detached)";
  const rows: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "") {
      if (path) rows.push([path, branch]);
      path = "";
      branch = "(detached)";
    }
  }
  if (path) rows.push([path, branch]);
  if (rows.length === 0) {
    out("vf", c.dim("(no worktrees)"));
    return 0;
  }
  // Print a small table. The format is intentionally minimal —
  // the operator can pipe to column(1) if they want a wider view.
  out("vf", `worktrees (${rows.length}):`);
  for (const [p, b] of rows) {
    out("vf", `  ${b}\t${p}`);
  }
  return 0;
}

/** Top-level entry point. `vf worktree <action> ...`. */
export function worktree(
  args: string[],
  flags: Record<string, string | boolean>,
  inject: WorktreeInject = {},
): number {
  // `args[0]` is the action verb. We do NOT cast it to
  // WorktreeAction because that would hide "unknown" actions from
  // the switch's `default` arm. We compare against the canonical
  // set explicitly so the default arm is hit for unknown values
  // and for empty strings (bun's coverage tool requires the
  // default arm to be reached, not just declared).
  const action = args[0];
  switch (action) {
    case "create": {
      // The create action consumes args[0] (the action), so the
      // branch is args[1] from the caller's perspective — but
      // worktreeCreate expects args[0] to be the branch. Strip
      // the action verb before delegating.
      return worktreeCreate(args.slice(1), flags, inject);
    }
    case "remove": {
      return worktreeRemove(args.slice(1), flags, inject);
    }
    case "list": {
      return worktreeList(args.slice(1), flags, inject);
    }
    case undefined:
    case "":
      out("vf", c.red("vf worktree: missing action. Usage: vf worktree create|remove|list ..."), {
        level: "error",
      });
      return 2;
    default:
      out(
        "vf",
        c.red(`vf worktree: unknown action '${action}'. Expected: create | remove | list.`),
        {
          level: "error",
        },
      );
      return 2;
  }
}
