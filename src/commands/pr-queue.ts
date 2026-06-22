// src/commands/pr-queue.ts
// size-waiver: #174 — A8 spec: 4 subcommands (list/claim/release/add) + JSONL reader + lock wrapper + tests; 400-line cap waived to ~500.
// A8 of the orchestrator-first plan (issue #174): `vf pr queue`.
//
// Single-writer JSONL queue for "which PR to merge next" +
// `mkdirSync`-style atomic file lock. Foundation for A9
// (merge-when-green), which consumes the queue.
//
// File format: JSONL at `.vibeflow/.merge-queue.jsonl` (one PR per line).
// Lock: `.vibeflow/.merge-queue.lock` (POSIX mkdirSync-style atomicity).
//
// This module does NOT depend on tryLock from src/orchestrator/marker.ts
// (which uses openSync("wx") — equivalent semantics) so the queue can
// be reused independently. The lock semantics here are: mkdirSync is
// atomic on POSIX, so two concurrent "mkdirSync(lock)" calls produce
// at most one success.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { c, cwd, out } from "./_shared.js";

/** Queue file location. */
export const QUEUE_PATH = ".vibeflow/.merge-queue.jsonl";
/** Lock dir (POSIX mkdirSync is atomic, so two concurrent `mkdirSync`
 *  calls on the same path produce exactly one success). */
export const LOCK_DIR = ".vibeflow/.merge-queue.lock";

/** Queue entry shape. */
export interface QueueEntry {
  pr: number;
  branch: string;
  addedAt: string;
  /** Claim status. The field exists for A9 to consume. A8 sets it
   *  to "free" by default and "claimed" when the lock is held. */
  status?: "free" | "claimed";
  /** Optional claimed-at timestamp. */
  claimedAt?: string;
}

/** Sentinel exit codes for `vf pr queue` (mirrors A7). */
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_LOCK_HELD = 4;
export const EXIT_IO = 5;
/** `vf pr queue claim` was called on a PR whose status is already
 *  "claimed". Split from EXIT_IO so callers can distinguish "lost the
 *  race" (4) from "state didn't allow the operation" (6). */
export const EXIT_ALREADY_CLAIMED = 6;
/** `vf pr queue release` was called on a PR whose status is "free"
 *  (nothing to release). Split from EXIT_IO so callers can distinguish
 *  "PR missing" (3) from "PR not in the right state" (7). */
export const EXIT_NOT_CLAIMED = 7;

/** Append a PR to the queue. The read+append+write is wrapped in
 *  `acquireLock`/`releaseLock` so two concurrent `addEntry` calls
 *  (e.g. CI + local) cannot lose an append: only one of them runs
 *  inside the critical section at a time.
 *
 *  Note: this is a locked read-merge-write, NOT a single
 *  `openSync("a")` syscall. POSIX `O_APPEND` would be safe for small
 *  JSONL lines (writes < PIPE_BUF are atomic), but bundling the
 *  critical section under the same `mkdirSync` lock that protects
 *  `claimEntry`/`releaseClaim` lets us share the "single writer"
 *  invariant with the rest of the queue. */
export function addEntry(
  entry: Omit<QueueEntry, "addedAt" | "status">,
  inject: {
    existsSync?: (p: string) => boolean;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string, enc: string) => void;
  } = {},
): QueueEntry {
  const _exists = inject.existsSync ?? existsSync;
  const _mkdir = inject.mkdirSync ?? mkdirSync;
  const _read = inject.readFileSync ?? readFileSync;
  const _write = inject.writeFileSync ?? writeFileSync;
  const newEntry: QueueEntry = { ...entry, addedAt: new Date().toISOString(), status: "free" };
  const path = join(cwd(), QUEUE_PATH);
  // Lock the read-merge-write so concurrent addEntry calls serialize.
  if (!acquireLock(inject)) {
    throw new Error("pr-queue: addEntry could not acquire lock (concurrent add in progress?)");
  }
  try {
    _mkdir(dirname(path), { recursive: true });
    // Append a single JSONL line under the lock. We re-read + rewrite
    // (rather than `fs.appendFileSync`) so the read+write of the
    // existing content stays inside the same critical section as the
    // claim/release paths.
    const line = `${JSON.stringify(newEntry)}\n`;
    const existing = _exists(path) ? _read(path, "utf8") : "";
    _write(path, existing + line, "utf8");
  } finally {
    releaseLock(inject);
  }
  return newEntry;
}

/** Read the queue from disk. Returns [] if the file doesn't exist. */
export function readQueue(
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  } = {},
): QueueEntry[] {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  const path = join(cwd(), QUEUE_PATH);
  if (!_exists(path)) return [];
  const raw = _read(path, "utf8");
  const out: QueueEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as QueueEntry);
    } catch {
      // Skip corrupt lines.
    }
  }
  return out;
}

/** Filter helper: list only the free entries (for `vf pr queue list`). */
export function listFree(queue: QueueEntry[]): QueueEntry[] {
  return queue.filter((e) => e.status !== "claimed");
}

