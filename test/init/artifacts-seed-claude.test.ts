import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedClaudeCode } from "../../src/commands/init/artifacts.js";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-seed-claude-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    '{"scripts":{"test":"bun test","lint":"biome check","build":"tsc"}}',
  );
  return dir;
}

describe("seedClaudeCode", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpRepo();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates .claude/rules/coding-conventions.md", () => {
    const written = seedClaudeCode(dir, ["claude"], false);
    expect(written).toContain(".claude/rules/coding-conventions.md");
    expect(existsSync(join(dir, ".claude", "rules", "coding-conventions.md"))).toBe(true);
    const content = readFileSync(join(dir, ".claude", "rules", "coding-conventions.md"), "utf8");
    expect(content).toContain("TDD");
  });

  test("creates .claude/CLAUDE.md with runner from toolchain", () => {
    const written = seedClaudeCode(dir, ["claude"], false);
    expect(written).toContain(".claude/CLAUDE.md");
    const content = readFileSync(join(dir, ".claude", "CLAUDE.md"), "utf8");
    expect(content).toContain("bun run test");
    expect(content).toContain("coding-conventions.md");
  });

  test("skips when claude not in engines", () => {
    const written = seedClaudeCode(dir, ["codex"], false);
    expect(written).toEqual([]);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  test("does not clobber existing files", () => {
    mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
    writeFileSync(join(dir, ".claude", "CLAUDE.md"), "# custom project docs");
    writeFileSync(join(dir, ".claude", "rules", "coding-conventions.md"), "# custom rules");
    const written = seedClaudeCode(dir, ["claude"], false);
    expect(written).toEqual([]);
    expect(readFileSync(join(dir, ".claude", "CLAUDE.md"), "utf8")).toBe("# custom project docs");
    expect(readFileSync(join(dir, ".claude", "rules", "coding-conventions.md"), "utf8")).toBe(
      "# custom rules",
    );
  });

  test("dry run does not write files", () => {
    const written = seedClaudeCode(dir, ["claude"], true);
    expect(written).toEqual([]);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });
});
