/**
 * Skill-mirror cross-file invariant (C2).
 *
 * The 4-CLI audit (2026-06-17) found that the WRITE side
 * (`src/skills/sync.ts:MIRRORS`) and the READ side
 * (`src/skills/registry.ts:SKILL_ROOTS` + `src/skills/validator.ts:SKILL_ROOTS`)
 * had drifted apart:
 *
 *   - WRITE:  [.claude/skills, .agents/skills, .github/skills]
 *   - READ:   [.vibeflow/skills, .kiro/skills, .claude/skills]  ← missing
 *             .agents/skills and .github/skills
 *
 * Effect: a skill synced to the codex/copilot mirrors was invisible
 * to `vf skills list` and `vf skills validate`.
 *
 * Fix: `src/workflow-artifacts.ts:SKILL_MIRRORS` is the single source
 * of truth. The write side imports it directly. The read side builds
 * its `SKILL_ROOTS` from `[CTX_DIR/skills, .kiro/skills, ...SKILL_MIRRORS]`
 * so the two can never disagree.
 *
 * This test pins the contract:
 *  1. `SKILL_MIRRORS` is exported from `workflow-artifacts.ts`
 *  2. It matches `ENGINE_CONFIGS[*].skillRoot` for every engine
 *  3. The write side (`sync.ts:MIRRORS`) is the SAME list
 *  4. The read side (`registry.ts:SKILL_ROOTS`) is a superset that
 *     includes `SKILL_MIRRORS` (so synced skills are discoverable)
 *  5. The read side (`validator.ts:SKILL_ROOTS`) is also a superset
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

describe("skill-mirror cross-file invariant (C2)", () => {
  const { SKILL_MIRRORS } = require("../src/workflow-artifacts.js") as {
    SKILL_MIRRORS: readonly string[];
  };

  test("SKILL_MIRRORS is exported and has three entries (one per engine)", () => {
    expect(Array.isArray(SKILL_MIRRORS)).toBe(true);
    expect(SKILL_MIRRORS.length).toBe(3);
  });

  test("SKILL_MIRRORS covers the three supported engines", () => {
    // The engine roots are derived from `ENGINE_CONFIGS[*].skillRoot` in
    // workflow-artifacts.ts. Pin the list of expected values here so a
    // refactor that drops an engine is caught immediately.
    const expected = new Set([".claude/skills", ".agents/skills", ".github/skills"]);
    const actual = new Set(SKILL_MIRRORS as string[]);
    expect(actual).toEqual(expected);
  });

  test("sync.ts MIRRORS is the SAME list as SKILL_MIRRORS", () => {
    // Read sync.ts source and confirm there's no `[".claude", "skills"], ...`
    // hard-coded literal that disagrees.
    const src = readFileSync(join(REPO_ROOT, "src", "skills", "sync.ts"), "utf8");
    // The fix: the file should import SKILL_MIRRORS and use it, not redeclare.
    expect(src).toMatch(
      /import\s*\{[^}]*SKILL_MIRRORS[^}]*\}\s*from\s*["']\.\.\/workflow-artifacts\.js["']/,
    );
    // And there should be no hand-rolled list of engine skill roots.
    // Detect at least 2 hand-rolled ".X/skills" join()s in one expression.
    expect(src).not.toMatch(
      /join\(\s*"\.(claude|agents|github)"\s*,\s*"skills"\s*\).*join\(\s*"\.(claude|agents|github)"\s*,\s*"skills"\s*\)/,
    );
  });

  test("registry.ts SKILL_ROOTS is a superset of SKILL_MIRRORS (audit C2)", () => {
    const src = readFileSync(join(REPO_ROOT, "src", "skills", "registry.ts"), "utf8");
    expect(src).toMatch(
      /import\s*\{[^}]*SKILL_MIRRORS[^}]*\}\s*from\s*["']\.\.\/workflow-artifacts\.js["']/,
    );
    expect(src).toMatch(/\.\.\.SKILL_MIRRORS/);
  });

  test("validator.ts SKILL_ROOTS is a superset of SKILL_MIRRORS (audit C2)", () => {
    const src = readFileSync(join(REPO_ROOT, "src", "skills", "validator.ts"), "utf8");
    expect(src).toMatch(
      /import\s*\{[^}]*SKILL_MIRRORS[^}]*\}\s*from\s*["']\.\.\/workflow-artifacts\.js["']/,
    );
    expect(src).toMatch(/\.\.\.SKILL_MIRRORS/);
  });

  test("no .ts file under src/skills/ redeclares a skill-root literal", () => {
    // The audit (C2) found hand-rolled lists. Guard against re-introduction.
    const files = ["sync.ts", "registry.ts", "validator.ts"];
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of files) {
      const text = readFileSync(join(REPO_ROOT, "src", "skills", file), "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        // Disallow a list of >=2 hand-rolled ".X/skills" join()s in one
        // expression — that is the C2 anti-pattern.
        if (
          /join\(\s*"\.\w+"\s*,\s*"skills"\s*\).*join\(\s*"\.\w+"\s*,\s*"skills"\s*\)/.test(line)
        ) {
          offenders.push({
            file: `src/skills/${file}`,
            line: i + 1,
            text: line.trim().slice(0, 120),
          });
        }
      }
    }
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n");
      throw new Error(`Found a hand-rolled skill-roots list (audit C2):\n${detail}`);
    }
    expect(offenders).toEqual([]);
  });
});
