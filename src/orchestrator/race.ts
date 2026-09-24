// src/orchestrator/race.ts
//
// Head-to-head engine race ranking (issue #555).
//
// `vf race` dispatches the SAME task prompt to N engines in parallel, each in its
// own git worktree/branch, then ranks the results with the confidence gate that
// every dispatch already emits (`EngineSummary.confidence`). This module is the
// ranking authority only — no IO, no processes — so the CLI, the server route,
// and the UI read one rule. It imports nothing but the dependency-free engine
// vocabulary, which keeps it safe for the browser bundle.

import { ENGINES, type Engine } from "../core/agent-contract.js";

/** One engine's outcome in a race. `branch`/`worktree` name where its edits live. */
export interface RaceEntry {
  engine: Engine;
  /** False when the worktree or the dispatch failed — the row still ranks, below every ok row. */
  ok: boolean;
  confidence: number;
  tests_run: number;
  files_changed: number;
  branch: string;
  worktree: string;
  reason?: string;
}

/** Position of an engine in the canonical ENGINES order (unknown ⇒ last). */
function engineOrder(engine: Engine): number {
  const index = ENGINES.indexOf(engine);
  return index === -1 ? ENGINES.length : index;
}

/**
 * Rank a race, highest first, by the confidence gate:
 *   1. successful dispatches before failed ones,
 *   2. `confidence` descending (the objective winner signal),
 *   3. `tests_run` descending, then `files_changed` descending (the tie-break),
 *   4. canonical ENGINES order (so equal rows never reorder between runs).
 * Total and stable: every entry lands exactly once.
 */
export function rankRace(entries: readonly RaceEntry[]): RaceEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.ok) - Number(a.ok) ||
      b.confidence - a.confidence ||
      b.tests_run - a.tests_run ||
      b.files_changed - a.files_changed ||
      engineOrder(a.engine) - engineOrder(b.engine),
  );
}
