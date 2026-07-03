// src/spec-freshness.ts
//
// Spec-drift detection via cheap signals (Barr et al. IEEE TSE 2015 oracle-staleness).
// Zero deps, best-effort. Signals: content hash, key-claim Jaccard overlap.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** Where the dispatch-time spec snapshot for a task lands. */
export function specSnapshotPath(base: string, taskId: string): string {
  return join(base, CTX_DIR, "spec-snapshot", `${taskId}.md`);
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
