import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import type { SkillNeed } from "../src/skills/resolver.js";
import {
  appendTelemetry,
  readTelemetry,
  recordAcquisitionDecisions,
  recordSkillResolution,
  summarizeTelemetry,
} from "../src/skills/telemetry.js";
import type { SkillAcquisitionDecision, SkillTelemetryEvent } from "../src/skills/telemetry.js";

let base: string;
let logDir: string;
const LOG_REL = join(".vibeflow", "logs");

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-telemetry-"));
  logDir = join(base, LOG_REL);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function append(overrides: Partial<SkillTelemetryEvent> = {}): boolean {
  return appendTelemetry(
    {
      ts: "2025-01-01T00:00:00.000Z",
      command: "t",
      skillsConsidered: [],
      skillsUsed: [],
      skillsAvailableUnverified: [],
      skillsMissing: [],
      failures: [],
      ...overrides,
    },
    { dir: base },
  );
}

function read(): SkillTelemetryEvent[] {
  return readTelemetry({ dir: base });
}

function makeEvent(overrides: Partial<SkillTelemetryEvent> = {}): SkillTelemetryEvent {
  return {
    ts: "2025-01-01T00:00:00.000Z",
    command: "t",
    skillsConsidered: [],
    skillsUsed: [],
    skillsAvailableUnverified: [],
    skillsMissing: [],
    failures: [],
    ...overrides,
  };
}

describe("appendTelemetry", () => {
  test("writes one JSONL line", () => {
    expect(append({ command: "test-cmd", skillsUsed: ["s1"] })).toBe(true);
    const events = read();
    expect(events).toHaveLength(1);
    expect(events[0]?.command).toBe("test-cmd");
    expect(events[0]?.skillsUsed).toEqual(["s1"]);
  });

  test("appends multiple lines", () => {
    append({ command: "a" });
    append({ command: "b" });
    expect(read()).toHaveLength(2);
  });

  test("write failure returns false, does not throw", () => {
    const badDir = join(base, "not-a-directory");
    writeFileSync(badDir, "file blocks log directory");
    expect(
      appendTelemetry(
        {
          ts: "x",
          command: "x",
          skillsConsidered: [],
          skillsUsed: [],
          skillsAvailableUnverified: [],
          skillsMissing: [],
          failures: [],
        },
        { dir: badDir },
      ),
    ).toBe(false);
  });
});

describe("readTelemetry", () => {
  test("missing file returns []", () => {
    expect(read()).toEqual([]);
  });

  test("skips malformed lines", () => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "skills-telemetry.jsonl"),
      [JSON.stringify(makeEvent({ command: "x" })), "not-json", ""].join("\n"),
      "utf8",
    );
    const events = read();
    expect(events).toHaveLength(1);
    expect(events[0]?.command).toBe("x");
  });

  test("skips lines with wrong shape", () => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "skills-telemetry.jsonl"),
      `${JSON.stringify({ ts: "a", wrong: true })}\n`,
      "utf8",
    );
    expect(read()).toEqual([]);
  });

  test("read failure (dir missing) returns []", () => {
    expect(readTelemetry({ dir: join(base, "ghost") })).toEqual([]);
  });

  test("read failure on unreadable file returns []", () => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "skills-telemetry.jsonl"), "{}", "utf8");
    chmodSync(join(logDir, "skills-telemetry.jsonl"), 0o000);
    expect(read()).toEqual([]);
    chmodSync(join(logDir, "skills-telemetry.jsonl"), 0o644);
  });
});

describe("backward compat: old events without skillsAvailableUnverified", () => {
  test("loads old-format events, pads skillsAvailableUnverified to []", () => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      join(logDir, "skills-telemetry.jsonl"),
      `${JSON.stringify({
        ts: "2025-01-01T00:00:00.000Z",
        command: "old",
        skillsConsidered: [],
        skillsUsed: [],
        skillsMissing: [],
        failures: [],
      })}\n`,
      "utf8",
    );
    const events = read();
    expect(events).toHaveLength(1);
    expect(events[0]?.skillsAvailableUnverified).toEqual([]);
  });
});

describe("summarizeTelemetry", () => {
  test("empty events returns empty summaries", () => {
    const s = summarizeTelemetry([]);
    expect(s.topUsed).toEqual([]);
    expect(s.topMissing).toEqual([]);
    expect(s.topAvailableUnverified).toEqual([]);
  });

  test("counts and sorts descending including available-unverified", () => {
    const s = summarizeTelemetry([
      makeEvent({
        command: "x",
        skillsUsed: ["s1", "s2"],
        skillsMissing: ["m1"],
        skillsAvailableUnverified: ["u1"],
      }),
      makeEvent({
        command: "y",
        skillsUsed: ["s1"],
        skillsMissing: ["m2", "m1"],
        skillsAvailableUnverified: ["u2", "u1"],
      }),
      makeEvent({
        command: "z",
        skillsUsed: ["s3"],
        skillsMissing: [],
        skillsAvailableUnverified: [],
      }),
    ]);
    expect(s.topUsed).toEqual([
      ["s1", 2],
      ["s2", 1],
      ["s3", 1],
    ]);
    expect(s.topMissing).toEqual([
      ["m1", 2],
      ["m2", 1],
    ]);
    expect(s.topAvailableUnverified).toEqual([
      ["u1", 2],
      ["u2", 1],
    ]);
  });

  test("stable sort on equal count", () => {
    const s = summarizeTelemetry([
      makeEvent({
        command: "x",
        skillsUsed: ["b", "a"],
        skillsMissing: ["z", "y"],
        skillsAvailableUnverified: ["c", "d"],
      }),
    ]);
    expect(s.topUsed).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect(s.topMissing).toEqual([
      ["y", 1],
      ["z", 1],
    ]);
    expect(s.topAvailableUnverified).toEqual([
      ["c", 1],
      ["d", 1],
    ]);
  });
});

