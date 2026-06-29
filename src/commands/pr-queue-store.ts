// src/commands/pr-queue-store.ts
// Single-writer JSONL queue for "which PR to merge next".
// File format: JSONL at `.vibeflow/.merge-queue.jsonl` (one PR per line).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "./_shared.js";
import { acquireLock, releaseLock } from "./pr-queue-lock.js";

/** Queue file location. */
export const QUEUE_PATH = ".vibeflow/.merge-queue.jsonl";

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
