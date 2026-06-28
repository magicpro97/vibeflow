import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curateSkillsFromEvidence } from "../src/skills/curator.js";

function seedEvidence(dir: string, rows: string[]): void {
  mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
  writeFileSync(
    join(dir, ".vibeflow", "ai-context", "stack-evidence.md"),
    ["| Component | Value |", "|-----------|-------|", ...rows, ""].join("\n"),
  );
}

function seedProfile(dir: string): void {
  mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
  writeFileSync(join(dir, ".vibeflow", "ai-context", "project-profile.json"), '{"x":1}');
}

function seedValidSkill(dir: string, name: string): void {
  const skillDir = join(dir, ".agents", "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      "description: A reusable skill for testing the curator import + sync path.",
      "---",
      "",
      "## Usage",
      "",
      "This skill body contains enough actionable instructions to pass validation cleanly.",
      "",
    ].join("\n"),
  );
}

describe("curator coverage gaps", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-curator-cov-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("matchWhitelist prefix branch: 'Spring Boot Starter' resolves via prefix match", () => {
    seedEvidence(dir, ["| Framework | Spring Boot Starter |"]);
    const result = curateSkillsFromEvidence(dir, "claude", { skipCache: true });
    // Prefix match means it is NOT in the unmatched list.
    expect(result.unmatched).not.toContain("spring boot starter");
  });

  test("empty-components branch writes cache when profile present", () => {
    // Evidence exists but yields zero usable component rows.
    mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
    writeFileSync(
      join(dir, ".vibeflow", "ai-context", "stack-evidence.md"),
      "# Stack evidence\n\nNo table here.\n",
    );
    seedProfile(dir);
    const result = curateSkillsFromEvidence(dir, "claude");
    expect(result.installed).toEqual([]);
    expect(result.unmatched).toEqual([]);
    // Cache entry written for the empty-components inputs.
    const cacheDir = join(dir, ".vibeflow", "cache");
    expect(existsSync(cacheDir)).toBe(true);
  });

  test("cache-hit branch short-circuits and still writes unmatched file", () => {
    seedEvidence(dir, ["| DB | PostgreSQL 16 |"]);
    seedProfile(dir);
    // First call populates the cache (matched > 0, no ctx7 → no install).
    curateSkillsFromEvidence(dir, "claude");
    const unmatchedPath = join(dir, ".vibeflow", "ai-context", "unmatched-tech.txt");
    rmSync(unmatchedPath, { force: true });
    // Second identical call must hit the cache and rewrite the unmatched file.
    const hit = curateSkillsFromEvidence(dir, "claude");
    expect(existsSync(unmatchedPath)).toBe(true);
    expect(Array.isArray(hit.installed)).toBe(true);
  });

  test("sync runs when scratch import yields installed skills", () => {
    seedEvidence(dir, ["| DB | PostgreSQL 16 |"]);
    seedValidSkill(dir, "postgres-skill");
    const result = curateSkillsFromEvidence(dir, "claude", { skipCache: true });
    expect(result.installed).toContain("postgres-skill");
    // Mirror sync produced the canonical skill.
    const canonical = join(dir, ".vibeflow", "skills", "postgres-skill", "SKILL.md");
    expect(existsSync(canonical)).toBe(true);
    expect(readFileSync(canonical, "utf8")).toContain("name: postgres-skill");
  });
});
