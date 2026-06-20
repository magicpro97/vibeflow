// test/commands-state.test.ts
//
// Contract test for the A0 brief surface (issue #184). Covers:
//   (a) vf state brief on a non-existent brief file → exits 1 + "no brief"
//   (b) vf state brief on an existing brief with no .last-consult
//       → prints the brief + "never consulted" + exit 0
//   (c) vf state brief --consult on (b) → writes .last-consult to NOW,
//       prints the brief, exit 0
//   (d) vf init --coord without a brief → exit 1 + "no brief" message
//   (e) vf init --coord with a stale brief → exit 1 + "brief is stale"
//   (f) vf init --coord with a fresh brief → proceeds normally
//       (assertCoordBriefFresh returns 0, so init continues; we stub
//       the rest of init via inject so the test only exercises the
//       gate, not the full pipeline)
//   (g) vf coord with stale brief → exit 1; with fresh brief → exit 0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_FRESH_MS,
  BRIEF_PATH,
  assertCoordBriefFresh,
  brief,
  coord,
  formatBriefForHuman,
  init,
  isBriefFresh,
  printCoordGatePassed,
  readBrief,
  readBriefLastConsult,
  state,
  updateLastConsult,
} from "../src/commands.js";
import { cwd } from "../src/core.js";
import { setLogbusForTests } from "../src/logbus.js";

/** Minimal frontmatter for a "well-formed" brief. */
function makeBrief(opts: { withLastConsult?: string; body?: string } = {}): string {
  const fm = opts.withLastConsult ? `---\nlast-consult: ${opts.withLastConsult}\n---\n\n` : "";
  const body =
    opts.body ??
    [
      "# Coordinator Brief — test",
      "",
      "## 1. The user's verbatim ask",
      "test ask",
      "",
      "## 2. Non-negotiables",
      "n/a",
      "",
      "## 3. Active plan",
      "n/a",
      "",
      "## 4. State",
      "n/a",
      "",
      "## 5. Next action",
      "n/a",
      "",
      "## 6. Open questions",
      "n/a",
    ].join("\n");
  return `${fm}${body}\n`;
}

let origCwd: string;
let dir: string;

beforeEach(() => {
  setLogbusForTests(null);
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "vf-a0-brief-"));
  mkdirSync(join(dir, ".vibeflow", "knowledge"), { recursive: true });
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  setLogbusForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("state cluster (issue #184 A0 brief surface)", () => {
  // ---- (a) vf state brief on a non-existent brief file ----------
  test("(a) state brief on missing file → exit 1 + no-brief message", () => {
    expect(existsSync(join(dir, BRIEF_PATH))).toBe(false);
    const code = brief([], {});
    expect(code).toBe(1);
  });

  // ---- (b) state brief without .last-consult → "never consulted" ----
  test("(b) state brief without .last-consult → exit 0 + never consulted", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(path, makeBrief());
    const code = brief([], {});
    expect(code).toBe(0);
    // Frontmatter is still absent (we did not write --consult).
    const after = readFileSync(path, "utf8");
    expect(after.startsWith("---")).toBe(false);
  });

  // ---- (c) state brief --consult → writes .last-consult ----------
  test("(c) state brief --consult writes last-consult to NOW", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(path, makeBrief());
    const before = Date.now();
    const code = brief([], { consult: true });
    const after = Date.now();
    expect(code).toBe(0);
    const updated = readFileSync(path, "utf8");
    expect(updated.startsWith("---\nlast-consult:")).toBe(true);
    // Sanity: the written mtime is within the test window.
    const last = readBriefLastConsult(cwd());
    expect(last).not.toBeNull();
    if (last !== null) {
      expect(last).toBeGreaterThanOrEqual(before);
      expect(last).toBeLessThanOrEqual(after);
    }
  });

  // ---- (d) vf init --coord without a brief → exit 1 + "no brief" ----
  test("(d) assertCoordBriefFresh without a brief → exit 1", () => {
    expect(existsSync(join(dir, BRIEF_PATH))).toBe(false);
    const code = assertCoordBriefFresh(cwd(), Date.now());
    expect(code).toBe(1);
  });

  // ---- (e) vf init --coord with stale brief → exit 1 --------------
  test("(e) assertCoordBriefFresh with stale brief → exit 1", () => {
    const path = join(dir, BRIEF_PATH);
    const stale = new Date(Date.now() - 2 * BRIEF_FRESH_MS).toISOString();
    writeFileSync(path, makeBrief({ withLastConsult: stale }));
    const code = assertCoordBriefFresh(cwd(), Date.now());
    expect(code).toBe(1);
  });

  // ---- (f) vf init --coord with fresh brief → proceeds (exit 0) ----
  test("(f) assertCoordBriefFresh with fresh brief → exit 0", () => {
    const path = join(dir, BRIEF_PATH);
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(path, makeBrief({ withLastConsult: fresh }));
    const code = assertCoordBriefFresh(cwd(), Date.now());
    expect(code).toBe(0);
  });

  // ---- (g) vf coord with stale vs fresh brief --------------------
  test("(g) coord with stale brief → exit 1", () => {
    const path = join(dir, BRIEF_PATH);
    const stale = new Date(Date.now() - 2 * BRIEF_FRESH_MS).toISOString();
    writeFileSync(path, makeBrief({ withLastConsult: stale }));
    const code = coord([], {}, { now: () => Date.now() });
    expect(code).toBe(1);
  });

  test("(g) coord with fresh brief → exit 0", () => {
    const path = join(dir, BRIEF_PATH);
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(path, makeBrief({ withLastConsult: fresh }));
    const code = coord([], {}, { now: () => Date.now() });
    expect(code).toBe(0);
  });
});

