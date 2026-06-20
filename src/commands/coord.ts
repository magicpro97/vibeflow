// src/commands/coord.ts
//
// `vf coord` STUB (issue #184, A0 of the orchestrator-first plan).
//
// A0 ships the BRIEF SURFACE (state.ts + the coordinator-brief.md file
// + the staleness gate). A1 (#167) will ship the real `vf coord` shim
// that uses the brief's last-consult mtime to gate every non-trivial
// action. This stub is the contract between A0 and A1: "the brief's
// last-consult mtime, read by anyone."
//
// Until A1 lands, `vf coord` is a thin wrapper that:
//   - Reads the brief's last-consult mtime via readBriefLastConsult().
//   - If the brief is missing or stale, refuses with a clear message
//     and exits 1 (so the contract is testable end-to-end now).
//   - Otherwise prints "coord mode active, brief is fresh" and exits 0.
//
// The contract test (test/commands-state.test.ts case g) exercises
// this stub. When A1 lands, the body of this function grows; the
// surface (signature + exit codes) stays stable.

import { assertCoordBriefFresh, c, cwd, out } from "./_shared.js";

/** CLI entry point for `vf coord`. */
export function coord(
  _args: string[],
  _flags: Record<string, string | boolean>,
  inject: { now?: () => number } = {},
): number {
  const nowMs = inject.now ? inject.now() : Date.now();
  if (assertCoordBriefFresh(cwd(), nowMs) !== 0) return 1;
  out("vf", c.green("coord mode active, brief is fresh"));
  return 0;
}
