// src/server/files-tree-route.ts
//
// GET /api/files/tree — the Files panel's listing endpoint. Lists tracked +
// untracked-but-not-ignored repo files (the same `git ls-files` shape as
// src/sandbox.ts) plus a per-path git status badge from `git status --porcelain`.
// The caller (server.ts) has ALREADY enforced guarded(req) — token + loopback +
// origin. Read-only: contents are NEVER returned here (previews ride the
// sandboxed GET /api/file); this route leaks no bytes, only paths + status.
import { spawnSync } from "node:child_process";

const MAX_ENTRIES = 5000;

export type FileStatusLabel = "modified" | "added" | "deleted" | "untracked" | "renamed";

export interface FileTreeEntry {
  path: string;
  status?: FileStatusLabel;
}

export interface RunGitResult {
  status: number | null;
  stdout: string;
}
export interface FilesTreeDeps {
  runGit: (args: string[], cwd: string) => RunGitResult;
}

/** Production runner: array argv, cwd-pinned, byte-capped by the kernel pipe. */
function defaultRunGit(args: string[], cwd: string): RunGitResult {
  const out = spawnSync("git", args, { cwd, encoding: "buffer", timeout: 10000 });
  return { status: out.status, stdout: (out.stdout ?? Buffer.alloc(0)).toString() };
}

/** Reject the same unsafe shapes src/sandbox.ts rejects before a path reaches the UI. */
function unsafeGitPath(file: string): boolean {
  const parts = file.split(/[\\/]/);
  return (
    file.startsWith("/") ||
    parts.includes("..") ||
    [...file].some((character) => character.charCodeAt(0) < 32)
  );
}

/** Map a porcelain XY code to the UI label; undefined = clean tracked file. */
function statusLabel(code: string): FileStatusLabel | undefined {
  if (code === "??") return "untracked";
  const x = code[0];
  const y = code[1];
  if (x === "R" || y === "R") return "renamed";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "M" || y === "M") return "modified";
  if (x === "T" || y === "T") return "modified"; // typechange reads as modified
  return undefined; // e.g. "U " (unmerged) — leave the file unbadged on purpose
}

export function handleFilesTreeRoute(
  repo: string,
  deps: FilesTreeDeps = { runGit: defaultRunGit },
): Response {
  const listed = deps.runGit(
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    repo,
  );
  if (listed.status !== 0) return Response.json({ ok: false, reason: "not a git repository" });

  const paths = listed.stdout.split("\0").filter(Boolean);

  const dry = deps.runGit(["status", "--porcelain", "-z"], repo);
  const statuses = new Map<string, FileStatusLabel>();
  if (dry.status === 0) {
    for (const chunk of dry.stdout.split("\0")) {
      // -z format: "XY <path>"; a rename entry carries the OLD path as the next
      // chunk (no XY prefix) — the regex skips it, which is deliberate: the UI
      // keys files by their current path only.
      const m = /^([ MADRCU?!T]{2}) (.+)$/.exec(chunk);
      if (!m) continue;
      const label = statusLabel(m[1] as string);
      if (label) statuses.set(m[2] as string, label);
    }
  }

  const entries: FileTreeEntry[] = [];
  let capped = false;
  for (const path of paths) {
    if (entries.length >= MAX_ENTRIES) {
      capped = true;
      break;
    }
    if (unsafeGitPath(path)) continue;
    const status = statuses.get(path);
    entries.push(status ? { path, status } : { path });
  }
  return Response.json({ ok: true, entries, truncated: capped });
}