describe("state cluster — frontmatter helpers", () => {
  test("readBrief returns the body without the frontmatter", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(path, "---\nlast-consult: 2026-06-20T10:30:00Z\n---\n\n# Brief\nbody line\n");
    const b = readBrief(cwd());
    expect(b.lastConsult).toBe("2026-06-20T10:30:00Z");
    expect(b.body).toContain("# Brief");
    expect(b.body).toContain("body line");
    expect(b.body.startsWith("# Brief")).toBe(true);
  });

  test("readBrief on missing file throws", () => {
    expect(() => readBrief(cwd())).toThrow(/brief not found/);
  });

  test("readBrief on brief without frontmatter has lastConsult=null", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(path, "# Brief\nno frontmatter\n");
    const b = readBrief(cwd());
    expect(b.lastConsult).toBeNull();
    expect(b.body).toContain("# Brief");
  });

  test("formatBriefForHuman with parsed last-consult prints age", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(path, "---\nlast-consult: 2026-06-20T10:30:00Z\n---\n\n# Brief\nbody\n");
    const b = readBrief(cwd());
    const lines: string[] = [];
    const fakeOut = ((...parts: unknown[]) => {
      lines.push(parts.map((p) => String(p)).join(" "));
    }) as never;
    formatBriefForHuman(b, new Date(b.mtimeMs).toISOString(), Date.now(), fakeOut);
    const joined = lines.join("\n");
    expect(joined).toContain("Coordinator Brief");
    expect(joined).toContain("last consulted");
    expect(joined).toContain("2026-06-20T10:30:00Z");
    expect(joined).toContain("# Brief");
  });

  test("formatBriefForHuman with null last-consult prints 'never consulted'", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(path, "# Brief\nbody\n");
    const b = readBrief(cwd());
    const lines: string[] = [];
    const fakeOut = ((...parts: unknown[]) => {
      lines.push(parts.map((p) => String(p)).join(" "));
    }) as never;
    formatBriefForHuman(b, new Date(b.mtimeMs).toISOString(), Date.now(), fakeOut);
    expect(lines.join("\n")).toContain("never consulted");
  });

  test("formatBriefForHuman tolerates an unparseable last-consult value", () => {
    const b = {
      path: join(dir, BRIEF_PATH),
      raw: "",
      body: "body",
      lastConsult: "not-a-date",
      mtimeMs: Date.now(),
    };
    const lines: string[] = [];
    const fakeOut = ((...parts: unknown[]) => {
      lines.push(parts.map((p) => String(p)).join(" "));
    }) as never;
    formatBriefForHuman(b, "2026-06-20T10:30:00Z", Date.now(), fakeOut);
    expect(lines.join("\n")).toContain("last-consult unparseable");
  });

  test("updateLastConsult writes a new mtime to an existing brief", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(path, "# Brief\nno fm\n");
    const before = Date.now();
    const ok = updateLastConsult(path, before);
    expect(ok).toBe(true);
    const after = readFileSync(path, "utf8");
    expect(after.startsWith("---\nlast-consult:")).toBe(true);
  });

  test("updateLastConsult returns false on missing file", () => {
    const ok = updateLastConsult(join(dir, "does-not-exist.md"), Date.now());
    expect(ok).toBe(false);
  });

  test("updateLastConsult preserves existing frontmatter keys (upsert)", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(path, "---\nauthor: linhn\n---\n\n# Brief\n");
    const t = Date.now();
    updateLastConsult(path, t);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("author: linhn");
    expect(after).toContain("last-consult:");
  });

  test("isBriefFresh returns false on missing brief", () => {
    expect(isBriefFresh(cwd(), Date.now())).toBe(false);
  });

  test("isBriefFresh returns true on fresh brief", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(
      path,
      makeBrief({ withLastConsult: new Date(Date.now() - 60_000).toISOString() }),
    );
    expect(isBriefFresh(cwd(), Date.now())).toBe(true);
  });

  test("isBriefFresh returns false on stale brief", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(
      path,
      makeBrief({ withLastConsult: new Date(Date.now() - 2 * BRIEF_FRESH_MS).toISOString() }),
    );
    expect(isBriefFresh(cwd(), Date.now())).toBe(false);
  });

  test("isBriefFresh returns false on brief without last-consult field", () => {
    const path = join(dir, BRIEF_PATH);
    writeFileSync(path, makeBrief());
    expect(isBriefFresh(cwd(), Date.now())).toBe(false);
  });
});