describe("recordSkillResolution", () => {
  function need(overrides: Partial<SkillNeed>): SkillNeed {
    return { need: "n", reason: "r", status: "missing", ...overrides };
  }

  test("maps satisfied/missing/unverified correctly", () => {
    const needs: SkillNeed[] = [
      need({ need: "xlsx-reader", status: "satisfied", satisfiedBy: "xlsx-reader" }),
      need({ need: "pdf-reader", status: "missing" }),
      need({ need: "markdown-reader", status: "satisfied", satisfiedBy: "md-reader" }),
      need({ need: "csv-reader", status: "available-unverified", promote: "csv-reader" }),
    ];
    expect(recordSkillResolution("test", needs, { dir: base })).toBe(true);
    const events = read();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.command).toBe("test");
    expect(e?.skillsConsidered).toEqual([
      "xlsx-reader",
      "pdf-reader",
      "markdown-reader",
      "csv-reader",
    ]);
    expect(e?.skillsUsed).toEqual(["xlsx-reader", "md-reader"]);
    expect(e?.skillsMissing).toEqual(["pdf-reader"]);
    expect(e?.skillsAvailableUnverified).toEqual(["csv-reader"]);
    expect(e?.failures).toEqual([]);
  });
});

describe("bounded retention", () => {
  test("trims to MAX_TELEMETRY_LINES (1000)", () => {
    for (let i = 0; i < 1005; i++) {
      append({ command: `cmd${i}` });
    }
    const events = read();
    expect(events.length).toBeLessThanOrEqual(1000);
    // Should retain the last entries
    expect(events[events.length - 1]?.command).toBe("cmd1004");
  });
});

describe("skills telemetry command", () => {
  function run(rest: string[]): number {
    const orig = process.cwd();
    process.chdir(base);
    try {
      return skills("telemetry", rest);
    } finally {
      process.chdir(orig);
    }
  }

  test("empty log prints friendly message, exit 0", () => {
    expect(run([])).toBe(0);
  });

  test("with data prints summary including available-unverified, exit 0", () => {
    append({
      command: "cmd1",
      skillsUsed: ["s1", "s2"],
      skillsMissing: ["m1"],
      skillsAvailableUnverified: ["u1"],
    });
    append({ command: "cmd2", skillsUsed: ["s1"], skillsMissing: ["m2"] });
    expect(run([])).toBe(0);
  });
});

describe("skills resolve emits telemetry", () => {
  function resolve(): number {
    const orig = process.cwd();
    process.chdir(base);
    try {
      return skills("resolve", []);
    } finally {
      process.chdir(orig);
    }
  }

  test("resolve appends a telemetry record", () => {
    resolve();
    const events = read();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const last = events[events.length - 1];
    expect(last?.command).toBe("resolve");
  });
});

function dec(overrides: Partial<SkillAcquisitionDecision> = {}): SkillAcquisitionDecision {
  return {
    event: "acquisition-decision",
    skill: "xlsx-reader",
    source: "skills@aaaaaaaaaaaa",
    decision: "approve",
    command: "orchestrate",
    at: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("recordAcquisitionDecisions (#682 audit)", () => {
  function rawLines(): string[] {
    return readFileSync(join(logDir, "skills-telemetry.jsonl"), "utf8").trim().split("\n");
  }

  test("writes exact JSONL decision events with bounded source", () => {
    expect(recordAcquisitionDecisions([dec()], { dir: base })).toBe(true);
    const lines = rawLines();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as SkillAcquisitionDecision;
    expect(parsed).toEqual({
      event: "acquisition-decision",
      skill: "xlsx-reader",
      source: "skills@aaaaaaaaaaaa",
      decision: "approve",
      command: "orchestrate",
      at: "2025-01-01T00:00:00.000Z",
    });
  });

  test("covers approve/reject/blocked/install-failed cases, one line each", () => {
    const events: SkillAcquisitionDecision[] = [
      dec({ skill: "a", source: "r1@a", decision: "approve" }),
      dec({ skill: "b", source: "r2@b", decision: "reject" }),
      dec({ skill: "c", source: "r3@c", decision: "blocked" }),
      dec({ skill: "d", source: "r4@d", decision: "install-failed" }),
    ];
    expect(recordAcquisitionDecisions(events, { dir: base })).toBe(true);
    const parsed = rawLines().map((l) => JSON.parse(l) as SkillAcquisitionDecision);
    expect(parsed.map((p) => p.decision)).toEqual([
      "approve",
      "reject",
      "blocked",
      "install-failed",
    ]);
    expect(parsed.map((p) => p.skill)).toEqual(["a", "b", "c", "d"]);
  });

  test("never leaks path/URL/finding content", () => {
    const events: SkillAcquisitionDecision[] = [
      dec({ source: "skills@a".repeat(16), command: "orchestrate" }),
    ];
    recordAcquisitionDecisions(events, { dir: base });
    const raw = rawLines().join("\n");
    expect(raw).not.toContain(base);
    expect(raw).not.toContain("github.com");
    expect(raw).not.toContain(".vibeflow");
    expect(raw).not.toContain("boom|rm -rf");
  });

  test("write failure is non-fatal (returns false, does not throw)", () => {
    const badDir = join(base, "not-a-directory");
    writeFileSync(badDir, "block");
    expect(recordAcquisitionDecisions([dec()], { dir: badDir })).toBe(false);
  });
});
