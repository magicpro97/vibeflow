// src/spec-freshness.ts
//
// Spec-drift detection via cheap signals (Barr et al. IEEE TSE 2015 oracle-staleness).
// Zero deps, best-effort. Signals: content hash, key-claim Jaccard overlap.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CTX_DIR, writeFileSafe } from "./core.js";
import { decisionsPath } from "./decisions.js";
import type { MemoryProvider } from "./memory/types.js";

export type FreshnessStatus = "fresh" | "drift" | "evolved";
export interface FreshnessResult {
  status: FreshnessStatus;
  signals: string[];
}

const CLAIM_RE = /[^.!?]*\b(?:must|shall|should|will|always|never)\b[^.!?]*[.!?]/gi;

/** Extract normative claim sentences (must/shall/never...). */
export function extractClaims(text: string): string[] {
  return (text.match(CLAIM_RE) ?? []).map((s) => s.trim().toLowerCase());
}

/** Jaccard overlap of two string sets. Empty/empty → 1 (no claims = no drift). */
export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 1 : inter / union;
}

/** SHA256 of the content body (for cheap unchanged-detection). */
export function specHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const DRIFT_THRESHOLD = 0.85;

/** Compare a snapshot spec against the current spec. `drift` when claim overlap
 *  drops below threshold; `fresh` when identical; `evolved` when hash changed
 *  but claims stayed above threshold (legitimate refinement). Best-effort. */
export function checkFreshness(snapshotSpec: string, currentSpec: string): FreshnessResult {
  if (specHash(snapshotSpec) === specHash(currentSpec)) {
    return { status: "fresh", signals: [] };
  }
  const overlap = jaccard(extractClaims(snapshotSpec), extractClaims(currentSpec));
  if (overlap < DRIFT_THRESHOLD) {
    return {
      status: "drift",
      signals: [`key-claim Jaccard ${overlap.toFixed(2)} < ${DRIFT_THRESHOLD}`],
    };
  }
  return {
    status: "evolved",
    signals: [`content changed, claims stable (Jaccard ${overlap.toFixed(2)})`],
  };
}

// ─── Task 4 — spec snapshot at dispatch + advisory drift signal in the hook ──

/** Local spec source: knowledge/decisions.md verbatim (or "" when absent).
 *  Task 4b generalizes this via loadAuthoritativeSpec + a MemoryProvider oracle. */
export function readLocalSpec(base: string): string {
  const p = decisionsPath(base);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** Task 4b — the authoritative spec text: a MemoryProvider oracle when it is one
 *  (spec() != null), else the local decisions.md. Precedence, NEVER merge — an
 *  external store (MCP/RS memory) can BE the spec oracle just by implementing
 *  spec(), without touching gate logic. builtin returns decisions.md → the same
 *  file the gate reads today (zero behavior change); off → provider null → local. */
export function loadAuthoritativeSpec(base: string, provider: MemoryProvider | null): string {
  const remote = provider?.spec?.();
  if (remote != null) return remote;
  return readLocalSpec(base);
}

/** Where the dispatch-time spec snapshot for a task lands. `taskId` is reduced to
 *  its basename so a crafted `../../etc/...` task_id (STATE.json is user-editable)
 *  can't escape the .vibeflow/spec-snapshot/ dir (arbitrary-write, CWE-22). */
export function specSnapshotPath(base: string, taskId: string): string {
  const safe = basename(taskId) || "task";
  return join(base, CTX_DIR, "spec-snapshot", `${safe}.md`);
}

/** Snapshot the authoritative spec text at dispatch, so the hook can later
 *  detect drift against what the engine was actually briefed on. */
export function writeSpecSnapshot(base: string, taskId: string, specText: string): void {
  writeFileSafe(specSnapshotPath(base, taskId), specText);
}

/** Advisory (warn, NOT block) spec-drift signals for a task: compare the
 *  current spec against the dispatch snapshot. Empty when no snapshot exists,
 *  or the spec is fresh/evolved — only real `drift` surfaces reasons. */
export function specStaleSignals(base: string, taskId: string, currentSpec: string): string[] {
  const snapPath = specSnapshotPath(base, taskId);
  if (!existsSync(snapPath)) return [];
  const r = checkFreshness(readFileSync(snapPath, "utf8"), currentSpec);
  return r.status === "drift" ? [`spec-stale: ${r.signals.join("; ")}`] : [];
}

// ─── Task 8 — Type B drift: impl edited out-of-pipeline (PROVENANCE, not semantics) ──
// "Does edited code still match the NL spec?" is the undecidable oracle problem.
// Flip it: "was scoped code changed since the last green verify, without re-dispatch?"
// is a trivial hash. Signal A = 100% recall on the provenance event; Signal B =
// diff-coverage escalation (edited+tested = likely benign warn; edited+untested = fail).

/** relPath -> sha256(content), or null when the file was ABSENT at snapshot
 *  time (#532 null-sentinel: lets detectImplDrift catch an absent→created file
 *  during the ship window, not just edit/delete of a file present at snapshot). */
export type ImplFingerprint = Record<string, string | null>;

/** Injectable file hasher (test seam). Returns null when the file is absent. */
export type FileHasher = (base: string, rel: string) => string | null;

const defaultHashFile: FileHasher = (base, rel) => {
  const p = join(base, rel);
  // #532 P3: statSync-guard so a scoped path that is a DIRECTORY fails open
  // (null = "absent") instead of readFileSync throwing EISDIR out of the gate.
  if (!existsSync(p) || !statSync(p).isFile()) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
};

/** Snapshot scoped-file hashes when a unit verifies GREEN. Store on the unit as
 *  `impl_fingerprint` (+ `verified_sha` = git HEAD) so a later verify can detect
 *  an out-of-pipeline edit. #532: record ABSENT scoped files as a null sentinel
 *  so a file created during the ship window is caught by detectImplDrift. */
export function snapshotImpl(
  base: string,
  scope: string[],
  hashFile: FileHasher = defaultHashFile,
): ImplFingerprint {
  const fp: ImplFingerprint = {};
  for (const rel of scope) fp[rel] = hashFile(base, rel);
  return fp;
}

/** Type B detector: scoped files that changed, were deleted, or were CREATED
 *  since the last green snapshot. Empty when the unit was never verified (no
 *  fingerprint). A null sentinel means "absent at snapshot": null→present is a
 *  create (#532), present→null is a delete, hash mismatch is an edit. */
export function detectImplDrift(
  base: string,
  fingerprint: ImplFingerprint | undefined,
  hashFile: FileHasher = defaultHashFile,
): string[] {
  if (!fingerprint) return [];
  const drifted: string[] = [];
  for (const [rel, oldHash] of Object.entries(fingerprint)) {
    const now = hashFile(base, rel);
    if (oldHash === null) {
      // absent at snapshot: only drift if it now EXISTS (created during ship).
      if (now !== null) drifted.push(`${rel} (created)`);
    } else if (now === null) drifted.push(`${rel} (deleted)`);
    else if (now !== oldHash) drifted.push(rel);
  }
  return drifted;
}

/** Parse the covered (hits>0) line numbers for one file out of an lcov report. */
export function coveredLines(lcov: string, relPath: string): Set<number> {
  const out = new Set<number>();
  let cur = "";
  for (const l of lcov.split("\n")) {
    if (l.startsWith("SF:")) cur = l.slice(3).trim();
    else if (l.startsWith("DA:") && cur.endsWith(relPath)) {
      const [ln, hits] = l.slice(3).split(",");
      if (Number(hits) > 0) out.add(Number(ln));
    }
  }
  return out;
}

/** Injectable `git diff -U0` changed-line reader (test seam). */
export type ChangedLinesReader = (base: string, rel: string, sinceRef: string) => number[];

const defaultChangedLines: ChangedLinesReader = (base, rel, sinceRef) => {
  let out: string;
  try {
    out = execFileSync("git", ["diff", "-U0", sinceRef, "--", rel], {
      cwd: base,
      encoding: "utf8",
    });
  } catch {
    // best-effort: a missing sinceRef (force-push) or non-git base must not
    // crash the gate. No diff info → caller treats as uncovered (fail-safe).
    return [];
  }
  const nums: number[] = [];
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    // `+N,0` = a pure in-file DELETION (no added lines). Count the hunk anchor
    // as one changed line so a deletion of covered spec lines still surfaces.
    const count = m[2] !== undefined ? Number(m[2]) : 1;
    if (count === 0) {
      nums.push(start);
      continue;
    }
    for (let i = 0; i < count; i++) nums.push(start + i);
  }
  return nums;
};

