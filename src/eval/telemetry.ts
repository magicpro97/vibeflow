// src/eval/telemetry.ts — #549
//
// Pure read-over-existing-telemetry: parse the verdict/verify events vf already
// writes during normal use into flat sample arrays. No LLM, no network, no
// fixtures — `vf eval` aggregates these to report a real success-rate.
//
// Two sources:
//   1. verdict events on the logbus `vf` channel (current.log + rotated .1..N)
//   2. verify pass/fail headers in .vibeflow/knowledge/log.md
//
// Readers are injected (deps) so tests never touch the real fs or spawn.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR } from "../core.js";
import type { LogEvent } from "../logbus.js";
import { replayFromLog } from "../server/handlers.js";

export interface VerdictSample {
  unit?: string;
  runId?: string;
  ts: number;
  pass: boolean;
  gates: Record<string, string>;
  goalScore?: number;
  costUsd?: number;
  tokens?: number;
}

export interface VerifySample {
  date: string;
  pass: boolean;
}

/** Max verdict events to replay per log file — a generous cap for the recent window. */
const MAX_EVENTS = 100_000;

/** Default logbus reader: replay current.log + rotated siblings from `base`. */
function defaultReadLog(base: string): LogEvent[] {
  const dir = join(base, CTX_DIR, "logs");
  const events: LogEvent[] = [];
  for (const name of ["current.log", ...[1, 2, 3, 4, 5].map((n) => `current.log.${n}`)]) {
    events.push(...replayFromLog(join(dir, name), 0, MAX_EVENTS));
  }
  return events;
}

/** Read verdict samples from logbus telemetry. Tolerant: missing fields → undefined. */
export function readVerdictSamples(
  base: string,
  deps: { readLog?: (base: string) => LogEvent[] } = {},
): VerdictSample[] {
  const events = (deps.readLog ?? defaultReadLog)(base);
  const samples: VerdictSample[] = [];
  for (const ev of events) {
    const meta = ev.meta;
    if (!meta || meta.kind !== "verdict") continue;
    const resources = meta.resources as { tokens?: number; cost_usd?: number } | undefined;
    samples.push({
      unit: ev.unit,
      runId: ev.runId,
      ts: ev.ts,
      pass: meta.review === "pass",
      gates: (meta.gates as Record<string, string> | undefined) ?? {},
      goalScore: typeof meta.goal_score === "number" ? meta.goal_score : undefined,
      costUsd: typeof resources?.cost_usd === "number" ? resources.cost_usd : undefined,
      tokens: typeof resources?.tokens === "number" ? resources.tokens : undefined,
    });
  }
  return samples;
}

const VERIFY_RE = /^## \[(\d{4}-\d{2}-\d{2})\] verify \| (pass|fail)/;

/** Default journal reader: read knowledge/log.md text, "" when absent. */
function defaultReadJournal(base: string): string {
  const p = join(base, CTX_DIR, "knowledge", "log.md");
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

/** Read verify pass/fail samples from the work journal. */
export function readVerifySamples(
  base: string,
  deps: { readJournal?: (base: string) => string } = {},
): VerifySample[] {
  const text = (deps.readJournal ?? defaultReadJournal)(base);
  const samples: VerifySample[] = [];
  for (const line of text.split("\n")) {
    const m = VERIFY_RE.exec(line);
    if (!m) continue;
    samples.push({ date: m[1] as string, pass: m[2] === "pass" });
  }
  return samples;
}
