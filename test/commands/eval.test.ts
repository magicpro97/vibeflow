import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "../../src/logbus.js";
import { evalCmd } from "../../src/commands/eval.js";

/** Build a temp repo whose telemetry the default readers will pick up. */
function repo(events: LogEvent[], journal: string): string {
  const base = mkdtempSync(join(tmpdir(), "vf-eval-"));
  const logs = join(base, ".vibeflow", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, "current.log"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const kn = join(base, ".vibeflow", "knowledge");
  mkdirSync(kn, { recursive: true });
  writeFileSync(join(kn, "log.md"), journal);
  return base;
}

function verdict(seq: number, unit: string, review: string, extra: Record<string, unknown> = {}): LogEvent {
  return {
    seq,
    ts: seq,
    runId: "r",
    unit,
    channel: "vf",
    level: "info",
    text: "v",
    meta: { kind: "verdict", review, gates: { review }, ...extra },
  } as LogEvent;
}

function withCwd<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

describe("evalCmd (#549)", () => {
  test("empty telemetry → friendly note, exit 0", () => {
    const base = repo([], "# Work Journal\n");
    const code = withCwd(base, () => evalCmd([], {}));
    expect(code).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });

  test("prints human table, exit 0 without a threshold", () => {
    const base = repo(
      [
        verdict(1, "a", "pass", { goal_score: 0.9, resources: { tokens: 100, cost_usd: 0.01 } }),
        verdict(2, "b", "fail"),
      ],
      "## [2026-07-13] verify | pass\n",
    );
    const code = withCwd(base, () => evalCmd([], {}));
    expect(code).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });

  test("below threshold with enough samples → exit 1", () => {
    const events = Array.from({ length: 3 }, (_, i) => verdict(i + 1, `u${i}`, i === 0 ? "pass" : "fail"));
    const base = repo(events, "");
    const code = withCwd(base, () =>
      evalCmd([], { "min-pass-rate": "0.9", "min-samples": "3" }),
    );
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });

  test("thin samples under threshold → warning, exit 0", () => {
    const base = repo([verdict(1, "a", "fail")], "");
    const code = withCwd(base, () => evalCmd([], { "min-pass-rate": "0.9" }));
    expect(code).toBe(0);
    rmSync(base, { recursive: true, force: true });
  });

  test("--json prints a parseable report", () => {
    const base = repo([verdict(1, "a", "pass")], "");
    const logs: string[] = [];
    const spy = (m: unknown) => logs.push(String(m));
    const orig = console.log;
    console.log = spy as typeof console.log;
    try {
      const code = withCwd(base, () => evalCmd([], { json: true }));
      expect(code).toBe(0);
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.verdict.total).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });

  test("--out writes report file and returns exit code", () => {
    const base = repo([verdict(1, "a", "pass")], "");
    const outFile = join(base, "report.json");
    const code = withCwd(base, () => evalCmd([], { out: outFile }));
    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(outFile, "utf8"));
    expect(parsed.verdict.passed).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });

  test("reads minPassRate from settings when no flag", () => {
    const events = Array.from({ length: 3 }, (_, i) => verdict(i + 1, `u${i}`, "fail"));
    const base = repo(events, "");
    writeFileSync(
      join(base, ".vibeflow", "SETTINGS.json"),
      JSON.stringify({ eval: { minPassRate: 0.9, minSamples: 3 } }),
    );
    const code = withCwd(base, () => evalCmd([], {}));
    expect(code).toBe(1);
    rmSync(base, { recursive: true, force: true });
  });
});
