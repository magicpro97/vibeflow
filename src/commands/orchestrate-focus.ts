// src/commands/orchestrate-focus.ts
//
// Terminal-focus + once-only tip-state seam extracted from orchestrate.ts (#472).
// Raises the terminal via macOS `osascript … activate` (#390) and tracks the
// once-only "watch live" tip flag (#391). Behavior-preserving move — the bodies
// below are byte-identical to the originals in orchestrate.ts.

import { spawnSync as _spawnSync } from "node:child_process";
import { RUNTIME_PLATFORM } from "../durability/process-identity-contract.js";

// ponytail: inlined from seams.ts (#391) — once-only tip state
export const tipState = { shown: false };
export function resetTipStateForTests(): void {
  tipState.shown = false;
}

// ponytail: inlined from ui-focus.ts (#390)
export function focusTerminal(
  inject: {
    platform?: string;
    run?: (cmd: string, args: string[]) => void;
    termProgram?: string;
  } = {},
): void {
  if ((inject.platform ?? process.platform) !== RUNTIME_PLATFORM.DARWIN) return;
  const run =
    inject.run ??
    ((c, a) => {
      _spawnSync(c, a, { stdio: "ignore" });
    });
  const app =
    (inject.termProgram ?? process.env.TERM_PROGRAM) === "iTerm.app" ? "iTerm" : "Terminal";
  run("osascript", ["-e", `tell application "${app}" to activate`]);
}
export function maybeFocus(
  flags: { focus?: boolean; isTTY?: boolean },
  inject?: Parameters<typeof focusTerminal>[0],
): void {
  if (flags.focus !== true || flags.isTTY !== true) return;
  focusTerminal(inject);
}