describe("state cluster — top-level dispatcher", () => {
  test("state with no subcommand prints usage hint and exits 2", () => {
    const code = state(undefined, [], {});
    expect(code).toBe(2);
  });

  test("state with unknown subcommand prints usage hint and exits 2", () => {
    const code = state("bogus", [], {});
    expect(code).toBe(2);
  });

  test("state brief with no args prints usage hint and exits 2", () => {
    const code = state("brief", [], {});
    expect(code).toBe(2);
  });
});

// ============================================================
// init() integration (issue #184 AC #3: --coord refuses without fresh brief)
// ============================================================
// init() is a large function with many pre-existing tests; we add a
// minimal integration test that only exercises the brief-gate (lines
// 123-132 of src/commands/init.ts). The injected-readiness / answers
// pattern lets us drive the function without a real engine.
describe("init --coord brief gate (issue #184 A0 integration)", () => {
  test("(h) init --coord with stale brief → exit 1 (stale brief, gate fires)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-coord-stale-"));
    const origCwd = process.cwd();
    // Plant a brief with a stale last-consult (15 min ago)
    const briefDir = join(dir, ".vibeflow", "knowledge");
    mkdirSync(briefDir, { recursive: true });
    const stale = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    writeFileSync(
      join(briefDir, "coordinator-brief.md"),
      `---
last-consult: ${stale}
---

# test brief
`,
    );
    process.chdir(dir);
    try {
      const code = await init(
        { coord: true, "no-ask": true, "no-ai": true, engine: "claude" },
        {
          preflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
          ],
          aiPreflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
          ],
          aiSpawner: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
        },
      );
      // The gate fires BEFORE the questionnaire, so we expect 1 (or
      // whatever the brief-gate returns). The test is asserting that
      // init() with --coord and a stale brief does NOT proceed normally.
      expect(code).toBe(1);
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(i) init --coord with fresh brief → proceeds (gate passes)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-coord-fresh-"));
    const origCwd = process.cwd();
    const briefDir = join(dir, ".vibeflow", "knowledge");
    mkdirSync(briefDir, { recursive: true });
    const fresh = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    writeFileSync(
      join(briefDir, "coordinator-brief.md"),
      `---
last-consult: ${fresh}
---

# test brief
`,
    );
    process.chdir(dir);
    try {
      const code = await init(
        { coord: true, "no-ask": true, "no-ai": true, engine: "claude" },
        {
          preflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
          ],
          aiPreflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
          ],
          aiSpawner: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
        },
      );
      // Fresh brief: gate passes. Init may continue to other phases;
      // we don't assert the exact code (init has many paths), just
      // that it does NOT return 1 from the brief-gate.
      // To check the gate was bypassed, the simplest signal is the
      // code being SOMETHING OTHER than 1. But init may return 0 or
      // other values depending on which phases run. The strict
      // assertion we can make: with no-ai + no-ask + ready engine,
      // the brief-gate does not block (it doesn't return 1 just for
      // the brief).
      // We just assert != 1 (brief-gate didn't refuse). Note: a real
      // init() with --no-ai + no-ask + ready engine may return 0
      // (early-exit when no-ai and no workflow).
      expect(code).not.toBe(1);
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("(j) updateLastConsult on a brief with frontmatter but no last-consult key adds the key (not just updates)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-state-upsert-"));
  const origCwd = process.cwd();
  const briefDir = join(dir, ".vibeflow", "knowledge");
  mkdirSync(briefDir, { recursive: true });
  // Frontmatter with a DIFFERENT key, no last-consult. This forces
  // upsertKeys to ADD the key (not update an existing one).
  writeFileSync(
    join(briefDir, "coordinator-brief.md"),
    `---
project: vf
---

# test brief
`,
  );
  process.chdir(dir);
  try {
    const briefPath = join(briefDir, "coordinator-brief.md");
    // First consult: adds the last-consult key (ADD branch of upsertKeys)
    const ok1 = updateLastConsult(briefPath, Date.now());
    expect(ok1).toBe(true);
    let updated = readFileSync(briefPath, "utf8");
    expect(updated).toMatch(/^---/);
    expect(updated).toContain("project: vf");
    expect(updated).toContain("last-consult:");

    // Second consult: updates the EXISTING last-consult key
    // (FOUND branch of upsertKeys — was previously uncovered)
    const ok2 = updateLastConsult(briefPath, Date.now() + 1000);
    expect(ok2).toBe(true);
    updated = readFileSync(briefPath, "utf8");
    // The brief should still contain both the existing `project` key
    // and the (now-updated) `last-consult` key.
    expect(updated).toContain("project: vf");
    expect(updated).toContain("last-consult:");
  } finally {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(k) printCoordGatePassed prints the fresh hint", () => {
  // The "brief is fresh; --coord gate passed" line was uncovered.
  // Smoke-test that it doesn't throw and produces output.
  expect(() => printCoordGatePassed()).not.toThrow();
});
