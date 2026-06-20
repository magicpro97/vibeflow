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
//
// === A1-STABLE SURFACE (do not change in A1) ===
//   - signature: `coord(_args, _flags, inject: { now?: () => number }): number`
//   - exit codes: 0 (fresh brief, gate passed), 1 (brief stale/missing)
//   - inject: `now` is the test seam; A1 may add `readBriefLastConsult`
//     and `state.readBrief` if it needs to check freshness without
//     rewriting the brief.
//   - the brief gate (BRIEF_FRESH_MS = 10 minutes) is the A0 contract;
//     A1 can tighten but should not loosen.
//
// === A1-ALLOWED CHANGES (body only) ===
//   - the stub currently calls `assertCoordBriefFresh` then exits.
//     A1 may: (a) call additional per-action gates (e.g. check the
//     user ask in §1 before destructive actions), (b) wire the
//     tool-deny-list via the hook system, (c) emit per-action audit
//     events to the logbus. The signature + exit codes stay.
//
// === EXIT CODE RESERVED FOR A1 ===
//   - exit 2 is currently used by `state()` for "unknown subcommand".
//     If A1 needs a 3rd exit code, reserve it for "fresh brief but the
//     requested sub-action is forbidden by §2 Non-negotiables" so
//     the codes stay distinct from the A0 surface.

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
