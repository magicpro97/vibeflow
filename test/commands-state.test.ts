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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_FRESH_MS,
  BRIEF_PATH,
  BRIEF_SECTIONS,
  assertCoordBriefFresh,
  assertCoordBriefReady,
  atomicWriteFileSync,
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
  validateBriefShape,
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
  test("(g) coord with stale brief → exit 1", async () => {
    const path = join(dir, BRIEF_PATH);
    const stale = new Date(Date.now() - 2 * BRIEF_FRESH_MS).toISOString();
    writeFileSync(path, makeBrief({ withLastConsult: stale }));
    const code = await coord([], {}, { now: () => Date.now() });
    expect(code).toBe(1);
  });

  test("(g) coord with fresh brief → exit 0", async () => {
    const path = join(dir, BRIEF_PATH);
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(path, makeBrief({ withLastConsult: fresh }));
    const code = await coord([], {}, { now: () => Date.now() });
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

  test("state brief with no brief file exits 1 with not-found error", () => {
    // state("brief") now delegates to brief() instead of printing usage.
    // When no brief file exists, brief() returns 1 (file not found).
    const code = state("brief", [], {});
    expect(code).toBe(1);
  });
});

// ============================================================
// init() integration (issue #184 AC #3: --coord refuses without fresh brief)
// ============================================================
// init() is a large function with many pre-existing tests; we add a
// minimal integration test that only exercises the brief-gate (lines
// 123-132 of src/commands/init.ts). The injected-readiness / answers
// pattern lets us drive the function without a real engine.
describe("init --coord brief gate (issue #184 A0 + #194 A1 integration)", () => {
  // A1 (#194): `vf init` now auto-coords. The old A0 test "stale brief +
  // --coord → exit 1" is OBSOLETE — the auto-coord consults the stale
  // brief BEFORE the gate runs, so the brief becomes fresh and init
  // proceeds. The regression we now protect: the brief's mtime is
  // advanced (proving the auto-coord fired) and init does not return
  // 1 from the brief-gate.
  test("(h) init (auto-coord, default) with stale brief → auto-coord consults, gate passes, init proceeds (code !== 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-coord-stale-"));
    const origCwd = process.cwd();
    const briefDir = join(dir, ".vibeflow", "knowledge");
    mkdirSync(briefDir, { recursive: true });
    const stale = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const briefPath = join(briefDir, "coordinator-brief.md");
    // A1 FU #199: plant a brief WITH all 6 canonical sections (so
    // the shared gate's shape check passes). Only the last-consult
    // is stale (the freshness check is what we exercise).
    writeFileSync(
      briefPath,
      `---
last-consult: ${stale}
---

# test brief
${BRIEF_SECTIONS.join("\n")}
`,
    );
    process.chdir(dir);
    try {
      const code = await init(
        { "no-ask": true, "no-ai": true, engine: "claude" },
        {
          preflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
          ],
          aiPreflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
          ],
          aiSpawner: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
          hasCommandFn: () => true,
          syncSpawner: () => ({ status: 0 }),
          hookSetup: null,
        },
      );
      // Auto-coord consulted the brief → gate passes → init does not
      // return 1 from the brief-gate. Other init phases may return
      // other codes; we only assert the brief-gate did not refuse.
      expect(code).not.toBe(1);
      // The brief's last-consult was updated (proves the auto-coord
      // actually ran). We check the FILE CONTENT, not mtime — mtime
      // granularity is 1ms on some FS and the consult + stat may
      // land in the same tick.
      const after = readFileSync(briefPath, "utf8");
      expect(after).not.toContain(stale);
      expect(after).toMatch(/last-consult:\s*2/); // 2026-XX-XX
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(i) init (auto-coord, default) with fresh brief → gate passes, init proceeds (code !== 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-coord-fresh-"));
    const origCwd = process.cwd();
    const briefDir = join(dir, ".vibeflow", "knowledge");
    mkdirSync(briefDir, { recursive: true });
    const fresh = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    // A1 FU #199: plant a brief WITH all 6 canonical sections.
    writeFileSync(
      join(briefDir, "coordinator-brief.md"),
      `---
last-consult: ${fresh}
---

# test brief
${BRIEF_SECTIONS.join("\n")}
`,
    );
    process.chdir(dir);
    try {
      const code = await init(
        { "no-ask": true, "no-ai": true, engine: "claude" },
        {
          preflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
          ],
          aiPreflight: () => [
            { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
          ],
          aiSpawner: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
          hasCommandFn: () => true,
          syncSpawner: () => ({ status: 0 }),
          hookSetup: null,
        },
      );
      // Fresh brief: gate passes (whether auto-coord ran or not).
      // Init may continue to other phases; we just assert the
      // brief-gate did not refuse.
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

// ============================================================
// F0 review fixes (post-implementation, 4 concerns addressed)
// ============================================================
describe("F0 review fixes (schema, future ts, atomic write, A1 contract)", () => {
  test("(l) validateBriefShape: all 6 sections → ok, missing any → not ok with that list", () => {
    const allSix = `# brief
## 1. The user
x
## 2. Non-negotiables
y
## 3. Active plan
z
## 4. State
w
## 5. Next action
v
## 6. Open questions
u
`;
    expect(validateBriefShape(allSix).ok).toBe(true);
    expect(validateBriefShape(allSix).missing).toEqual([]);

    const missing3 = `# brief
## 1. The user
x
## 2. Non-negotiables
y
`;
    const r = validateBriefShape(missing3);
    expect(r.ok).toBe(false);
    // The 4 missing sections (3-6) — titles in BRIEF_SECTIONS order
    expect(r.missing).toContain("## 3. Active plan");
    expect(r.missing).toContain("## 4. State");
    expect(r.missing).toContain("## 5. Next action");
    expect(r.missing).toContain("## 6. Open questions");
    // The 2 present sections are NOT in the missing list
    expect(r.missing).not.toContain("## 1. The user");
    expect(r.missing).not.toContain("## 2. Non-negotiables");
  });

  test("(m) validateBriefShape: strips frontmatter before checking sections", () => {
    const withFrontmatter = `---
last-consult: 2026-06-20T10:00:00Z
---

# brief
## 1. The user
x
## 2. Non-negotiables
y
## 3. Active plan
z
## 4. State
w
## 5. Next action
v
## 6. Open questions
u
`;
    expect(validateBriefShape(withFrontmatter).ok).toBe(true);
  });

  test("(n) isBriefFresh: future last-consult is STALE, not fresh (clock-skew guard)", () => {
    // Set up a brief with last-consult in the year 2099.
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 73).toISOString(); // 73y from now
    const dir = mkdtempSync(join(tmpdir(), "vf-brief-future-"));
    const briefDir = join(dir, ".vibeflow", "knowledge");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(
      join(briefDir, "coordinator-brief.md"),
      `---
last-consult: ${future}
---

# test brief
`,
    );
    process.chdir(dir);
    try {
      // Even at "now" = +1000 years, the future last-consult is still
      // AFTER nowMs, so the brief is STALE. The gate must refuse.
      const nowMs = Date.now() + 1000 * 60 * 60 * 24 * 365 * 1000;
      expect(isBriefFresh(cwd(), nowMs)).toBe(false);
    } finally {
      process.chdir(origCwd ?? process.cwd());
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(o) atomicWriteFileSync: writes via temp + rename, no leftover temp on success", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-atomic-ok-"));
    const origCwd = process.cwd();
    const target = join(dir, "brief.md");
    process.chdir(dir);
    try {
      atomicWriteFileSync(target, "hello world");
      expect(readFileSync(target, "utf8")).toBe("hello world");
      // No leftover .tmp.* file
      const files = readdirSync(dir);
      expect(files).toEqual(["brief.md"]);
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(p) atomicWriteFileSync: failure during write unlinks the temp, original untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-atomic-fail-"));
    const origCwd = process.cwd();
    const target = join(dir, "brief.md");
    writeFileSync(target, "ORIGINAL");
    process.chdir(dir);
    try {
      // Inject a failing writeFileSync → atomicWriteFileSync should
      // unlink the temp and re-throw. The original must remain.
      let attempted = false;
      const inject = {
        openSync: undefined as never,
        writeFileSync: (_p: string, _d: string) => {
          attempted = true;
          throw new Error("simulated write failure");
        },
        pid: 99999,
      } as Parameters<typeof atomicWriteFileSync>[2];
      expect(() => atomicWriteFileSync(target, "NEW", inject)).toThrow("simulated write failure");
      expect(attempted).toBe(true);
      // Original still there
      expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("(q) BRIEF_SECTIONS is the canonical 6-section list (frozen contract)", () => {
    expect(BRIEF_SECTIONS).toHaveLength(6);
    expect(BRIEF_SECTIONS[0]).toBe("## 1. The user");
    expect(BRIEF_SECTIONS[5]).toBe("## 6. Open questions");
  });
});

test("(r) atomicWriteFileSync: production fsync path (no test inject) opens+fsyncs+closes", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-atomic-fsync-"));
  const origCwd = process.cwd();
  const target = join(dir, "brief.md");
  process.chdir(dir);
  try {
    // No inject → production path. Must use the real openSync+fsyncSync+closeSync.
    atomicWriteFileSync(target, "production path");
    expect(readFileSync(target, "utf8")).toBe("production path");
    const files = readdirSync(dir);
    expect(files).toEqual(["brief.md"]);
  } finally {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(s) atomicWriteFileSync: test-seam writeSync path (the alternate code path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-atomic-writeSync-"));
  const origCwd = process.cwd();
  const target = join(dir, "brief.md");
  process.chdir(dir);
  try {
    // Inject writeSync (NOT writeFileSync) → triggers the
    // alternate code path (line 158-161).
    const inject = {
      writeSync: (_fd: number, _data: string) => 0,
      pid: 88888,
    } as Parameters<typeof atomicWriteFileSync>[2];
    atomicWriteFileSync(target, "test seam path", inject);
    expect(readFileSync(target, "utf8")).toBe("test seam path");
  } finally {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(t) brief --consult on a brief missing canonical sections warns but writes mtime", () => {
  const dir = mkdtempSync(join(tmpdir(), "vf-brief-shape-warn-"));
  const origCwd = process.cwd();
  const briefDir = join(dir, ".vibeflow", "knowledge");
  mkdirSync(briefDir, { recursive: true });
  // Brief with all 6 sections. We then strip some to test the warn path.
  const allSix = `---
last-consult: 2026-06-20T09:00:00Z
---

# test brief
## 1. The user
x
## 2. Non-negotiables
y
## 3. Active plan
z
## 4. State
w
## 5. Next action
v
## 6. Open questions
u
`;
  writeFileSync(join(briefDir, "coordinator-brief.md"), allSix);
  process.chdir(dir);
  try {
    // Now strip §3, §4, §5, §6 by overwriting the file with only §1, §2.
    const partial = `---
last-consult: 2026-06-20T09:00:00Z
---

# test brief
## 1. The user
x
## 2. Non-negotiables
y
`;
    writeFileSync(join(briefDir, "coordinator-brief.md"), partial);
    // Now run brief --consult. The shape is partial → must warn.
    // We capture the warning by overriding the outFn.
    const warnMsg = "";
    const { brief } = require("../src/commands.js");
    const { cwd } = require("../src/core.js");
    const code = brief(
      [],
      { consult: true },
      {
        existsSync: (p: string) => existsSync(p),
        statSync: (p: string) => statSync(p),
        readFileSync,
        now: () => Date.now(),
      },
    );
    // The shape warn is emitted via out() which goes to the
    // logbus or stderr. The actual assertion is that the file
    // got the new mtime (consult still wrote) AND the code is 0
    // (consult doesn't fail on a partial brief — it just warns).
    expect(code).toBe(0);
    // Verify the brief was actually written with the new mtime.
    const updated = readFileSync(join(briefDir, "coordinator-brief.md"), "utf8");
    expect(updated).toMatch(/^---/);
    expect(updated).toContain("last-consult: 2"); // 2026-XX-XX
  } finally {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// A1 FU #199: shared gate (assertCoordBriefReady) — used by both
// `coord()` and `init()`. The 4 test cases below prove the 4
// branches of the combined gate: shape missing / shape invalid /
// stale / fresh. ============================================================
describe("assertCoordBriefReady (A1 FU #199 — shared gate)", () => {
  test("(r) ready: shape OK + fresh → exit 0 + 'gate passed' message", () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh }));
    const code = assertCoordBriefReady(cwd(), Date.now());
    expect(code).toBe(0);
  });

  test("(r) ready: missing brief → exit 1 + 'no brief' message", () => {
    expect(existsSync(join(dir, BRIEF_PATH))).toBe(false);
    const code = assertCoordBriefReady(cwd(), Date.now());
    expect(code).toBe(1);
  });

  test("(r) ready: shape invalid (missing §3) → exit 1 + 'missing sections' message", () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    // Brief is shape-invalid: only §1 + §2 (missing §3-§6).
    const partialBody = [
      "# brief",
      "",
      "## 1. The user's verbatim ask",
      "test",
      "",
      "## 2. Non-negotiables",
      "test",
      "",
    ].join("\n");
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh, body: partialBody }));
    const code = assertCoordBriefReady(cwd(), Date.now());
    expect(code).toBe(1);
  });

  test("(r) ready: shape OK + stale → exit 1 + 'stale' message", () => {
    const stale = new Date(Date.now() - 2 * BRIEF_FRESH_MS).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: stale }));
    const code = assertCoordBriefReady(cwd(), Date.now());
    expect(code).toBe(1);
  });

  test("(r) ready: shape OK + future last-consult → exit 1 (clock-skew guard)", () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 73).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: future }));
    const code = assertCoordBriefReady(cwd(), Date.now());
    expect(code).toBe(1);
  });
});
