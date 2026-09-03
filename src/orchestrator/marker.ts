import { execFileSync } from "node:child_process";
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
import { sanitizePublicValue } from "../dispatch/public-redaction.js";
import {
  ENGINE_NATIVE_SESSION_STATUS,
  type EngineNativeSessionStatus,
} from "../dispatch/session-contract.js";
import {
  type DispatchMarker,
  MARKER_PROJECT,
  MARKER_PROJECT_OPTION_BY_STATUS,
  MARKER_STATUS,
  type MarkerStatus,
  parseDispatchMarker,
} from "./marker-contract.js";
import { applyResumeMarkerUpdate, resumeMarkerFields } from "./resume-binding.js";
import { appendTimeline, timelinePath } from "./timeline.js";

export type { DispatchMarker, MarkerStatus } from "./marker-contract.js";
export { MARKER_STATUS } from "./marker-contract.js";

export type PublicDispatchMarker = Omit<
  DispatchMarker,
  "engineSessionId" | "engineSessionEngine" | "resumeStatus"
> & {
  nativeSessionStatus: EngineNativeSessionStatus;
};

function projectPublicMarker(marker: DispatchMarker): PublicDispatchMarker {
  const {
    engineSessionId,
    engineSessionEngine: _engineSessionEngine,
    resumeStatus: _resumeStatus,
    ...publicMarker
  } = marker;
  return sanitizePublicValue(
    {
      ...publicMarker,
      evidence: publicMarker.evidence.map(() => "[opaque-evidence]"),
      nativeSessionStatus: engineSessionId
        ? ENGINE_NATIVE_SESSION_STATUS.CAPTURED
        : ENGINE_NATIVE_SESSION_STATUS.UNAVAILABLE,
    },
    engineSessionId ? [engineSessionId] : [],
  );
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

function readPersistedMarker(path: string): DispatchMarker | null {
  try {
    return parseDispatchMarker(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function createMarker(
  unit: string,
  agent?: string,
  resumeBinding?: Pick<DispatchMarker, "engineSessionId" | "engineSessionEngine" | "status">,
): DispatchMarker {
  const marker: DispatchMarker = {
    unit,
    status: MARKER_STATUS.PENDING,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    confidence: 0,
    evidence: [],
    agent,
    ...resumeMarkerFields(agent, resumeBinding),
  };
  writeFileSync(markerPath(unit), JSON.stringify(marker, null, 2));
  return marker;
}

/**
 * Sync the marker's status to GitHub ProjectV2 #6 via `gh project item-edit`.
 * Best-effort: warns on non-zero exit, never throws.
 *
 * Uses the hard-coded Status field + single-select option IDs matching
 * Project #6's schema. No-op when the marker has no `projectItemId`.
 */
export function syncProjectStatus(marker: DispatchMarker): void {
  if (!marker.projectItemId) return;
  const optionId = MARKER_PROJECT_OPTION_BY_STATUS[marker.status];
  if (!optionId) return; // pending — nothing to sync

  try {
    execFileSync(
      "gh",
      [
        "project",
        "item-edit",
        "--id",
        marker.projectItemId,
        "--project-id",
        MARKER_PROJECT.projectId,
        "--field-id",
        MARKER_PROJECT.statusFieldId,
        "--single-select-option-id",
        optionId,
      ],
      { stdio: "pipe", timeout: 10_000 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[vf:marker] syncProjectStatus failed for ${marker.unit}: ${msg}\n`);
  }
}

/**
 * Close the linked GitHub issue when a unit is `done` and a PR merge is
 * detected. Best-effort: warns on non-zero exit, never throws.
 *
 * Merged-PR detection: scans `gh pr list --state merged --search <unit-name>`
 * for a match — optimistic heuristic, not bulletproof.
 */
export function closeLinkedIssue(
  marker: DispatchMarker,
  exec: typeof execFileSync = execFileSync,
): void {
  if (!marker.issueUrl) return;
  // Only close when the unit is done — caller gates this.
  if (marker.status !== MARKER_STATUS.DONE) return;

  // Heuristic: look for a merged PR whose branch/head-ref contains the
  // unit name. If found, auto-close the issue.
  try {
    const merged = exec(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "merged",
        "--search",
        marker.unit,
        "--json",
        "url",
        "--jq",
        ". | length",
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 10_000 },
    ).trim();
    if (!merged || merged === "0") return; // no merged PR → don't close

    exec("gh", ["issue", "close", marker.issueUrl, "--reason", "completed"], {
      stdio: "pipe",
      timeout: 10_000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[vf:marker] closeLinkedIssue failed for ${marker.unit}: ${msg}\n`);
  }
}

export function updateMarker(
  unit: string,
  update: Partial<
    Pick<
      DispatchMarker,
      | "status"
      | "confidence"
      | "evidence"
      | "exitCode"
      | "projectItemId"
      | "issueUrl"
      | "engineSessionId"
      | "engineSessionEngine"
    >
  >,
): DispatchMarker | null {
  const path = markerPath(unit);
  if (!existsSync(path)) return null;
  const current = readPersistedMarker(path);
  if (!current) return null;
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
  if (update.projectItemId !== undefined) marker.projectItemId = update.projectItemId;
  if (update.issueUrl !== undefined) marker.issueUrl = update.issueUrl;
  applyResumeMarkerUpdate(marker, update);
  writeFileSync(path, JSON.stringify(marker, null, 2));

  // AC #176: every status transition syncs to ProjectV2 #6
  if (update.status) {
    // #557: only append a timeline entry on an ACTUAL status change — a repeated same-status
    // update (idempotent re-write) must not duplicate the ledger or grow it unbounded across re-runs.
    if (update.status !== current.status) {
      appendTimeline(unit, {
        status: update.status,
        at: marker.updatedAt,
        confidence: marker.confidence,
        evidenceCount: marker.evidence.length,
      });
    }
    syncProjectStatus(marker);
    if (update.status === MARKER_STATUS.DONE) closeLinkedIssue(marker);
  }

  return marker;
}

export function readMarker(unit: string): DispatchMarker | null {
  const path = markerPath(unit);
  if (!existsSync(path)) return null;
  const marker = readPersistedMarker(path);
  if (!marker) return null;
  if (Date.now() - marker.startedAt > MARKER_TTL_MS) {
    removeIfExists(path);
    removeIfExists(timelinePath(unit)); // #557: don't orphan the sibling ledger on TTL expiry
    return null;
  }
  return marker;
}

export function listMarkers(): PublicDispatchMarker[] {
  const markers: DispatchMarker[] = [];
  const dir = markerDir();
  // markerDir() guarantees the directory exists (creates it if not),
  // so readdirSync should not throw in practice.
  const entries = readdirSync(dir);
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const marker = readPersistedMarker(join(dir, entry));
    if (marker && now - marker.startedAt <= MARKER_TTL_MS) {
      markers.push(marker);
    }
  }
  return markers.sort((a, b) => b.updatedAt - a.updatedAt).map(projectPublicMarker);
}

export function cleanupMarker(unit: string): void {
  removeIfExists(markerPath(unit));
  removeIfExists(lockPath(unit));
  removeIfExists(timelinePath(unit));
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
  // Lock file exists. Read it to decide: live → refuse; stale → unlink and retry.
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