/** Signal B: does a drifted file have ANY changed line WITHOUT test coverage?
 *  true → cannot confirm the spec still holds (human review); false → the edit
 *  is pinned by a test (likely benign). No lcov → treat as uncovered (true). */
export function driftUncovered(
  base: string,
  rel: string,
  sinceRef: string,
  inject: { changedLines?: ChangedLinesReader; lcov?: string } = {},
): boolean {
  const lcovPath = join(base, "coverage", "lcov.info");
  const lcov = inject.lcov ?? (existsSync(lcovPath) ? readFileSync(lcovPath, "utf8") : null);
  if (lcov === null) return true;
  const covered = coveredLines(lcov, rel);
  const changed = (inject.changedLines ?? defaultChangedLines)(base, rel, sinceRef);
  return changed.some((ln) => !covered.has(ln));
}

/** #517: newest commit time (ISO-8601 UTC via `git log -1 --format=%cI`) of a
 *  unit's scoped files — when the code it verifies last changed. Returns null on
 *  a non-git base, an empty/absent scope, or scoped files with no commit
 *  (fail-open: the freshness gate skips the unit rather than false-warning). */
export function defaultCodeTime(base: string, unit: { scope?: string[] }): string | null {
  const scope = unit.scope ?? [];
  if (!scope.length) return null;
  let out: string;
  try {
    out = execFileSync("git", ["log", "-1", "--format=%cI", "--", ...scope], {
      cwd: base,
      encoding: "utf8",
    });
  } catch {
    return null; // non-git base / bad ref
  }
  const iso = out.trim();
  if (!iso) return null; // scoped files have no commit
  // Normalize to UTC Z so ISO strings sort lexicographically against evidence_at.
  // Guard a malformed %cI (unreachable in practice, but keeps the gate fail-open
  // rather than throwing a RangeError out of policyGates).
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/** Default Type-B drift check for a unit (used by the policyGates seam): hash
 *  scoped files vs the stored fingerprint, then flag any drifted file whose
 *  change is uncovered. cwd + the unit's verified_sha is the diff base. */
export function defaultImplDrift(
  u: { impl_fingerprint?: ImplFingerprint; verified_sha?: string },
  base: string = process.cwd(),
): { drifted: string[]; uncovered: string[] } {
  const drifted = detectImplDrift(base, u.impl_fingerprint);
  const since = u.verified_sha ?? "HEAD";
  // A "(deleted)" or "(created)" marker has no old→new line diff to check —
  // always uncovered (a ship-window create/delete can't be pinned by a test).
  const uncovered = drifted.filter((rel) =>
    rel.endsWith("(deleted)") || rel.endsWith("(created)")
      ? true
      : driftUncovered(base, rel, since),
  );
  return { drifted, uncovered };
}
