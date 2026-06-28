import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedClaudeCode } from "../../src/commands/init/artifacts.js";

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-artifacts-"));
  // Seed minimal package.json so detectToolchain resolves to npm/bun
  writeFileSync(join(dir, "package.json"), '{"scripts":{"test":"bun test"}}');
  return dir;
}

describe("seedClaudeCode", () => {
  test("creates .claude/rules/coding-conventions.md", () => {
    const dir = tmpRepo();
    try {
      const written = seedClaudeCode(dir, ["claude"], false);
      expect(written).toContain(".claude/rules/coding-conventions.md");
      expect(existsSync(join(dir, ".claude", "rules", "coding-conventions.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates .claude/CLAUDE.md with runner from toolchain", () => {
    const dir = tmpRepo();
    try {
      seedClaudeCode(dir, ["claude"], false);
      const content = readFileSync(join(dir, ".claude", "CLAUDE.md"), "utf8");
      expect(content).toContain("bun run test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips when claude not in engines", () => {
    const dir = tmpRepo();
    try {
      const written = seedClaudeCode(dir, ["codex"], false);
      expect(written).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not clobber existing files", () => {
    const dir = tmpRepo();
    try {
      // Pre-create .claude/CLAUDE.md with custom content
      const claudeDir = join(dir, ".claude");
      const claudeMdPath = join(claudeDir, "CLAUDE.md");
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(claudeMdPath, "# custom", { encoding: "utf8" });
      seedClaudeCode(dir, ["claude"], false);
      expect(readFileSync(claudeMdPath, "utf8")).toBe("# custom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