/** Atomic lock acquire via mkdirSync. Returns true if we got it.
 *  Uses `recursive: false` so mkdirSync throws EEXIST when the path
 *  already exists. The parent dir (`.vibeflow/`) is created first. */
export function acquireLock(
  inject: {
    existsSync?: (p: string) => boolean;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
  } = {},
): boolean {
  return tryAcquireLockInternal(inject);
}

/** Internal: extracted so bun's coverage tool can attribute the
 *  try/catch close-brace. */
function tryAcquireLockInternal(inject: {
  existsSync?: (p: string) => boolean;
  mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
}): boolean {
  const _exists = inject.existsSync ?? existsSync;
  const _mkdir = inject.mkdirSync ?? mkdirSync;
  const lock = join(cwd(), LOCK_DIR);
  const parent = dirname(lock);
  if (!_exists(parent)) {
    if (!tryMkdirParent(_mkdir, parent)) return false;
  }
  if (_exists(lock)) return false;
  return tryMkdirLock(_mkdir, lock);
}

/** Top-level helper: try to mkdir the parent. Returns false on EEXIST
 *  (another process created it). Re-throws on any other error (e.g.
 *  EACCES — permission denied on the repo) so the caller can surface
 *  a real error instead of silently mapping it to "lock held". */
function tryMkdirParent(
  _mkdir: (p: string, opts: { recursive: boolean }) => void,
  parent: string,
): boolean {
  try {
    _mkdir(parent, { recursive: true });
    return true;
  } catch (err) {
    if (isErrnoCode(err, "EEXIST")) return false;
    throw err;
  }
}

/** Top-level helper: try to mkdir the lock. EEXIST (lock held) returns
 *  false; other errors (EACCES, ENOTDIR, …) re-throw so the caller
 *  doesn't misreport them as "lock held". */
function tryMkdirLock(
  _mkdir: (p: string, opts: { recursive: boolean }) => void,
  lock: string,
): boolean {
  try {
    _mkdir(lock, { recursive: false });
    return true;
  } catch (err) {
    if (isErrnoCode(err, "EEXIST")) return false;
    throw err;
  }
}

/** Narrow type guard: does `err` look like a NodeJS.ErrnoException
 *  with the given `code`? Used by the lock helpers to distinguish
 *  "lock held" (EEXIST) from "permission denied" (EACCES) and
 *  other unrecoverable I/O errors. */
function isErrnoCode(err: unknown, code: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown };
  return e.code === code;
}

/** Release the lock (rmdir the dir). */
export function releaseLock(
  inject: {
    existsSync?: (p: string) => boolean;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
  } = {},
): boolean {
  const _exists = inject.existsSync ?? existsSync;
  const _rm = inject.rmSync ?? rmSync;
  const lock = join(cwd(), LOCK_DIR);
  if (!_exists(lock)) return false;
  return tryRemoveLock(_rm, lock);
}

