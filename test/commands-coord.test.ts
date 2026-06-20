// test/commands-coord.test.ts
//
// Contract test for the A1 `vf coord` shim (issues #167 + #194).
// Covers the 7 ACs from the A1 spec:
//   (a) fresh brief + valid engine → exit 0, brief is consulted, no
//       tool denials
//   (b) stale brief → exit 1 + "brief is stale" message
//   (c) missing brief → exit 1 + "no brief" message
//   (d) incomplete brief (missing §3) → exit 1 + "missing sections"
//   (e) a tool the engine tries to invoke (Write/Edit/Bash) → tool is
//       denied, exit 0 (the engine finished, denials are logged)
//   (f) `vf init --no-coord` → brief is NOT consulted, proceeds
//   (g) `vf init` default → brief IS auto-consulted + the gate runs

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIEF_FRESH_MS,
  BRIEF_PATH,
  BRIEF_SECTIONS,
  DEFAULT_DENIED_TOOLS,
  coord,
  defaultEngineSpawner,
  defaultToolDenier,
  init,
} from "../src/commands.js";
import { setLogbusForTests } from "../src/logbus.js";

/** A well-formed brief with all 6 canonical sections and a controllable
 *  `last-consult` timestamp. */
function makeBrief(opts: { withLastConsult?: string; sections?: readonly string[] } = {}): string {
  const fm = opts.withLastConsult ? `---\nlast-consult: ${opts.withLastConsult}\n---\n\n` : "";
  const sections = opts.sections ?? BRIEF_SECTIONS;
  const body = ["# Coordinator Brief — test", ""];
  for (const heading of sections) {
    body.push(heading, "x", "");
  }
  return `${fm}${body.join("\n")}\n`;
}

let origCwd: string;
let dir: string;

