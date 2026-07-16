import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MigrateResult,
  migrateToSharedCatalog,
  sharedCatalogDir,
  sharedSkillNames,
} from "../src/skills/catalog";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("sharedCatalogDir", () => {
  test("creates ~/.vibeflow/skills/ when missing", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-cat-home-"));
    dirs.push(tmpHome);
    const result = sharedCatalogDir({ homedir: () => tmpHome });
    expect(result).toBe(join(tmpHome, ".vibeflow", "skills"));
    expect(existsSync(result)).toBe(true);
  });

  test("respects injected homedir", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-cat-inject-"));
    dirs.push(tmpHome);
    const dir = sharedCatalogDir({ homedir: () => tmpHome });
    expect(dir.startsWith(tmpHome)).toBe(true);
  });

  test("returns existing dir without error on second call", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-cat-exist-"));
    dirs.push(tmpHome);
    const inject = { homedir: () => tmpHome };
    sharedCatalogDir(inject);
    const second = sharedCatalogDir(inject);
    expect(existsSync(second)).toBe(true);
  });
});

describe("sharedSkillNames", () => {
  test("lists skill directories", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-cat-names-"));
    dirs.push(tmpHome);
    const inject = { homedir: () => tmpHome };
    const catalog = sharedCatalogDir(inject);
    mkdirSync(join(catalog, "alpha"));
    mkdirSync(join(catalog, "beta"));
    const names = sharedSkillNames(inject);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names.length).toBe(2);
  });

  test("skips dotfiles", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-cat-dot-"));
    dirs.push(tmpHome);
    const inject = { homedir: () => tmpHome };
    const catalog = sharedCatalogDir(inject);
    mkdirSync(join(catalog, ".backup"));
    mkdirSync(join(catalog, "visible"));
    const names = sharedSkillNames(inject);
    expect(names).toEqual(["visible"]);
  });

  test("skips non-directory entries", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-cat-file-"));
    dirs.push(tmpHome);
    const inject = { homedir: () => tmpHome };
    const catalog = sharedCatalogDir(inject);
    writeFileSync(join(catalog, "README.md"), "not a skill");
    mkdirSync(join(catalog, "real-skill"));
    const names = sharedSkillNames(inject);
    expect(names).toEqual(["real-skill"]);
  });
});

describe("migrateToSharedCatalog", () => {
  test("migrates skills from project to shared catalog", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-mig-home-"));
    const repo = mkdtempSync(join(tmpdir(), "vf-mig-repo-"));
    dirs.push(tmpHome, repo);
    const inject = { homedir: () => tmpHome };

    // Setup project skill
    const projSkills = join(repo, ".vibeflow", "skills");
    mkdirSync(join(projSkills, "my-skill"), { recursive: true });
    writeFileSync(join(projSkills, "my-skill", "SKILL.md"), "# My Skill\n");

    const result: MigrateResult = migrateToSharedCatalog(repo, inject);
    expect(result.migrated).toContain("my-skill");
    expect(result.errors).toHaveLength(0);
    // Skill now in shared catalog
    expect(existsSync(join(tmpHome, ".vibeflow", "skills", "my-skill", "SKILL.md"))).toBe(true);
    // Removed from project
    expect(existsSync(join(projSkills, "my-skill"))).toBe(false);
  });

  test("handles collision with backup", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-mig-col-home-"));
    const repo = mkdtempSync(join(tmpdir(), "vf-mig-col-repo-"));
    dirs.push(tmpHome, repo);
    const inject = { homedir: () => tmpHome };

    // Pre-existing skill in shared catalog
    const catalog = sharedCatalogDir(inject);
    mkdirSync(join(catalog, "clash"));
    writeFileSync(join(catalog, "clash", "SKILL.md"), "# Old\n");

    // Same-named skill in project
    const projSkills = join(repo, ".vibeflow", "skills");
    mkdirSync(join(projSkills, "clash"), { recursive: true });
    writeFileSync(join(projSkills, "clash", "SKILL.md"), "# New\n");

    const result = migrateToSharedCatalog(repo, inject);
    expect(result.migrated).toContain("clash");
    expect(result.collisions).toContain("clash");
    // Backup dir created
    const backupRoot = join(catalog, ".backup");
    expect(existsSync(backupRoot)).toBe(true);
    const timestamps = readdirSync(backupRoot);
    expect(timestamps.length).toBeGreaterThanOrEqual(1);
    // Backed up copy has old content
    const ts = timestamps[0] ?? "";
    const backedUp = join(backupRoot, ts, "clash", "SKILL.md");
    expect(existsSync(backedUp)).toBe(true);
  });

  test("skips entries without SKILL.md", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-mig-skip-home-"));
    const repo = mkdtempSync(join(tmpdir(), "vf-mig-skip-repo-"));
    dirs.push(tmpHome, repo);
    const inject = { homedir: () => tmpHome };

    const projSkills = join(repo, ".vibeflow", "skills");
    mkdirSync(join(projSkills, "no-skill-md"), { recursive: true });
    writeFileSync(join(projSkills, "no-skill-md", "README.md"), "nope");

    const result = migrateToSharedCatalog(repo, inject);
    expect(result.skipped).toContain("no-skill-md");
    expect(result.migrated).toHaveLength(0);
  });

  test("returns empty result when project has no .vibeflow/skills", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-mig-empty-home-"));
    const repo = mkdtempSync(join(tmpdir(), "vf-mig-empty-repo-"));
    dirs.push(tmpHome, repo);

    const result = migrateToSharedCatalog(repo, { homedir: () => tmpHome });
    expect(result).toEqual({ migrated: [], skipped: [], collisions: [], errors: [] });
  });

  test("skips dotfiles and non-directories", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "vf-mig-dotskip-home-"));
    const repo = mkdtempSync(join(tmpdir(), "vf-mig-dotskip-repo-"));
    dirs.push(tmpHome, repo);
    const inject = { homedir: () => tmpHome };

    const projSkills = join(repo, ".vibeflow", "skills");
    mkdirSync(projSkills, { recursive: true });
    mkdirSync(join(projSkills, ".hidden"));
    writeFileSync(join(projSkills, "loose-file.txt"), "not a dir");

    const result = migrateToSharedCatalog(repo, inject);
    expect(result.skipped).toContain(".hidden");
    expect(result.skipped).toContain("loose-file.txt");
    expect(result.migrated).toHaveLength(0);
  });
});
