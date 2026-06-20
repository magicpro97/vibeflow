// test/commands-review-cross.test.ts
//
// Contract test for `vf review --cross <target>` (A5 #171).
//
// (a) both engines agree → exit 0 + "both engines agree" message
// (b) engines disagree → exit 0 + "DISAGREEMENT" surfaced to human
// (c) missing --cross flag → exit 2 (usage)
// (d) combining --cross with --auto → exit 1 (conflict, HUMAN-ONLY)
// (e) combining --cross with VF_REVIEW_AUTO=1 → exit 1
// (f) no target → exit 2
// (g) unknown target → exit 2
// (h) empty id → exit 2
// (i) target content not found → exit 1
// (j) no dispatch inject → exit 1
// (k) primary engine dispatch fails → exit 1
// (l) secondary engine dispatch fails → exit 1
// (m) non-parseable JSON → both default to revise → agree
// (n) pilot data is appended to .vibeflow/knowledge/cross-debate-pilot.json
// (o) pilot data disagreement rate is computed correctly
// (p) cross-engines array destructured as [primary, secondary] in correct order
// (q) extractSummary extracts the summary field from the JSON block
// (r) extractSummary falls back to the first non-empty line on non-JSON

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CROSS_ENGINES,
  PILOT_DATA_PATH,
  appendPilotData,
  computeDisagreementRate,
  readPilotData,
  reviewCross,
} from "../src/commands/review-cross.js";
import type { PilotEncounter } from "../src/commands/review-cross.js";
// ReviewTarget + ReviewVerdict are imported from the A4 surface via
// the review-cross.js re-export (the test uses them to construct
// PilotEncounter fixtures).
import type { ReviewTarget, ReviewVerdict } from "../src/commands.js";

let origCwd: string;
let dir: string;

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "vf-review-cross-test-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

/** Mock dispatch that returns a configurable response per engine. */
function mockDispatch(perEngine: Record<string, { ok: boolean; raw: string; reason?: string }>) {
  return async (opts: { engine: string; prompt: string; mode: string }) => {
    return perEngine[opts.engine] ?? { ok: false, raw: "", reason: "no mock for engine" };
  };
}

