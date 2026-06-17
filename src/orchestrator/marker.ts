import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MarkerStatus = "pending" | "running" | "done" | "failed" | "blocked";

export interface DispatchMarker {
  unit: string;
  status: MarkerStatus;
  startedAt: number;
  updatedAt: number;
  confidence: number;
  evidence: string[];
  agent?: string;
  exitCode?: number;
}

const MARKER_TTL_MS = 4 * 60 * 60 * 1000;

export function markerDir(): string {
  const dir = join(homedir(), ".vibeflow", "markers");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function markerPath(unitName: string): string {
  return join(markerDir(), `${unitName}.json`);
}

function lockPath(unitName: string): string {
  return join(markerDir(), `${unitName}.lock`);
}

export function createMarker(unit: string, agent?: string): DispatchMarker {
  const marker: DispatchMarker = {
    unit,
    status: "pending",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    confidence: 0,
    evidence: [],
    agent,
  };
  writeFileSync(markerPath(unit), JSON.stringify(marker, null, 2));
  return marker;
}

export function updateMarker(
  unit: string,
  update: Partial<Pick<DispatchMarker, "status" | "confidence" | "evidence" | "exitCode">>,
): DispatchMarker | null {
  const path = markerPath(unit);
  if (!existsSync(path)) return null;
  const current: DispatchMarker = JSON.parse(readFileSync(path, "utf8"));
  const marker: DispatchMarker = {
    ...current,
    ...update,
    updatedAt: Date.now(),
    evidence: update.evidence
      ? [...new Set([...current.evidence, ...update.evidence])]
      : current.evidence,
  };
  if (update.status) marker.status = update.status;
  if (update.confidence !== undefined) marker.confidence = update.confidence;
  if (update.exitCode !== undefined) marker.exitCode = update.exitCode;
  writeFileSync(path, JSON.stringify(marker, null, 2));
  return marker;
}

export function readMarker(unit: string): DispatchMarker | null {
  const path = markerPath(unit);
  if (!existsSync(path)) return null;
  try {
    const marker: DispatchMarker = JSON.parse(readFileSync(path, "utf8"));
    if (Date.now() - marker.startedAt > MARKER_TTL_MS) {
      removeIfExists(path);
      return null;
    }
    return marker;
  } catch {
    return null;
  }
}

export function listMarkers(): DispatchMarker[] {
  const markers: DispatchMarker[] = [];
  const dir = markerDir();
  // markerDir() guarantees the directory exists (creates it if not),
  // so readdirSync should not throw in practice.
  const entries = readdirSync(dir);
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const marker: DispatchMarker = JSON.parse(readFileSync(join(dir, entry), "utf8"));
      if (now - marker.startedAt <= MARKER_TTL_MS) {
        markers.push(marker);
      }
    } catch {
      /* skip corrupt files */
    }
  }
  return markers.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function cleanupMarker(unit: string): void {
  removeIfExists(markerPath(unit));
  removeIfExists(lockPath(unit));
}

/** Acquire an exclusive lock for the given unit, or detect a stale one and steal it.
 *
 * The pre-fix implementation used a "check then write" pattern:
 *   if (existsSync(lock)) { ... }
 *   writeFileSync(lock, ...);
 * which is a classic TOCTOU (Time-Of-Check-Time-Of-Use) race: two
 * concurrent processes could both see `existsSync === false` and
 * both proceed to writeFileSync, ending up with two "owners" of
 * the same lock. CWE-367.
 *
 * Fix: lead every acquisition attempt with `openSync(lock, "wx")`
 * (atomic exclusive create) BEFORE reading the existing lock. If
 * the file doesn't exist, openSync succeeds and we own the lock.
 * If the file exists, openSync throws EEXIST — at which point we
 * fall back to reading the existing lock to decide whether it's
 * alive (refuse) or stale (unlink + retry the atomic create).
 *
 * The "check then unlink" path for stale locks is also subject to
 * a TOCTOU race: two processes could both see a stale lock, both
 * unlink it, and both think they own the freshly-created one. The
 * retry-after-unlink uses the same `openSync("wx")` atomic create
 * so the second-to-arrive gets EEXIST and is rejected.
 *
 * Net invariant: at any given moment, at most ONE process holds
 * the lock for the same unit. */
export function tryLock(unit: string): boolean {
  const lock = lockPath(unit);
  // Try the atomic create first. If it succeeds, we own the lock
  // outright — no need to consult the existing-lock branch.
  const fd = tryCreateExclusive(lock);
  if (fd !== null) {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    closeSync(fd);
    return true;
  }
  // Lock file already exists. Read it to decide: live → refuse;
  // stale → unlink and retry the atomic create.
  try {
    const data = JSON.parse(readFileSync(lock, "utf8"));
    const age = Date.now() - (data.ts || 0);
    if (age < MARKER_TTL_MS && data.pid && isProcessAlive(data.pid)) {
      return false;
    }
  } catch {
    // Corrupt or unreadable — treat as "held by another" to be safe.
    return false;
  }
  // Stale lock. Unlink and retry the atomic create. The retry
  // itself is racy if multiple processes observe the same stale
  // lock, but the atomic openSync("wx") ensures only one of them
  // gets the new fd.
  try {
    unlinkSync(lock);
  } catch {
    // Another process may have unlinked it first. That's fine —
    // the retry below will succeed or fail atomically.
  }
  const fd2 = tryCreateExclusive(lock);
  if (fd2 === null) return false;
  writeFileSync(fd2, JSON.stringify({ pid: process.pid, ts: Date.now() }));
  closeSync(fd2);
  return true;
}

/** Try to create the lock file exclusively. Returns the file
 * descriptor on success, or `null` if the file already exists
 * (EEXIST). Other open errors propagate. */
function tryCreateExclusive(lock: string): number | null {
  try {
    return openSync(lock, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }
}

export function releaseLock(unit: string): void {
  removeIfExists(lockPath(unit));
}

function removeIfExists(p: string): void {
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* already gone */
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