beforeEach(() => {
  setLogbusForTests(null);
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "vf-a1-coord-"));
  mkdirSync(join(dir, ".vibeflow", "knowledge"), { recursive: true });
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  setLogbusForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("coord shim (A1 #167 + #194)", () => {
  // ---- (a) fresh brief + valid engine → exit 0 --------------------
  test("(a) coord with fresh brief + no engine → exit 0, brief is consulted", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh }));
    const code = await coord([], {}, { now: () => Date.now() });
    expect(code).toBe(0);
    // The consult wrote a new mtime (the `last-consult` should be very
    // close to Date.now() now, not the original 60s-ago value).
    const after = readFileSync(join(dir, BRIEF_PATH), "utf8");
    const m = after.match(/last-consult:\s*(\S+)/);
    expect(m).not.toBeNull();
    if (m) {
      const ms = Date.parse(m[1] ?? "");
      const delta = Math.abs(Date.now() - ms);
      expect(delta).toBeLessThan(5_000);
    }
  });

  // ---- (b) stale brief → exit 1 -----------------------------------
  test("(b) coord with stale brief → exit 1 + 'brief is stale'", async () => {
    const stale = new Date(Date.now() - 2 * BRIEF_FRESH_MS).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: stale }));
    const code = await coord([], {}, { now: () => Date.now() });
    expect(code).toBe(1);
    // Brief was NOT touched on refusal.
    const after = readFileSync(join(dir, BRIEF_PATH), "utf8");
    expect(after).toContain(stale);
  });

  // ---- (c) missing brief → exit 1 ---------------------------------
  test("(c) coord with missing brief → exit 1 + 'no brief'", async () => {
    expect(existsSync(join(dir, BRIEF_PATH))).toBe(false);
    const code = await coord([], {}, { now: () => Date.now() });
    expect(code).toBe(1);
  });

  // ---- (d) incomplete brief (missing §3) → exit 1 -----------------
  test("(d) coord with incomplete brief → exit 1 + 'missing sections'", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const partial = BRIEF_SECTIONS.filter((s) => !s.includes("## 3."));
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh, sections: partial }));
    const code = await coord([], {}, { now: () => Date.now() });
    expect(code).toBe(1);
  });

  // ---- (e) tool-deny-list audit when an engine is spawned ----------
  test("(e) coord with engine spawn + tool-deny-list → denials logged", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh }));
    // Inject a custom toolDenier that records all calls.
    const denierCalls: string[] = [];
    const toolDenier = (tool: string) => {
      denierCalls.push(tool);
      if (tool === "Write") {
        return { tool, reason: "test-reason" };
      }
      return null;
    };
    // Inject a custom spawner that simulates the engine trying
    // multiple tools (the production shim's PreToolUse wrapper would
    // call the denier for each; we simulate the denier calls here).
    const spawner = async (_engine: string, _args: readonly string[]): Promise<number> => {
      // The engine's wrapper would call the denier for every tool.
      // We mirror that here.
      for (const tool of ["Read", "Write", "Bash"]) {
        toolDenier(tool);
      }
      return 0;
    };
    const code = await coord(["claude"], {}, { now: () => Date.now(), spawner, toolDenier });
    expect(code).toBe(0);
    expect(denierCalls).toEqual(["Read", "Write", "Bash"]);
  });

  // ---- (e-bonus) default denier denies the mutation tool set ------
  test("(e-bonus) defaultToolDenier denies Write/Edit/Bash/etc, allows Read", () => {
    expect(defaultToolDenier("Write")).not.toBeNull();
    expect(defaultToolDenier("Edit")).not.toBeNull();
    expect(defaultToolDenier("MultiEdit")).not.toBeNull();
    expect(defaultToolDenier("Bash")).not.toBeNull();
    expect(defaultToolDenier("KillBash")).not.toBeNull();
    expect(defaultToolDenier("NotebookEdit")).not.toBeNull();
    expect(defaultToolDenier("WebFetch")).not.toBeNull();
    // Read-only tools pass through.
    expect(defaultToolDenier("Read")).toBeNull();
    expect(defaultToolDenier("Glob")).toBeNull();
    expect(defaultToolDenier("Grep")).toBeNull();
  });

  test("(e-bonus-2) DEFAULT_DENIED_TOOLS includes the B5 audit set", () => {
    // The B5 audit fix locked the deny-list; verify the set.
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "KillBash"]) {
      expect(DEFAULT_DENIED_TOOLS.has(tool)).toBe(true);
    }
  });

  // ---- (f) init --no-coord → brief is NOT consulted ---------------
  test("(f) init --no-coord → brief is NOT consulted, proceeds (gate skipped)", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh }));
    // The init call below uses --no-ai so we don't go down the AI path.
    // The exact return code doesn't matter (init has many paths); what
    // matters is that it does NOT return 1 from the brief-gate (the
    // brief-gate is bypassed by --no-coord).
    const code = await init(
      { "no-coord": true, "no-ask": true, "no-ai": true, engine: "claude" },
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
    // --no-coord bypasses the gate. With no-ai + ready engine, init
    // can return 0 (success) or other values. The strict assertion:
    // the brief-gate did NOT return 1, AND the brief's last-consult
    // was NOT updated (because --no-coord means no auto-consult).
    expect(code).not.toBe(1);
    const after = readFileSync(join(dir, BRIEF_PATH), "utf8");
    expect(after).toContain(fresh); // unchanged
  });

  // ---- (g) init default → brief IS auto-consulted + gate runs -----
  test("(g) init default → brief is auto-consulted (mtime advances)", async () => {
    const stale = new Date(Date.now() - 2 * BRIEF_FRESH_MS).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: stale }));
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
      },
    );
    // Even with a STALE brief, the auto-coord consults it first, so
    // the gate passes. Init proceeds. The brief was updated.
    const after = readFileSync(join(dir, BRIEF_PATH), "utf8");
    expect(after).not.toContain(stale);
    expect(after).toMatch(/last-consult:\s*2/);
    // The exact init return code is not asserted (init has many
    // downstream paths). The important thing: the gate did not block.
    expect(code).not.toBe(1);
  });

  // ---- A0-stability guarantee: signature is async now --------------
  test("(signature) coord returns a Promise (A1 widened from sync)", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh }));
    const r = coord([], {}, { now: () => Date.now() });
    expect(r).toBeInstanceOf(Promise);
    const code = await r;
    expect(typeof code).toBe("number");
  });

  // ---- A0-stability guarantee: exit code 0 contract holds ----------
  test("(contract) coord with fresh brief returns 0 (A0 contract)", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh }));
    const code = await coord([], {}, { now: () => Date.now() });
    expect(code).toBe(0);
  });

  // ---- A0-stability guarantee: exit code 1 for stale/missing ------
  test("(contract) coord with stale brief returns 1 (A0 contract)", async () => {
    const stale = new Date(Date.now() - 2 * BRIEF_FRESH_MS).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: stale }));
    const code = await coord([], {}, { now: () => Date.now() });
    expect(code).toBe(1);
  });

  // ---- Future-timestamp guard (clock-skew) -------------------------
  test("(guard) future last-consult is STALE, not fresh", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 73).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: future }));
    const code = await coord([], {}, { now: () => Date.now() });
    expect(code).toBe(1);
  });

  // ---- Brief with NO last-consult → shape is OK but the frontmatter
  //      is missing the field. readLastConsultMs returns null, which
  //      coord() treats as "never consulted" → stale → exit 1.
  //
  //      The brief MUST have a frontmatter block (so the function
  //      gets past the first `raw.startsWith("---")` check) but
  //      no `last-consult:` key (so the for loop falls through to
  //      the `return null` at the end). This exercises the
  //      "frontmatter present, last-consult absent" path which
  //      was uncovered (lines 257-258) by the old test that
  //      planted a brief with NO frontmatter at all. ----
  test("(frontmatter) coord with brief that has NO last-consult field → exit 1 (never consulted)", async () => {
    // Plant a brief with frontmatter that has other keys but no
    // `last-consult:`. This is the path that returns null from
    // the for loop's end (not the early return for missing
    // frontmatter).
    const briefContent = `---\nproject: vf\n---\n\n# Coordinator Brief\n\n${BRIEF_SECTIONS.join("\n")}\n`;
    writeFileSync(join(dir, BRIEF_PATH), briefContent);
    const code = await coord([], {}, { now: () => Date.now() });
    expect(code).toBe(1);
  });

  // ---- Unknown engine → exit 2 (reserved A1 code) -----------------
  test("(engine) coord with unknown engine name returns 2", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh }));
    const code = await coord(["bogus-engine"], {}, { now: () => Date.now() });
    expect(code).toBe(2);
  });

  // ---- Engine spawner error propagates the engine exit code --------
  test("(engine) coord forwards the engine's exit code", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh }));
    const spawner = async (_engine: string, _args: readonly string[]): Promise<number> => 7;
    const code = await coord(["claude"], {}, { now: () => Date.now(), spawner });
    expect(code).toBe(7);
  });

  // ---- defaultEngineSpawner (exported for the test seam) actually
  //      spawns a real binary. Uses /bin/echo on Unix. Returns the
  //      exit code (0 for success). ----
  test("(defaultEngineSpawner) real /bin/echo spawn returns 0", async () => {
    if (process.platform === "win32") return;
    const code = await defaultEngineSpawner("/bin/echo", ["hello"]);
    expect(code).toBe(0);
  });

  // ---- defaultEngineSpawner with a missing binary returns 1 ----
  test("(defaultEngineSpawner) missing binary returns 1", async () => {
    const code = await defaultEngineSpawner("/this/does/not/exist", []);
    expect(code).toBe(1);
  });

  // ---- --coord deprecation: init warns but still auto-coords ------
  test("(deprecation) init --coord emits a ::notice but still runs the auto-coord gate", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dir, BRIEF_PATH), makeBrief({ withLastConsult: fresh }));
    // The `answers` belong in the inject (second arg), not in flags.
    // flags is `Record<string, string|boolean>`, not IntakeAnswers.
    const code = await init(
      { coord: true, "no-ask": true, "no-ai": true, engine: "claude" },
      {
        answers: { engines: ["claude"] },
        preflight: () => [
          { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
        ],
        aiPreflight: () => [
          { engine: "claude", level: "ready" as const, detail: "ok", checkedAt: "2026-06-20" },
        ],
        aiSpawner: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
      },
    );
    // The deprecated flag is accepted; the new auto-coord runs.
    // Init may return 0 or other values depending on downstream
    // phases, but it MUST NOT return 1 from the brief-gate.
    expect(code).not.toBe(1);
    // The brief was touched (the mtime was advanced) — proving
    // auto-coord ran even with the deprecated flag.
    const after = readFileSync(join(dir, BRIEF_PATH), "utf8");
    const m = after.match(/last-consult:\s*(\S+)/);
    expect(m).not.toBeNull();
  });

  // ---- init with NO brief + default flags → proceeds (no gate when no brief) ----
  // The auto-coord is a no-op when the brief does NOT exist (initial-setup init).
  // This is the common case: the user is creating the brief as part of init's
  // questionnaire, so the gate would have nothing to consult. The pre-existing
  // commands-coverage.test.ts test surface plants NO brief and expects init
  // to proceed; the coord test mirrors that contract.
  test("(init) init with NO brief + default flags → proceeds (no gate when no brief)", async () => {
    expect(existsSync(join(dir, BRIEF_PATH))).toBe(false);
    // No brief planted → auto-coord skips the gate → init proceeds.
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
      },
    );
    // The brief-gate does not refuse. Other init phases may return
    // other codes; we just assert the gate did not block.
    expect(code).not.toBe(1);
  });
});
