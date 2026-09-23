// #555 UI tests for the race surface. Pure-TS, DOM-free source assertions
// (mirrors registry-release-ui-760.test.ts / skill-registry-ui-688.test.ts):
// the data layer (api.ts / store-race.ts / store.ts) and the Stage 3 component
// are pinned by structural invariants — the ranking rule itself is tested in
// test/orchestrator-race.test.ts and the route in test/server-race-555.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../src/ui/src/${p}`, import.meta.url), "utf8");

describe("api.ts: the race endpoint", () => {
  const src = read("api.ts");

  test("POSTs the task + engines to /api/race", () => {
    expect(src).toContain("race: (payload: { task: string; engines?: string[]; dry?: boolean })");
    expect(src).toContain('req<RaceViewResponse>("POST", "/api/race", payload)');
  });

  test("models the ranked row the table renders (no untyped payload)", () => {
    const start = src.indexOf("interface RaceResultRow");
    const slice = start < 0 ? "" : src.slice(start, start + 400);
    for (const field of [
      "engine: string",
      "ok: boolean",
      "confidence: number",
      "tests_run: number",
      "files_changed: number",
      "branch: string",
      "worktree: string",
      "reason?: string",
    ]) {
      expect(slice).toContain(field);
    }
    expect(src).toContain("interface RaceViewResponse");
    expect(src).toContain("skipped: Array<{ engine: string; reason: string }>");
  });
});

describe("store-race.ts: race state + action", () => {
  const src = read("store-race.ts");

  test("exposes the state the Stage 3 table reads", () => {
    for (const name of ["raceRunning", "raceRanking", "raceSkipped", "raceError", "runRace"]) {
      expect(src).toContain(name);
    }
  });

  test("goes through api.race and clears stale rows on failure", () => {
    expect(src).toContain("api.race(");
    expect(src).toContain("raceRanking.value = result.ranking");
    expect(src).toContain("raceSkipped.value = result.skipped");
    expect(src).toContain("raceRanking.value = []");
    expect(src).toContain(".slice(0, 120)");
  });

  test("is local-first: it never merges or writes anything", () => {
    // Comments may (and do) name the no-merge contract; the CODE must not merge.
    const code = src.replace(/\/\/.*$/gm, "");
    expect(/merge|rm -rf|push|commit/i.test(code)).toBe(false);
  });
});

describe("store.ts: wires the race state", () => {
  const src = read("store.ts");

  test("spreads the race state into the store", () => {
    expect(src).toContain("createRaceState");
    expect(src).toContain("...raceState");
  });
});

describe("Stage3Orchestrate.vue: race control + ranked table", () => {
  const src = read("components/Stage3Orchestrate.vue");

  test("offers a race control wired to the store action", () => {
    expect(src).toContain('id="race-panel"');
    expect(src).toContain('id="race-engines-button"');
    expect(src).toContain('@click="raceEngines"');
    expect(src).toContain("store.runRace(");
    expect(src).toContain("raceSelection");
  });

  test("selects engines from the canonical ENGINES list", () => {
    expect(src).toContain('v-for="candidate in ENGINES"');
    expect(src).toContain("toggleRaceEngine(candidate)");
  });

  test("renders the ranked rows with confidence + the winner branch", () => {
    expect(src).toContain("store.raceRanking");
    expect(src).toContain("row.confidence");
    expect(src).toContain("row.branch");
    expect(src).toContain("row.tests_run");
    expect(src).toContain("row.files_changed");
  });

  test("states the no-auto-merge contract and shows skipped engines", () => {
    expect(src).toContain("no auto-merge");
    expect(src).toContain("review, then merge it yourself");
    expect(src).toContain("store.raceSkipped");
  });

  test("surfaces failures accessibly and makes no write call of its own", () => {
    expect(src).toContain('role="alert"');
    expect(src).toContain("store.raceError");
    // The component never calls the write API directly — the store/route owns dispatch.
    expect(src).not.toContain("api.race(");
  });
});
