import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readState } from "../src/core.js";
import { decodeWorkflowState } from "../src/core/workflow-state-codec.js";
import { decodeLogEvent } from "../src/logbus/types.js";
import { replayFromLog } from "../src/server/handlers.js";

const legacyState = (unit: Record<string, unknown> = {}) => ({
  goal: "legacy",
  work_units: [unit],
});

describe("persisted protocol decoders", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  test("workflow decoder keeps partial legacy state and sanitizes depends_on", () => {
    const decoded = decodeWorkflowState(
      legacyState({ status: "pending", depends_on: ["first", 1, null] }),
    );
    expect(decoded?.work_units[0]?.status).toBe("pending");
    expect(decoded?.work_units[0]?.depends_on).toEqual(["first"]);
    expect(decodeWorkflowState({ units: {}, totals: { done: 0 } })).not.toBeNull();
  });

  test("workflow decoder rejects invented closed vocabulary values", () => {
    const invented = [
      { status: "invented" },
      { riskClass: "invented" },
      { knowledge_heavy_source: "invented" },
      { gates: { build: "invented" } },
      { gates: { invented: "pass" } },
      { acceptance_criteria: [{ id: "a", criterion: "works", priority: "REQUIRED" }] },
      { security: { consent: "later", verdict: "pass" } },
      { security: { consent: "run", verdict: "maybe" } },
    ];
    for (const unit of invented) expect(decodeWorkflowState(legacyState(unit))).toBeNull();
  });

  test("workflow decoder rejects custom and pollution-bearing prototypes", () => {
    expect(decodeWorkflowState(Object.create({ goal: "inherited" }))).toBeNull();
    const polluted = JSON.parse(
      '{"work_units":[{"__proto__":{"status":"done"},"status":"pending"}]}',
    );
    expect(decodeWorkflowState(polluted)).toBeNull();
  });

  test("readState fails closed when persisted state invents a status", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-state-codec-"));
    dirs.push(dir);
    const path = join(dir, ".vibeflow", "WORKFLOW_STATE.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(legacyState({ status: "invented" })));
    expect(readState(dir)).toBeNull();
  });

  test("log decoder normalizes supported legacy omissions", () => {
    expect(decodeLogEvent({ seq: 1, ts: 2, level: "info", text: "legacy" })).toEqual({
      seq: 1,
      ts: 2,
      runId: "",
      workflowId: undefined,
      repoPath: undefined,
      unit: undefined,
      channel: "vf",
      level: "info",
      text: "legacy",
      meta: undefined,
    });
  });

  test("log decoder rejects invented values and unsafe prototypes", () => {
    const base = { seq: 1, ts: 2, channel: "vf", level: "info", text: "ok" };
    expect(decodeLogEvent({ ...base, channel: "invented" })).toBeNull();
    expect(decodeLogEvent({ ...base, level: "verbose" })).toBeNull();
    expect(decodeLogEvent({ ...base, seq: -1 })).toBeNull();
    expect(decodeLogEvent(Object.assign(Object.create({}), base))).toBeNull();
    expect(decodeLogEvent({ ...base, meta: JSON.parse('{"__proto__":{"x":1}}') })).toBeNull();
  });

  test("replay skips invented log values while retaining valid legacy lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-log-codec-"));
    dirs.push(dir);
    const path = join(dir, "current.log");
    writeFileSync(
      path,
      [
        JSON.stringify({ seq: 1, ts: 1, level: "verbose", text: "invented" }),
        JSON.stringify({ seq: 2, ts: 2, level: "info", text: "valid" }),
      ].join("\n"),
    );
    expect(replayFromLog(path, 0, 10).map((event) => event.text)).toEqual(["valid"]);
  });
});
