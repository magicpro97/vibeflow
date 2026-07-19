// src/workflow/init-update.ts
//
// Issue #323: `vf init` UPDATE mechanism — detect prior init via version stamp,
// seed the bundled `vf` skill into the repo's canonical skills dir, sync to
// engine mirrors, and stamp the current version on WorkflowState.
//
// This module is called from `applyIntake()` (src/commands/init-apply.ts)
// AFTER the deterministic file-generation loop. It is NOT a replacement for
// the merge loop — slim context regeneration inside the managed-region markers
// is already handled there. This adds the side-effects that only need to run
// when a prior workflow exists (re-init / upgrade).

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CTX_DIR, VERSION, readState, writeState } from "../core.js";
import { syncSkillMirrors } from "../skills/sync.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InitUpdateResult {
  /** True when the workflow version stamp was updated (missing or stale). */
  updated: boolean;
  /** True when the bundled `vf` skill was seeded into the repo's canonical skills dir. */
  seeded: boolean;
  /** Relative paths that were synced into engine mirror dirs (empty when nothing to sync). */
  synced: string[];
}

/**
 * Detect whether the workflow at `base` needs post-init update side-effects:
 *  - seed the bundled `vf` skill into `.vibeflow/skills/vf/` if missing/stale
 *  - sync canonical skills to engine mirror dirs
 *  - stamp the current VERSION on the workflow state
 *
 * Safe to call on every `vf init`; it short-circuits when no update is needed.
 */
export function ensureInitUpdated(base: string): InitUpdateResult {
  const state = readState(base);
  if (!state) return { updated: false, seeded: false, synced: [] };

  const needsVersionUpdate = !state.vibeflow_version || state.vibeflow_version !== VERSION;
  const seeded = seedVfSkillIfNeeded(base);
  let synced: string[] = [];

  if (seeded || needsVersionUpdate) {
    const result = syncSkillMirrors(base, { engines: ["claude", "codex", "copilot", "opencode"] });
    synced = result.synced;
  }

  if (needsVersionUpdate) {
    state.vibeflow_version = VERSION;
    writeState(base, state);
  }

  return { updated: needsVersionUpdate, seeded, synced };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Recursive directory copy (mirrors common-template.ts internal helper). */
function copyRecursiveSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    if (statSync(srcPath).isDirectory()) {
      copyRecursiveSync(srcPath, dstPath);
    } else {
      mkdirSync(dirname(dstPath), { recursive: true });
      copyFileSync(srcPath, dstPath);
    }
  }
}

/**
 * Seed the bundled `vf` skill from `<package>/.agents/skills/vf/` into the
 * repo's canonical skills dir (`.vibeflow/skills/vf/`) when it is missing.
 * Returns true when a copy was performed.
 */
function seedVfSkillIfNeeded(base: string): boolean {
  const dstDir = join(base, CTX_DIR, "skills", "vf");
  if (existsSync(join(dstDir, "SKILL.md"))) return false; // already present

  // Resolve bundled vf skill source — ships at <package>/.agents/skills/vf/
  // (same pattern as copySkillCreator in common-template.ts).
  const srcUrl = new URL("../../.agents/skills/vf", import.meta.url);
  const srcPath = fileURLToPath(srcUrl);
  if (!existsSync(srcPath)) return false; // bundled skill not found

  mkdirSync(dstDir, { recursive: true });
  copyRecursiveSync(srcPath, dstDir);
  return true;
}
