// src/server/files-tree-route.ts
//
// GET /api/files/tree — the Files panel's listing endpoint. Lists tracked +
// untracked-but-not-ignored repo files (the same `git ls-files` shape as
// src/sandbox.ts) plus a per-path git status badge from `git status --porcelain`.
// The caller (server.ts) has ALREADY enforced guarded(req) — token + loopback +
// origin. Read-only: contents are NEVER returned here (previews ride the
// sandboxed GET /api/file); this route leaks no bytes, only paths + status.
import { spawnSync } from "node:child_process";
import {
  FILE_STATUS,
  FILE_TREE_MAX_ENTRIES,
  type FileChangeSplit,
  type FileStatusLabel,
  isUnmergedPorcelainCode,
  splitPorcelain,
  unsafeGitPath,
} from "../core/file-tree-contract.js";

export interface FileTreeEntry {
  path: string;
  status?: FileStatusLabel;
  index?: FileStatusLabel;
  worktree?: FileStatusLabel;
  untracked?: boolean;
}

export interface RunGitResult {
  status: number | null;
  stdout: string;
  /** Git's stderr (git routes surface its first line as the failure reason). */
  stderr?: string;
}
export interface FilesTreeDeps {
  runGit: (args: string[], cwd: string) => RunGitResult;
}

/**
 * Production runner: array argv, cwd-pinned, explicit 64 MiB stdout buffer
 * (precedent: src/verify/normative-proof-run-async.ts). spawnSync's 1 MiB
 * default can be exceeded by a ≤5000-path `ls-files` listing (or merge-stage
 * `status`) long before the entry cap trims it, which would turn a valid repo
 * into status === null → a wrong "not a git repository".
 */
export function defaultRunGit(
  args: string[],
  cwd: string,
  maxBufferBytes: number = 64 * 1024 * 1024,
): RunGitResult {
  const out = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    timeout: 10000,
    maxBuffer: maxBufferBytes,
  });
  return {
    // Overflow (ENOBUFS) leaves status 0 under Bun and status null under Node.
    // A set error therefore always means FAILURE — never a silently truncated
    // listing that the route would mistake for a complete one.
    status: out.error ? null : out.status,
    stdout: (out.stdout ?? Buffer.alloc(0)).toString(),
    stderr: (out.stderr ?? Buffer.alloc(0)).toString(),
  };
}

/** Map a porcelain XY code to the UI label; undefined = clean tracked file. */
function statusLabel(code: string): FileStatusLabel | undefined {
  if (code === "??") return FILE_STATUS.UNTRACKED;
  // Unmerged codes come FIRST: each carries an A/D/U half that the R/A/D/M/T
  // checks below would otherwise badge ("DD" → deleted, "AU" → added, …).
  // Conflicts stay unbadged on purpose — the path is not in a committable state.
  if (isUnmergedPorcelainCode(code)) return undefined;
  const x = code[0];
  const y = code[1];
  if (x === "R" || y === "R") return FILE_STATUS.RENAMED;
  if (x === "A" || y === "A") return FILE_STATUS.ADDED;
  if (x === "D" || y === "D") return FILE_STATUS.DELETED;
  if (x === "M" || y === "M") return FILE_STATUS.MODIFIED;
  if (x === "T" || y === "T") return FILE_STATUS.MODIFIED; // typechange reads as modified
  return undefined; // any other code (e.g. "U ") stays unbadged on purpose
}

export function handleFilesTreeRoute(
  repo: string,
  deps: FilesTreeDeps = { runGit: defaultRunGit },
): Response {
  const listed = deps.runGit(
    // --deduplicate: an in-progress merge lists one path per stage — without it
    // those duplicates become duplicate tree nodes/keys.
    ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"],
    repo,
  );
  if (listed.status !== 0) return Response.json({ ok: false, reason: "not a git repository" });

  const paths = listed.stdout.split("\0").filter(Boolean);

  const dry = deps.runGit(["status", "--porcelain", "-z"], repo);
  const statuses = new Map<string, FileStatusLabel>();
  // Parallel to `statuses`: the raw index/worktree split per path, from the
  // SAME porcelain pass (one splitPorcelain call per entry, no second git run).
  const splits = new Map<string, FileChangeSplit>();
  if (dry.status === 0) {
    for (const chunk of dry.stdout.split("\0")) {
      // -z format: "XY <path>"; a rename entry carries the OLD path as the next
      // chunk (no XY prefix) — the regex skips it, which is deliberate: the UI
      // keys files by their current path only.
      const m = /^([ MADRCU?!T]{2}) (.+)$/.exec(chunk);
      if (!m) continue;
      const label = statusLabel(m[1] as string);
      if (label) statuses.set(m[2] as string, label);
      splits.set(m[2] as string, splitPorcelain(m[1] as string));
    }
  }

  const entries: FileTreeEntry[] = [];
  let capped = false;
  for (const path of paths) {
    if (entries.length >= FILE_TREE_MAX_ENTRIES) {
      capped = true;
      break;
    }
    if (unsafeGitPath(path)) continue;
    const status = statuses.get(path);
    const split = splits.get(path);
    entries.push({
      path,
      ...(status ? { status } : {}),
      ...(split?.index ? { index: split.index } : {}),
      ...(split?.worktree ? { worktree: split.worktree } : {}),
      ...(split?.untracked ? { untracked: true } : {}),
    });
  }
  return Response.json({ ok: true, entries, truncated: capped });
}
