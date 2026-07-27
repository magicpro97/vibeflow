import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills } from "../src/commands/skills.js";
import type { SkillNeed } from "../src/skills/resolver.js";
import {
  appendTelemetry,
  readTelemetry,
  recordSkillResolution,
  summarizeTelemetry,
} from "../src/skills/telemetry.js";
import type { SkillTelemetryEvent } from "../src/skills/telemetry.js";

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
      [
        JSON.stringify({
          ts: "a",
          command: "x",
          skillsConsidered: [],
          skillsUsed: [],
          skillsMissing: [],
          failures: [],
        }),
        "not-json",
        "",
      ].join("\n"),
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

describe("summarizeTelemetry", () => {
  test("empty events returns empty summaries", () => {
    const s = summarizeTelemetry([]);
    expect(s.topUsed).toEqual([]);
    expect(s.topMissing).toEqual([]);
  });

  test("counts and sorts descending", () => {
    const s = summarizeTelemetry([
      {
        ts: "a",
        command: "x",
        skillsConsidered: [],
        skillsUsed: ["s1", "s2"],
        skillsMissing: ["m1"],
        failures: [],
      },
      {
        ts: "b",
        command: "y",
        skillsConsidered: [],
        skillsUsed: ["s1"],
        skillsMissing: ["m2", "m1"],
        failures: [],
      },
      {
        ts: "c",
        command: "z",
        skillsConsidered: [],
        skillsUsed: ["s3"],
        skillsMissing: [],
        failures: [],
      },
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
  });

  test("stable sort on equal count", () => {
    const s = summarizeTelemetry([
      {
        ts: "a",
        command: "x",
        skillsConsidered: [],
        skillsUsed: ["b", "a"],
        skillsMissing: ["z", "y"],
        failures: [],
      },
    ]);
    expect(s.topUsed).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect(s.topMissing).toEqual([
      ["y", 1],
      ["z", 1],
    ]);
  });
});

describe("recordSkillResolution", () => {
  function need(overrides: Partial<SkillNeed>): SkillNeed {
    return { need: "n", reason: "r", status: "missing", ...overrides };
  }

  test("maps satisfied/missing correctly", () => {
    const needs: SkillNeed[] = [
      need({ need: "xlsx-reader", status: "satisfied", satisfiedBy: "xlsx-reader" }),
      need({ need: "pdf-reader", status: "missing" }),
      need({ need: "markdown-reader", status: "satisfied", satisfiedBy: "md-reader" }),
    ];
    expect(recordSkillResolution("test", needs, { dir: base })).toBe(true);
    const events = read();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.command).toBe("test");
    expect(e?.skillsConsidered).toEqual(["xlsx-reader", "pdf-reader", "markdown-reader"]);
    expect(e?.skillsUsed).toEqual(["xlsx-reader", "md-reader"]);
    expect(e?.skillsMissing).toEqual(["pdf-reader"]);
    expect(e?.failures).toEqual([]);
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

  test("with data prints summary, exit 0", () => {
    append({ command: "cmd1", skillsUsed: ["s1", "s2"], skillsMissing: ["m1"] });
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
