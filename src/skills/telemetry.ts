import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { c } from "../core.js";
import { out } from "../logbus.js";
import type { SkillNeed } from "./resolver.js";

const MAX_TELEMETRY_LINES = 1000;

export interface SkillTelemetryEvent {
  ts: string;
  command: string;
  skillsConsidered: string[];
  skillsUsed: string[];
  skillsAvailableUnverified: string[];
  skillsMissing: string[];
  failures: string[];
}

export interface SkillAcquisitionDecision {
  event: "acquisition-decision";
  skill: string;
  /** registryId@<12-char OID>, bounded — never a path/URL. */
  source: string;
  decision: "approve" | "reject" | "blocked" | "install-failed";
  command: string;
  at: string;
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

function trimTelemetry(path: string): void {
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    if (lines.length <= MAX_TELEMETRY_LINES + 1) return;
    const trimmed = lines.slice(lines.length - MAX_TELEMETRY_LINES - 1).join("\n");
    const tmp = `${path}.trim-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, trimmed, "utf8");
    renameSync(tmp, path);
  } catch {
    // non-fatal
  }
}

export function appendTelemetry(event: SkillTelemetryEvent, opts?: { dir?: string }): boolean {
  try {
    logDir(opts);
    const path = logPath(opts);
    appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    trimTelemetry(path);
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
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        typeof parsed.ts === "string" &&
        typeof parsed.command === "string" &&
        Array.isArray(parsed.skillsConsidered) &&
        Array.isArray(parsed.skillsUsed) &&
        Array.isArray(parsed.skillsMissing) &&
        Array.isArray(parsed.failures)
      ) {
        events.push({
          ts: parsed.ts as string,
          command: parsed.command as string,
          skillsConsidered: parsed.skillsConsidered as string[],
          skillsUsed: parsed.skillsUsed as string[],
          skillsAvailableUnverified: Array.isArray(parsed.skillsAvailableUnverified)
            ? (parsed.skillsAvailableUnverified as string[])
            : [],
          skillsMissing: parsed.skillsMissing as string[],
          failures: parsed.failures as string[],
        });
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
  topAvailableUnverified: [string, number][];
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
  const allAvailableUnverified: string[] = [];
  for (const e of events) {
    allUsed.push(...e.skillsUsed);
    allMissing.push(...e.skillsMissing);
    allAvailableUnverified.push(...(e.skillsAvailableUnverified ?? []));
  }
  return {
    topUsed: countAndSort(allUsed),
    topMissing: countAndSort(allMissing),
    topAvailableUnverified: countAndSort(allAvailableUnverified),
  };
}

export function renderTelemetry(
  events: SkillTelemetryEvent[],
  fmt: { bold: (s: string) => string; dim: (s: string) => string; yellow?: (s: string) => string },
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
  if (summary.topAvailableUnverified.length) {
    lines.push(fmt.bold("Top available-unverified skills:"));
    const yel = fmt.yellow ?? fmt.dim;
    for (const [name, count] of summary.topAvailableUnverified.slice(0, 10)) {
      lines.push(`  ${name} ${yel(`(${count})`)}`);
    }
  }
  return lines;
}

export function handleTelemetrySubcommand(opts?: { dir?: string }): number {
  for (const line of renderTelemetry(readTelemetry(opts), c)) out("vf", line);
  return 0;
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
      skillsAvailableUnverified: needs
        .filter((n) => n.status === "available-unverified")
        .map((n) => n.need),
      skillsMissing: needs.filter((n) => n.status === "missing").map((n) => n.need),
      failures: [],
    },
    opts,
  );
}

/** #682 — record one bounded acquisition-decision event per settled proposal. */
export function recordAcquisitionDecisions(
  events: SkillAcquisitionDecision[],
  opts?: { dir?: string },
): boolean {
  try {
    logDir(opts);
    const path = logPath(opts);
    for (const e of events) appendFileSync(path, `${JSON.stringify(e)}\n`, "utf8");
    trimTelemetry(path);
    return true;
  } catch {
    return false;
  }
}
