// test/orchestrator-race.test.ts
//
// #555 — the race ranking authority. Pure, total, deterministic: this file pins
// the rule the CLI table, the `/api/race` response, and the UI all read, so a
// change here is the only place the winner rule can drift.

import { describe, expect, test } from "bun:test";
import { type RaceEntry, rankRace } from "../src/orchestrator/race.js";

function row(over: Partial<RaceEntry> & { engine: RaceEntry["engine"] }): RaceEntry {
  return {
    ok: true,
    confidence: 0,
    tests_run: 0,
    files_changed: 0,
    branch: `vf-race-${over.engine}`,
    worktree: `/tmp/vf-wt-vf-race-${over.engine}`,
    ...over,
  };
}

const enginesIn = (entries: readonly RaceEntry[]) => entries.map((e) => e.engine);

describe("rankRace (#555)", () => {
  test("ranks by confidence descending", () => {
    const ranked = rankRace([
      row({ engine: "codex", confidence: 0.4 }),
      row({ engine: "claude", confidence: 0.9 }),
      row({ engine: "copilot", confidence: 0.7 }),
    ]);
    expect(enginesIn(ranked)).toEqual(["claude", "copilot", "codex"]);
  });

  test("breaks a confidence tie on tests_run count", () => {
    const ranked = rankRace([
      row({ engine: "codex", confidence: 0.8, tests_run: 1 }),
      row({ engine: "claude", confidence: 0.8, tests_run: 4 }),
      row({ engine: "copilot", confidence: 0.8, tests_run: 3 }),
    ]);
    expect(enginesIn(ranked)).toEqual(["claude", "copilot", "codex"]);
  });

  test("breaks a tests_run tie on files_changed count", () => {
    const ranked = rankRace([
      row({ engine: "claude", confidence: 0.8, tests_run: 2, files_changed: 1 }),
      row({ engine: "codex", confidence: 0.8, tests_run: 2, files_changed: 5 }),
    ]);
    expect(enginesIn(ranked)).toEqual(["codex", "claude"]);
  });

  test("breaks a full tie on the canonical ENGINES order (stable, no run-to-run drift)", () => {
    const ranked = rankRace([
      row({ engine: "antigravity", confidence: 0.5 }),
      row({ engine: "claude", confidence: 0.5 }),
      row({ engine: "codex", confidence: 0.5 }),
    ]);
    expect(enginesIn(ranked)).toEqual(["claude", "codex", "antigravity"]);
  });

  test("a failed dispatch never outranks a successful one, whatever it reports", () => {
    const ranked = rankRace([
      row({ engine: "codex", ok: false, confidence: 1, tests_run: 9, files_changed: 9 }),
      row({ engine: "claude", ok: true, confidence: 0.1 }),
    ]);
    expect(enginesIn(ranked)).toEqual(["claude", "codex"]);
  });

  test("is total: every entry lands exactly once and the input is not mutated", () => {
    const input = [
      row({ engine: "claude", confidence: 0.2 }),
      row({ engine: "codex", confidence: 0.2 }),
    ];
    const before = [...input];
    const ranked = rankRace(input);
    expect(ranked).toHaveLength(2);
    expect(new Set(enginesIn(ranked)).size).toBe(2);
    expect(input).toEqual(before);
    expect(rankRace([])).toEqual([]);
  });
});
