// src/commands/seams.ts
//
// Test seams for the per-subcommand files. These are symbols that the
// production code uses internally but that tests need to reach into.
// Issue #80, phase 2/14.
//
// Currently:
// - `tipState` + `resetTipStateForTests` — the "watch live" tip in
//   `orchestrate` is once-only per process. Tests reset the flag so
//   they can exercise the tip branch in isolation.
//
// No subcommand file may import from this module directly except via
// `./_shared.js` (the ESM cycle rule). For now, the public surface of
// the facade (`src/commands.ts`) re-exports `tipState` + `resetTipStateForTests`
// so existing callers (`import { tipState, resetTipStateForTests } from
// "../commands.js"`) keep working without modification.

/** Global state: the "watch live" tip prints at most once per process. */
// Test seam: exported so unit tests can reset the once-only tip
// flag before exercising it. Production callers never call this —
// the tip is genuinely once-only per process.
export const tipState = { shown: false };

export function resetTipStateForTests(): void {
  tipState.shown = false;
}
