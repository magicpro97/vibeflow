// src/dispatch/guidance.ts
//
// Pre-dispatch guidance injection (#526 item 3, builds on item 7's file seam).
//
// The web UI drops a steering note for a QUEUED unit via POST /api/guidance/:unit,
// which appends to .vibeflow/guidance/<unit>.md. Just before a unit dispatches, the
// prompt-assembly path reads that file (if present), prepends it to the prompt, and
// deletes it — so the guidance is consumed exactly once.
//
// ponytail: steers only units still QUEUED under the parallel fan-out, NOT a unit
// already running. True mid-run injection would require changing orchestrateUnits
// (run.ts) from one-shot parallel dispatch to a per-unit loop — the core
// architectural line between VibeFlow and zeroshot — which is out of scope here.
//
// Both fns take injectable FS seams so unit tests never touch the real disk.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, appendFileSafe, cwd, sanitizeUnitName } from "../core.js";

/** Absolute path to a unit's guidance file. `unit` is untrusted (LLM/UI origin) so
 *  it is sanitized against path traversal. */
function guidancePath(base: string, unit: string): string {
  return join(base, CTX_DIR, "guidance", `${sanitizeUnitName(unit)}.md`);
}

/** Append a guidance note for a (queued) unit. Fire-and-forget from the POST route. */
export function writeGuidance(
  unit: string,
  note: string,
  opts: { base?: string; appendFile?: (path: string, content: string) => void } = {},
): void {
  const append = opts.appendFile ?? appendFileSafe;
  append(guidancePath(opts.base ?? cwd(), unit), note.endsWith("\n") ? note : `${note}\n`);
}

/** Read a unit's guidance (if any), prepend it to `prompt`, and clear the file.
 *  Guidance absent → the prompt is returned unchanged (back-compat). */
export function applyGuidance(
  unit: string,
  prompt: string,
  opts: {
    base?: string;
    readGuidance?: (path: string) => string | undefined;
    clearGuidance?: (path: string) => void;
  } = {},
): string {
  const path = guidancePath(opts.base ?? cwd(), unit);
  const read = opts.readGuidance ?? defaultReadGuidance;
  const note = read(path);
  if (note === undefined) return prompt;
  (opts.clearGuidance ?? defaultClearGuidance)(path);
  return `${note.trimEnd()}\n\n${prompt}`;
}

function defaultReadGuidance(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function defaultClearGuidance(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
