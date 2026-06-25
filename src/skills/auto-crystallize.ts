// src/skills/auto-crystallize.ts
//
// Auto-crystallize a run into a DRAFT skill (issue #335). Reads the run's
// log + knowledge journal, runs the mechanical `crystallize` extractor, and
// writes a DRAFT SKILL.md when recurring patterns cross the threshold AND no
// draft already exists. NEVER installs — the draft lands as an untracked file
// for human review (same safety model as `vf skills crystallize`).
//
// This is the deterministic backstop of the learning loop: it fires at the
// end of `vf orchestrate` and `vf verify --journal` regardless of which
// engine ran, so the loop does not depend on an agent following a prompt.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, writeFileSafe } from "../core.js";
import { crystallize } from "./crystallize.js";

export interface AutoCrystallizeResult {
  /** True when a new DRAFT skill file was written. */
  drafted: boolean;
  /** The draft skill slug (present whenever patterns crossed the threshold). */
  draftName?: string;
  /** Absolute path to the draft SKILL.md (present when draftName is). */
  draftPath?: string;
  /** How many distinct patterns crossed their threshold. */
  patternCount: number;
  /** Why nothing was written, when drafted is false. */
  skipped?: "exists" | "no-patterns";
}

/**
 * Read the run's log + knowledge journal, crystallize, and write a DRAFT
 * skill if patterns cross the threshold and no draft already exists.
 *
 * FS is injectable so tests drive it without touching a real tree. The
 * write goes only to the canonical `.vibeflow/skills/<name>/SKILL.md` — it
 * is NOT synced to engine mirrors and NOT installed.
 */
export function autoCrystallizeRun(
  base: string,
  runId: string,
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSafe?: (p: string, c: string) => void;
  } = {},
): AutoCrystallizeResult {
  const _existsSync = inject.existsSync ?? existsSync;
  const _readFileSync = inject.readFileSync ?? readFileSync;
  const _writeFileSafe = inject.writeFileSafe ?? writeFileSafe;

  const readLines = (p: string): string[] =>
    _existsSync(p) ? _readFileSync(p, "utf8").split("\n") : [];

  const result = crystallize({
    runId,
    logLines: readLines(join(base, CTX_DIR, "logs", "current.log")),
    journalLines: readLines(join(base, CTX_DIR, "knowledge", "log.md")),
  });

  if (!result.hasPatterns) {
    return { drafted: false, patternCount: 0, skipped: "no-patterns" };
  }

  const draftPath = join(base, CTX_DIR, "skills", result.draftName, "SKILL.md");
  if (_existsSync(draftPath)) {
    return {
      drafted: false,
      draftName: result.draftName,
      draftPath,
      patternCount: result.patterns.length,
      skipped: "exists",
    };
  }

  _writeFileSafe(draftPath, result.draft);
  return {
    drafted: true,
    draftName: result.draftName,
    draftPath,
    patternCount: result.patterns.length,
  };
}
