// test/commands-plan.test.ts
//
// Contract test for `vf plan <artifact>` (A3 #169).
//
// (a) plan with default engine (codex) + valid dispatch → exit 0
// (b) plan with custom engine (claude) → dispatches to claude
// (c) plan with --out custom path → writes to the custom path
// (d) The output is a real markdown file (not stderr-only)
// (e) The artifact is slugified correctly
// (f) The plan includes the brief's §2 non-negotiables
// (g) The plan handles missing sections gracefully (warn, write what we have)
// (h) plan with no artifact returns 2 (usage error)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_PATH, PLAN_SECTIONS, plan, slugify } from "../src/commands.js";

const PLAN_BODY = `## 1. The artifact
Test artifact for the contract test.

## 2. The proposed changes
- src/foo.ts
- src/bar.ts

## 3. The dependency graph
foo before bar.

## 4. The acceptance criteria
- All tests pass
- Coverage 100%

## 5. The risk register
- Low risk

## 6. The test plan
- Unit tests for the change.
`;

let origCwd: string;
let dir: string;

beforeEach(() => {
  origCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "vf-plan-test-"));
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("vf plan (A3 #169)", () => {
  test("(a) plan with default engine (codex) + valid dispatch → exit 0", async () => {
    const code = await plan(
      ["split commands.ts"],
      {},
      {
        dispatch: async (opts) => {
          expect(opts.engine).toBe("codex");
          return { ok: true, raw: PLAN_BODY };
        },
      },
    );
    expect(code).toBe(0);
    const path = join(dir, ".vibeflow", "plans", "split-commands.ts.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(PLAN_BODY);
  });

  test("(b) plan with --engine claude dispatches to claude", async () => {
    const code = await plan(
      ["refactor coord"],
      { engine: "claude" },
      {
        dispatch: async (opts) => {
          expect(opts.engine).toBe("claude");
          return { ok: true, raw: PLAN_BODY };
        },
      },
    );
    expect(code).toBe(0);
  });

  test("(c) plan with --out writes to the custom path", async () => {
    const custom = join(dir, "my-plan.md");
    const code = await plan(
      ["custom path test"],
      { out: custom },
      {
        dispatch: async () => ({ ok: true, raw: PLAN_BODY }),
      },
    );
    expect(code).toBe(0);
    expect(existsSync(custom)).toBe(true);
    expect(readFileSync(custom, "utf8")).toBe(PLAN_BODY);
  });

  test("(d) the output is a real markdown file (not stderr-only)", async () => {
    const code = await plan(
      ["markdown check"],
      {},
      {
        dispatch: async () => ({ ok: true, raw: PLAN_BODY }),
      },
    );
    expect(code).toBe(0);
    const path = join(dir, ".vibeflow", "plans", "markdown-check.md");
    expect(existsSync(path)).toBe(true);
    // The plan file should have all 6 sections in it (the file is
    // the engine's raw response — we don't re-assemble).
    for (const heading of PLAN_SECTIONS) {
      expect(readFileSync(path, "utf8")).toContain(heading);
    }
  });

  test("(e) the artifact is slugified correctly", () => {
    expect(slugify("Split Commands.ts")).toBe("split-commands.ts");
    expect(slugify("  spaces  in  name  ")).toBe("spaces-in-name");
    expect(slugify("special!@#chars")).toBe("specialchars");
    expect(slugify("a-very-long-name-that-exceeds-the-sixty-character-limit-and-keeps-going")).toBe(
      "a-very-long-name-that-exceeds-the-sixty-character-limit-and",
    );
  });

  test("(f) the plan prompt includes the brief's §2 non-negotiables", async () => {
    // Plant a brief with §2.
    const briefDir = join(dir, ".vibeflow", "knowledge");
    mkdirSync(briefDir, { recursive: true });
    writeFileSync(
      join(briefDir, "coordinator-brief.md"),
      `---
last-consult: 2026-06-20T10:00:00Z
---

# brief
## 1. The user
x

## 2. Non-negotiables
NEVER use the company account by mistake.
ALWAYS use MagicPro97/personal creds.

## 3. Active plan
y
`,
    );
    let capturedPrompt = "";
    const code = await plan(
      ["test brief inclusion"],
      {},
      {
        dispatch: async (opts) => {
          capturedPrompt = opts.prompt;
          return { ok: true, raw: PLAN_BODY };
        },
      },
    );
    expect(code).toBe(0);
    expect(capturedPrompt).toContain("NEVER use the company account by mistake");
    expect(capturedPrompt).toContain("ALWAYS use MagicPro97/personal creds");
  });

  test("(g) the plan handles missing sections gracefully (warn, write what we have)", async () => {
    const partialBody = `## 1. The artifact
partial

## 4. The acceptance criteria
- only this section
`;
    const code = await plan(
      ["partial plan"],
      {},
      {
        dispatch: async () => ({ ok: true, raw: partialBody }),
      },
    );
    // exit 0 (the plan was written, even if incomplete) — the
    // coordinator decides what to do next.
    expect(code).toBe(0);
    const path = join(dir, ".vibeflow", "plans", "partial-plan.md");
    expect(existsSync(path)).toBe(true);
  });

  test("(h) plan with no artifact returns 2 (usage error)", async () => {
    const code = await plan(
      [],
      {},
      {
        dispatch: async () => ({ ok: true, raw: PLAN_BODY }),
      },
    );
    expect(code).toBe(2);
  });

  test("(dispatch-fail) plan returns 1 when the engine fails", async () => {
    const code = await plan(
      ["test fail"],
      {},
      {
        dispatch: async () => ({ ok: false, raw: "", reason: "engine unavailable" }),
      },
    );
    expect(code).toBe(1);
  });

  test("(no-brief) plan works when no brief exists (no §2 in prompt)", async () => {
    expect(existsSync(join(dir, BRIEF_PATH))).toBe(false);
    let capturedPrompt = "";
    const code = await plan(
      ["no brief test"],
      {},
      {
        dispatch: async (opts) => {
          capturedPrompt = opts.prompt;
          return { ok: true, raw: PLAN_BODY };
        },
      },
    );
    expect(code).toBe(0);
    expect(capturedPrompt).toContain("no brief");
  });

  // ---- No dispatch inject → exit 1 (the production engine dispatcher
  //      must be wired before the plan command can do real work) ----
  test("(no-dispatch) plan returns 1 when no dispatch is injected", async () => {
    const code = await plan(["missing dispatch"], {}, {});
    expect(code).toBe(1);
  });
});
