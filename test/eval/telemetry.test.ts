import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVerdictSamples, readVerifySamples } from "../../src/eval/telemetry.js";
import type { LogEvent } from "../../src/logbus.js";

function verdictEvent(over: Partial<LogEvent> & { meta: Record<string, unknown> }): LogEvent {
  return {
    seq: 1,
    ts: 1000,
    runId: "r",
    channel: "vf",
    level: "info",
    text: "verdict",
    ...over,
  } as LogEvent;
}

describe("readVerdictSamples (#549)", () => {
  test("parses verdict events, tolerant of missing resources/goal_score", () => {
    const events: LogEvent[] = [
      verdictEvent({
        unit: "alpha",
        meta: {
          kind: "verdict",
          review: "pass",
          gates: { build: "pass", review: "pass" },
          goal_score: 0.9,
          resources: { tokens: 120, cost_usd: 0.02 },
        },
      }),
      // no resources / no goal_score → costUsd/tokens/goalScore undefined
      verdictEvent({
        unit: "beta",
        meta: { kind: "verdict", review: "fail", gates: { review: "fail" } },
      }),
      // not a verdict → skipped
      verdictEvent({ meta: { kind: "other" }, text: "noise" }),
      // verdict but no gates object → gates defaults to {}
      verdictEvent({ meta: { kind: "verdict", review: "pass" } }),
    ];
    const samples = readVerdictSamples("/base", { readLog: () => events });
    expect(samples).toHaveLength(3);
    expect(samples[0]).toMatchObject({
      unit: "alpha",
      pass: true,
      goalScore: 0.9,
      costUsd: 0.02,
      tokens: 120,
    });
    expect(samples[0]?.gates).toEqual({ build: "pass", review: "pass" });
    expect(samples[1]).toMatchObject({ unit: "beta", pass: false });
    expect(samples[1]?.costUsd).toBeUndefined();
    expect(samples[1]?.goalScore).toBeUndefined();
    expect(samples[2]?.gates).toEqual({});
  });

  test("reads current.log + rotated siblings from disk via the real default reader", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-tel-"));
    const logs = join(base, ".vibeflow", "logs");
    mkdirSync(logs, { recursive: true });
    const ev = (seq: number, unit: string, review: string) =>
      `${JSON.stringify(verdictEvent({ seq, unit, meta: { kind: "verdict", review, gates: {} } }))}\n`;
    writeFileSync(join(logs, "current.log"), ev(3, "c", "pass"));
    writeFileSync(join(logs, "current.log.1"), ev(2, "b", "fail"));
    // .2 is malformed on one line → skipped, valid line kept
    writeFileSync(join(logs, "current.log.2"), `not-json\n${ev(1, "a", "pass")}`);
    const samples = readVerdictSamples(base);
    const units = samples.map((s) => s.unit as string).sort();
    expect(units).toEqual(["a", "b", "c"]);
    rmSync(base, { recursive: true, force: true });
  });

  test("empty telemetry → []", () => {
    expect(readVerdictSamples("/nope", { readLog: () => [] })).toEqual([]);
  });
});

describe("readVerifySamples (#549)", () => {
  test("parses pass/fail lines, skips non-verify headers and garbage", () => {
    const journal = [
      "# Work Journal",
      "",
      "## [2026-07-13] verify | pass",
      "some evidence",
      "## [2026-07-12] verify | fail",
      "## [2026-07-11] dispatch | pass", // not verify → skip
      "## [bad-date] verify | pass", // date mismatch → skip
      "random text",
    ].join("\n");
    const samples = readVerifySamples("/base", { readJournal: () => journal });
    expect(samples).toEqual([
      { date: "2026-07-13", pass: true },
      { date: "2026-07-12", pass: false },
    ]);
  });

  test("reads journal from disk via default reader; missing file → []", () => {
    const base = mkdtempSync(join(tmpdir(), "vf-ver-"));
    // no knowledge/log.md yet
    expect(readVerifySamples(base)).toEqual([]);
    const kn = join(base, ".vibeflow", "knowledge");
    mkdirSync(kn, { recursive: true });
    writeFileSync(join(kn, "log.md"), "## [2026-07-13] verify | pass\n");
    expect(readVerifySamples(base)).toEqual([{ date: "2026-07-13", pass: true }]);
    rmSync(base, { recursive: true, force: true });
  });
});