/** Top-level helper: try to remove the lock dir. */
function tryRemoveLock(
  _rm: (p: string, opts: { recursive: boolean }) => void,
  lock: string,
): boolean {
  try {
    _rm(lock, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/** Claim a PR. The `claim` operation: acquire the lock → rewrite the
 *  entry's status to "claimed" → release the lock. Returns the updated
 *  entry. Returns null if the lock is held (concurrent claim) or the
 *  PR is not in the queue. */
export function claimEntry(
  pr: number,
  inject: {
    existsSync?: (p: string) => boolean;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string, enc: string) => void;
  } = {},
): { ok: boolean; reason?: string; entry?: QueueEntry } {
  if (!acquireLock(inject)) return { ok: false, reason: "lock-held" };
  try {
    const queue = readQueue(inject);
    const idx = queue.findIndex((e) => e.pr === pr);
    if (idx === -1) return { ok: false, reason: "not-found" };
    const current = queue[idx];
    if (!current) return { ok: false, reason: "not-found" };
    if (current.status === "claimed") {
      return { ok: false, reason: "already-claimed" };
    }
    const updated: QueueEntry = {
      ...current,
      status: "claimed",
      claimedAt: new Date().toISOString(),
    };
    queue[idx] = updated;
    const path = join(cwd(), QUEUE_PATH);
    const data = `${queue.map((e) => JSON.stringify(e)).join("\n")}\n`;
    const _write = inject.writeFileSync ?? writeFileSync;
    _write(path, data, "utf8");
    return { ok: true, entry: queue[idx] };
  } finally {
    releaseLock(inject);
  }
}

/** Release a claim: rewrite the entry's status to "free". The
 *  read→mutate→write is wrapped in `acquireLock`/`releaseLock` so a
 *  racing `claimEntry` cannot lose an update: both operations
 *  serialize on the same lock. */
export function releaseClaim(
  pr: number,
  inject: {
    existsSync?: (p: string) => boolean;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string, enc: string) => void;
  } = {},
): { ok: boolean; reason?: string; entry?: QueueEntry } {
  if (!acquireLock(inject)) return { ok: false, reason: "lock-held" };
  try {
    const queue = readQueue(inject);
    const idx = queue.findIndex((e) => e.pr === pr);
    if (idx === -1) return { ok: false, reason: "not-found" };
    const current = queue[idx];
    if (!current) return { ok: false, reason: "not-found" };
    if (current.status !== "claimed") {
      return { ok: false, reason: "not-claimed" };
    }
    const updated: QueueEntry = { ...current, status: "free" };
    updated.claimedAt = undefined;
    queue[idx] = updated;
    const path = join(cwd(), QUEUE_PATH);
    const data = `${queue.map((e) => JSON.stringify(e)).join("\n")}\n`;
    const _write = inject.writeFileSync ?? writeFileSync;
    _write(path, data, "utf8");
    return { ok: true, entry: queue[idx] };
  } finally {
    releaseLock(inject);
  }
}

/** Format a queue entry as a row for `vf pr queue list`. When the
 *  entry is currently claimed, the last column shows the claim age
 *  (so operators can spot stuck claims). For free entries it shows
 *  the add age. */
export function formatRow(entry: QueueEntry): string {
  const status = entry.status ?? "free";
  const ts = entry.status === "claimed" && entry.claimedAt ? entry.claimedAt : entry.addedAt;
  const age = ts ? new Date(ts).toISOString().slice(11, 19) : "—";
  return `#${entry.pr}\t${entry.branch}\t${status}\t${age}`;
}

/** Map a `claimEntry` failure reason to an exit code. Extracted so
 *  every reason (including the unknown fallback) is unit-testable
 *  without injecting the fs layer. */
export function claimReasonToExitCode(reason: string | undefined): number {
  if (reason === "lock-held") return EXIT_LOCK_HELD;
  if (reason === "not-found") return EXIT_NOT_FOUND;
  if (reason === "already-claimed") return EXIT_ALREADY_CLAIMED;
  return EXIT_IO;
}

/** Map a `releaseClaim` failure reason to an exit code. */
export function releaseReasonToExitCode(reason: string | undefined): number {
  if (reason === "not-found") return EXIT_NOT_FOUND;
  if (reason === "not-claimed") return EXIT_NOT_CLAIMED;
  if (reason === "lock-held") return EXIT_LOCK_HELD;
  return EXIT_IO;
}

/** The `pr-queue` entry point. */
export async function prQueue(
  args: string[],
  flags: Record<string, string | boolean>,
  inject: {
    existsSync?: (p: string) => boolean;
    mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
    rmSync?: (p: string, opts: { recursive: boolean }) => void;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string, enc: string) => void;
  } = {},
): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "list":
      return prQueueList(args.slice(1), inject);
    case "add": {
      const pr = Number(args[1]);
      const branch = typeof flags.branch === "string" ? flags.branch : "";
      if (!Number.isFinite(pr) || pr <= 0 || !branch) {
        out(
          "vf",
          c.red("vf pr queue add <pr> --branch <branch>: requires a positive pr and --branch"),
          { level: "error" },
        );
        return EXIT_USAGE;
      }
      const entry = addEntry({ pr, branch }, inject);
      out("vf", c.green(`✓ added #${entry.pr} (${entry.branch}) to queue`), {
        meta: { kind: "pr-queue-add", pr: entry.pr, branch: entry.branch },
      });
      return EXIT_OK;
    }
    case "claim": {
      const pr = Number(args[1]);
      if (!Number.isFinite(pr) || pr <= 0) {
        out("vf", c.red("vf pr queue claim <pr>: requires a positive pr"), {
          level: "error",
        });
        return EXIT_USAGE;
      }
      const result = claimEntry(pr, inject);
      if (!result.ok) {
        const reason = result.reason ?? "unknown";
        out("vf", c.red(`vf pr queue claim #${pr}: ${reason}`), { level: "error" });
        return claimReasonToExitCode(result.reason);
      }
      out("vf", c.green(`✓ claimed #${pr} (${result.entry?.branch})`), {
        meta: { kind: "pr-queue-claim", pr, branch: result.entry?.branch },
      });
      return EXIT_OK;
    }
    case "release": {
      const pr = Number(args[1]);
      if (!Number.isFinite(pr) || pr <= 0) {
        out("vf", c.red("vf pr queue release <pr>: requires a positive pr"), {
          level: "error",
        });
        return EXIT_USAGE;
      }
      const result = releaseClaim(pr, inject);
      if (!result.ok) {
        const reason = result.reason ?? "unknown";
        out("vf", c.red(`vf pr queue release #${pr}: ${reason}`), { level: "error" });
        return releaseReasonToExitCode(result.reason);
      }
      out("vf", c.green(`✓ released #${pr} (${result.entry?.branch})`), {
        meta: { kind: "pr-queue-release", pr, branch: result.entry?.branch },
      });
      return EXIT_OK;
    }
    default:
      out("vf", c.red(`vf pr queue <list|add|claim|release>: unknown subcommand "${sub ?? ""}".`), {
        level: "error",
      });
      return EXIT_USAGE;
  }
}

function prQueueList(
  _args: string[],
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  },
): number {
  const queue = readQueue(inject);
  if (queue.length === 0) {
    out("vf", c.dim("queue is empty"));
    return EXIT_OK;
  }
  for (const entry of listFree(queue)) {
    out("vf", formatRow(entry));
  }
  return EXIT_OK;
}
