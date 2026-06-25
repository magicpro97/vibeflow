// test/auto-crystallize.test.ts
//
// issue #335: autoCrystallizeRun reads a run's log + journal, crystallizes,
// and writes a DRAFT skill only when patterns cross threshold AND no draft
// exists. FS is injected so these tests touch no real tree.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CTX_DIR } from "../src/core.js";
import { autoCrystallizeRun } from "../src/skills/auto-crystallize.js";

const BASE = "/tmp/vf-acz";
const LOG = join(BASE, CTX_DIR, "logs", "current.log");
const JOURNAL = join(BASE, CTX_DIR, "knowledge", "log.md");

/** Build an injected FS whose files map drives existsSync/readFileSync, and
 *  whose writes are captured for assertion. */
function fakeFs(files: Record<string, string>) {
  const writes: Array<{ path: string; content: string }> = [];
  return {
    writes,
    inject: {
      existsSync: (p: string) => p in files,
      readFileSync: (p: string, _enc: string) => files[p] ?? "",
      writeFileSafe: (p: string, c: string) => {
        writes.push({ path: p, content: c });
        files[p] = c; // subsequent existsSync sees it
      },
    },
  };
}

describe("autoCrystallizeRun", () => {
  test("drafts a skill when commands cross the threshold", () => {
    const { writes, inject } = fakeFs({
      [LOG]: ['$ git commit -m "a"', '$ git commit -m "b"', '$ git commit -m "c"'].join("\n"),
    });
    const r = autoCrystallizeRun(BASE, "run-x", inject);
    expect(r.drafted).toBe(true);
    expect(r.patternCount).toBeGreaterThan(0);
    expect(r.draftName).toBeTruthy();
    expect(r.draftPath).toContain(`${CTX_DIR}/skills/`);
    // wrote exactly one SKILL.md, and it carries the crystallized draft
    expect(writes).toHaveLength(1);
    expect(writes[0]?.content).toContain("## Repeated commands");
  });

  test("skips when no patterns cross the threshold", () => {
    const { writes, inject } = fakeFs({
      [LOG]: "$ ls\nnothing repeats here\n",
    });
    const r = autoCrystallizeRun(BASE, "run-y", inject);
    expect(r.drafted).toBe(false);
    expect(r.skipped).toBe("no-patterns");
    expect(r.patternCount).toBe(0);
    expect(writes).toHaveLength(0);
  });

  test("skips when a draft already exists (no overwrite)", () => {
    // Pre-seed the draft path so existsSync(draftPath) is true.
    const log = ['$ git commit -m "a"', '$ git commit -m "b"', '$ git commit -m "c"'].join("\n");
    // draftName is `crystallized-<slug>`; compute via a first dry call.
    const probe = fakeFs({ [LOG]: log });
    const first = autoCrystallizeRun(BASE, "run-z", probe.inject);
    expect(first.drafted).toBe(true);
    const draftPath = first.draftPath as string;

    const { writes, inject } = fakeFs({ [LOG]: log, [draftPath]: "# existing draft" });
    const r = autoCrystallizeRun(BASE, "run-z", inject);
    expect(r.drafted).toBe(false);
    expect(r.skipped).toBe("exists");
    expect(r.draftName).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  test("reads patterns split across both log and journal", () => {
    const { inject } = fakeFs({
      [LOG]: ['$ git commit -m "a"', '$ git commit -m "b"'].join("\n"),
      [JOURNAL]: ['$ git commit -m "c"'].join("\n"),
    });
    const r = autoCrystallizeRun(BASE, "run-split", inject);
    expect(r.drafted).toBe(true); // 2 + 1 = 3 ≥ command threshold
  });

  test("missing log + journal files → no-patterns, no throw", () => {
    const { writes, inject } = fakeFs({}); // existsSync always false
    const r = autoCrystallizeRun(BASE, "run-empty", inject);
    expect(r.drafted).toBe(false);
    expect(r.skipped).toBe("no-patterns");
    expect(writes).toHaveLength(0);
  });
});
