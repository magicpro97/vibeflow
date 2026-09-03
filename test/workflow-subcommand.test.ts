import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skills, workflow } from "../src/commands.js";

describe("commands.workflow subcommand", () => {
  let origCwd: string;
  beforeEach(() => {
    origCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(origCwd);
  });

  test("workflow delete: no targets returns 0 (line 2700)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-workflow-empty-"));
    try {
      process.chdir(dir);
      expect(workflow("delete", [], { repo: dir })).toBe(0);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  test("workflow import: returns 2 on missing target (line 1840-1844)", () => {
    expect(workflow("import", [], {})).toBe(2);
  });

  test("skills import: returns 2 on missing target (line 1840-1844)", async () => {
    expect(await skills("import", [])).toBe(2);
  });
});