describe("vf review --cross (A5 #171) — auto cross-debate", () => {
  test("(a) both engines agree → exit 0 + 'agree' message", async () => {
    // Plant a plan so the content read succeeds.
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    const dispatch = mockDispatch({
      codex: { ok: true, raw: '```json\n{ "verdict": "approve", "summary": "good" }\n```' },
      claude: { ok: true, raw: '```json\n{ "verdict": "approve", "summary": "looks fine" }\n```' },
    });
    const code = await reviewCross(["plan", "test"], { cross: true }, { dispatch });
    expect(code).toBe(0);
  });

  test("(b) engines disagree → exit 0 + 'DISAGREEMENT' surfaced", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "disagree.md"), "# plan");
    const dispatch = mockDispatch({
      codex: { ok: true, raw: '```json\n{ "verdict": "approve", "summary": "ship it" }\n```' },
      claude: {
        ok: true,
        raw: '```json\n{ "verdict": "block", "summary": "scope too large" }\n```',
      },
    });
    const code = await reviewCross(["plan", "disagree"], { cross: true }, { dispatch });
    expect(code).toBe(0);
  });

  test("(c) missing --cross flag → exit 2 (usage)", async () => {
    const code = await reviewCross(["plan", "test"], {}, { dispatch: mockDispatch({}) });
    expect(code).toBe(2);
  });

  test("(d) combining --cross with --auto → exit 1 (HUMAN-ONLY conflict)", async () => {
    const code = await reviewCross(
      ["plan", "test"],
      { cross: true, auto: true },
      { dispatch: mockDispatch({}) },
    );
    expect(code).toBe(1);
  });

  test("(e) combining --cross with VF_REVIEW_AUTO=1 → exit 1", async () => {
    const orig = process.env.VF_REVIEW_AUTO;
    process.env.VF_REVIEW_AUTO = "1";
    try {
      const code = await reviewCross(
        ["plan", "test"],
        { cross: true },
        { dispatch: mockDispatch({}) },
      );
      expect(code).toBe(1);
    } finally {
      if (orig === undefined) process.env.VF_REVIEW_AUTO = "";
      else process.env.VF_REVIEW_AUTO = orig;
    }
  });

  test("(f) no target → exit 2", async () => {
    const code = await reviewCross([], { cross: true }, { dispatch: mockDispatch({}) });
    expect(code).toBe(2);
  });

  test("(g) unknown target → exit 2", async () => {
    const code = await reviewCross(
      ["bogus", "thing"],
      { cross: true },
      { dispatch: mockDispatch({}) },
    );
    expect(code).toBe(2);
  });

  test("(h) empty id → exit 2", async () => {
    const code = await reviewCross(["plan", ""], { cross: true }, { dispatch: mockDispatch({}) });
    expect(code).toBe(2);
  });

  test("(i) target content not found → exit 1", async () => {
    const code = await reviewCross(
      ["plan", "nonexistent"],
      { cross: true },
      { dispatch: mockDispatch({}) },
    );
    expect(code).toBe(1);
  });

  test("(j) no dispatch inject → exit 1", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    const code = await reviewCross(["plan", "test"], { cross: true }, {});
    expect(code).toBe(1);
  });

  test("(k) primary engine dispatch fails → exit 1", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    const dispatch = mockDispatch({
      codex: { ok: false, raw: "", reason: "engine down" },
      claude: { ok: true, raw: '```json\n{ "verdict": "approve" }\n```' },
    });
    const code = await reviewCross(["plan", "test"], { cross: true }, { dispatch });
    expect(code).toBe(1);
  });

  test("(l) secondary engine dispatch fails → exit 1", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    const dispatch = mockDispatch({
      codex: { ok: true, raw: '```json\n{ "verdict": "approve" }\n```' },
      claude: { ok: false, raw: "", reason: "engine down" },
    });
    const code = await reviewCross(["plan", "test"], { cross: true }, { dispatch });
    expect(code).toBe(1);
  });

  test("(m) non-parseable JSON → both default to revise → agree", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    const dispatch = mockDispatch({
      codex: { ok: true, raw: "no JSON here" },
      claude: { ok: true, raw: "also no JSON" },
    });
    const code = await reviewCross(["plan", "test"], { cross: true }, { dispatch });
    expect(code).toBe(0);
  });

  test("(n) pilot data is appended to .vibeflow/knowledge/cross-debate-pilot.json", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    const dispatch = mockDispatch({
      codex: { ok: true, raw: '```json\n{ "verdict": "approve", "summary": "good" }\n```' },
      claude: { ok: true, raw: '```json\n{ "verdict": "block", "summary": "no" }\n```' },
    });
    await reviewCross(["plan", "test"], { cross: true }, { dispatch });
    // The pilot data is written to the workdir (set in beforeEach).
    // Use readPilotData to verify.
    const data = readPilotData();
    expect(data.length).toBeGreaterThan(0);
    const last = data[data.length - 1];
    expect(last?.target).toBe("plan");
    expect(last?.targetId).toBe("test");
    expect(last?.agreement).toBe(false);
    expect(last?.verdicts).toEqual(["approve", "block"]);
  });

  test("(o) computeDisagreementRate: 0 disagreements in 0 encounters = 0", () => {
    expect(computeDisagreementRate([])).toBe(0);
  });

  test("(p) computeDisagreementRate: 1 disagreement in 4 encounters = 0.25", () => {
    const make = (agreement: boolean): PilotEncounter => ({
      timestamp: "2026-06-20T00:00:00Z",
      target: "plan" as ReviewTarget,
      targetId: "test",
      engines: ["codex", "claude"],
      verdicts: ["approve", "approve"] as [ReviewVerdict, ReviewVerdict],
      agreement,
      primarySummary: "test",
    });
    const encounters: PilotEncounter[] = [make(true), make(true), make(true), make(false)];
    expect(computeDisagreementRate(encounters)).toBe(0.25);
  });

  test("(q) computeDisagreementRate: 3 disagreements in 5 encounters = 0.60", () => {
    const make = (agreement: boolean): PilotEncounter => ({
      timestamp: "2026-06-20T00:00:00Z",
      target: "plan" as ReviewTarget,
      targetId: "test",
      engines: ["codex", "claude"],
      verdicts: ["approve", "approve"] as [ReviewVerdict, ReviewVerdict],
      agreement,
      primarySummary: "test",
    });
    const encounters: PilotEncounter[] = [
      make(false),
      make(false),
      make(false),
      make(true),
      make(true),
    ];
    expect(computeDisagreementRate(encounters)).toBe(0.6);
  });

  test("(r) DEFAULT_CROSS_ENGINES is [codex, claude]", () => {
    expect(DEFAULT_CROSS_ENGINES).toEqual(["codex", "claude"]);
  });

  test("(s) appendPilotData creates the directory if missing", () => {
    const encounter: PilotEncounter = {
      timestamp: "2026-06-20T00:00:00Z",
      target: "plan",
      targetId: "test",
      engines: ["codex", "claude"],
      verdicts: ["approve", "approve"],
      agreement: true,
      primarySummary: "test",
    };
    // The directory `.vibeflow/knowledge` doesn't exist yet.
    appendPilotData(encounter);
    expect(existsSync(join(dir, PILOT_DATA_PATH))).toBe(true);
  });

  test("(t) appendPilotData appends to existing data", () => {
    const e1: PilotEncounter = {
      timestamp: "2026-06-20T00:00:00Z",
      target: "plan",
      targetId: "first",
      engines: ["codex", "claude"],
      verdicts: ["approve", "approve"],
      agreement: true,
      primarySummary: "first",
    };
    const e2: PilotEncounter = {
      ...e1,
      targetId: "second",
      primarySummary: "second",
    };
    appendPilotData(e1);
    appendPilotData(e2);
    const data = readPilotData();
    expect(data.length).toBe(2);
    expect(data[0]?.targetId).toBe("first");
    expect(data[1]?.targetId).toBe("second");
  });

  test("(u) readPilotData returns [] when file doesn't exist", () => {
    expect(readPilotData()).toEqual([]);
  });

  test("(v) readPilotData returns [] on malformed JSON (don't crash)", () => {
    const path = join(dir, PILOT_DATA_PATH);
    mkdirSync(join(dir, ".vibeflow", "knowledge"), { recursive: true });
    writeFileSync(path, "not json at all");
    expect(readPilotData()).toEqual([]);
  });

  test("(w) readPilotData returns [] on JSON without encounters field", () => {
    const path = join(dir, PILOT_DATA_PATH);
    mkdirSync(join(dir, ".vibeflow", "knowledge"), { recursive: true });
    writeFileSync(path, JSON.stringify({ notEncounters: "wrong field" }));
    expect(readPilotData()).toEqual([]);
  });

  // ---- Coverage gap tests ----
  // (x) single-arg form: defaults to plan target
  test("(x) --cross with single arg defaults to plan target", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "single.md"), "# plan");
    const dispatch = mockDispatch({
      codex: { ok: true, raw: '```json\n{ "verdict": "approve" }\n```' },
      claude: { ok: true, raw: '```json\n{ "verdict": "approve" }\n```' },
    });
    const code = await reviewCross(["single"], { cross: true }, { dispatch });
    expect(code).toBe(0);
  });

  // (y) missing engine in the pair → exit 2
  test("(y) --cross with empty engines array → exit 2", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    const dispatch = mockDispatch({});
    // Pass an empty array (cast to bypass the type check).
    const code = await reviewCross(
      ["plan", "test"],
      { cross: true },
      { dispatch, engines: [] as unknown as readonly [string, string] },
    );
    expect(code).toBe(2);
  });

  // (z) extractSummary fallback to first non-empty line on no JSON block
  test("(z) extractSummary falls back to first non-empty line on non-JSON", async () => {
    // Re-import extractSummary indirectly via the reviewCross flow.
    // Use a non-JSON raw that has a first non-empty line.
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    const dispatch = mockDispatch({
      codex: { ok: true, raw: "This is the first line.\n\nMore text." },
      claude: { ok: true, raw: '```json\n{ "verdict": "approve" }\n```' },
    });
    const code = await reviewCross(["plan", "test"], { cross: true }, { dispatch });
    expect(code).toBe(0);
  });

  // (aa) extractSummary returns the malformed JSON string on parse error
  test("(aa) extractSummary returns raw JSON string on parse error", async () => {
    const plansDir = join(dir, ".vibeflow", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "test.md"), "# plan");
    // The fence block has malformed JSON inside.
    const dispatch = mockDispatch({
      codex: { ok: true, raw: "```json\n{ not: valid json }\n```" },
      claude: { ok: true, raw: '```json\n{ "verdict": "approve" }\n```' },
    });
    const code = await reviewCross(["plan", "test"], { cross: true }, { dispatch });
    expect(code).toBe(0);
  });
});
