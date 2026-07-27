import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillNeed } from "./resolver.js";

export interface SkillTelemetryEvent {
  ts: string;
  command: string;
  skillsConsidered: string[];
  skillsUsed: string[];
  skillsMissing: string[];
  failures: string[];
}

function logDir(opts?: { dir?: string }): string {
  const base = opts?.dir ?? process.cwd();
  const dir = join(base, ".vibeflow", "logs");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return dir;
    }
  }
  return dir;
}

function logPath(opts?: { dir?: string }): string {
  return join(logDir(opts), "skills-telemetry.jsonl");
}

export function appendTelemetry(event: SkillTelemetryEvent, opts?: { dir?: string }): boolean {
  try {
    logDir(opts);
    appendFileSync(logPath(opts), `${JSON.stringify(event)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readTelemetry(opts?: { dir?: string }): SkillTelemetryEvent[] {
  const path = logPath(opts);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8") as string;
  } catch {
    return [];
  }
  const events: SkillTelemetryEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as SkillTelemetryEvent;
      if (
        typeof parsed.ts === "string" &&
        typeof parsed.command === "string" &&
        Array.isArray(parsed.skillsConsidered) &&
        Array.isArray(parsed.skillsUsed) &&
        Array.isArray(parsed.skillsMissing) &&
        Array.isArray(parsed.failures)
      ) {
        events.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return events;
}

export interface TelemetrySummary {
  topUsed: [string, number][];
  topMissing: [string, number][];
}

function countAndSort(items: string[]): [string, number][] {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item, (map.get(item) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
}

export function summarizeTelemetry(events: SkillTelemetryEvent[]): TelemetrySummary {
  const allUsed: string[] = [];
  const allMissing: string[] = [];
  for (const e of events) {
    allUsed.push(...e.skillsUsed);
    allMissing.push(...e.skillsMissing);
  }
  return {
    topUsed: countAndSort(allUsed),
    topMissing: countAndSort(allMissing),
  };
}

export function renderTelemetry(
  events: SkillTelemetryEvent[],
  fmt: { bold: (s: string) => string; dim: (s: string) => string },
): string[] {
  if (!events.length) return [fmt.dim("no skill telemetry yet")];
  const summary = summarizeTelemetry(events);
  const lines: string[] = [];
  if (summary.topUsed.length) {
    lines.push(fmt.bold("Top used skills:"));
    for (const [name, count] of summary.topUsed.slice(0, 10)) {
      lines.push(`  ${name} ${fmt.dim(`(${count})`)}`);
    }
  }
  if (summary.topMissing.length) {
    lines.push(fmt.bold("Top missing skills:"));
    for (const [name, count] of summary.topMissing.slice(0, 10)) {
      lines.push(`  ${name} ${fmt.dim(`(${count})`)}`);
    }
  }
  return lines;
}

export function recordSkillResolution(
  command: string,
  needs: SkillNeed[],
  opts?: { dir?: string },
): boolean {
  return appendTelemetry(
    {
      ts: new Date().toISOString(),
      command,
      skillsConsidered: needs.map((n) => n.need),
      skillsUsed: needs.filter((n) => n.status === "satisfied").map((n) => n.satisfiedBy ?? n.need),
      skillsMissing: needs.filter((n) => n.status === "missing").map((n) => n.need),
      failures: [],
    },
    opts,
  );
}
