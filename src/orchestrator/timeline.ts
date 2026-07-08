import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendFileSafe } from "../core.js";
import { markerDir } from "./marker.js";

/** One recorded status transition for a unit. */
export interface TimelineEntry {
  status: string;
  at: number;
  confidence?: number;
  evidenceCount?: number;
}

/** Path to a unit's append-only transition ledger (sibling of its marker). */
export function timelinePath(unit: string, dir = markerDir()): string {
  return join(dir, `${unit}.timeline.jsonl`);
}

/** Append one transition as a JSONL line. Crash-safe; NEVER throws into the
 *  caller — a telemetry write must not break a marker transition.
 *  ponytail: the swallow is correct here (non-fatal telemetry), not a shortcut. */
export function appendTimeline(unit: string, e: TimelineEntry, dir = markerDir()): void {
  try {
    appendFileSafe(timelinePath(unit, dir), `${JSON.stringify(e)}\n`);
  } catch {
    /* telemetry write failed — swallow, the marker update must still succeed */
  }
}

/** Read + parse a unit's timeline in file (chronological) order. A missing
 *  ledger → []; a corrupt line is skipped, never fatal. */
export function readTimeline(unit: string, dir = markerDir()): TimelineEntry[] {
  let raw: string;
  try {
    raw = readFileSync(timelinePath(unit, dir), "utf8");
  } catch {
    return []; // missing ledger (fresh unit) or unreadable
  }
  const out: TimelineEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as TimelineEntry;
      // Shape guard: a hand-edited ledger line with a non-string status / non-number at would
      // render as `[object Object]` / `NaNs ago`. Skip it (never XSS — mustache — but keep clean).
      if (typeof e.status === "string" && typeof e.at === "number") out.push(e);
    } catch {
      /* skip a corrupt line */
    }
  }
  return out;
}
