import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { assertWithinRoot } from "../safety/path.js";
import { validateSkillDir } from "./validator.js";

const CANONICAL = join(".vibeflow", "skills");

export interface ImportResult {
  ok: boolean;
  imported: string[];
  errors: string[];
  warnings: string[];
}

function readSkillFrontmatterName(dir: string): string | null {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return null;
  try {
    const text = require("node:fs").readFileSync(skillMd, "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return null;
    const nameMatch = m[1].match(/^name:\s*([^\n#]+)/m);
    return nameMatch?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function backupIfExists(repo: string, dst: string): void {
  if (existsSync(dst)) {
    // Defense in depth: assert the destination is inside the project root
    // BEFORE any destructive operation (cpSync writes the backup into
    // a subdirectory of `repo`, but if `dst` itself is a traversal path
    // the assert guards the subsequent rmSync and the write to a backup
    // path derived from it).
    assertWithinRoot(dst, repo);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = join(repo, CANONICAL, ".backup", ts, basename(dst));
    mkdirSync(join(repo, CANONICAL, ".backup", ts), { recursive: true });
    cpSync(dst, backup, { recursive: true });
    rmSync(dst, { recursive: true, force: true });
  }
}

/**
 * Import a single skill dir into .vibeflow/skills/<frontmatter.name>.
 * Validates the skill first. Backs up an existing skill to
 * .vibeflow/skills/.backup/<timestamp>/<name> before overwriting.
 */
export function importSkillFromDir(repo: string, sourceDir: string): ImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const imported: string[] = [];

  if (!existsSync(join(sourceDir, "SKILL.md"))) {
    return { ok: false, imported, errors: [`${sourceDir}: missing SKILL.md`], warnings };
  }

  const validation = validateSkillDir(sourceDir);
  if (!validation.ok) {
    return { ok: false, imported, errors: validation.errors, warnings: validation.warnings };
  }
  warnings.push(...validation.warnings);

  const name = validation.name ?? basename(sourceDir);
  const dst = join(repo, CANONICAL, name);
  mkdirSync(join(repo, CANONICAL), { recursive: true });
  try {
    backupIfExists(repo, dst);
    cpSync(sourceDir, dst, { recursive: true });
    imported.push(name);
    return { ok: true, imported, errors, warnings };
  } catch (err) {
    return { ok: false, imported, errors: [(err as Error).message], warnings };
  }
}

/**
 * Import all skill subdirs from a parent dir (e.g. an export dir from ctx7).
 * Validates each skill; skips invalid ones and reports errors.
 */
export function importSkillsFromParent(repo: string, sourceParent: string): ImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const imported: string[] = [];

  if (!existsSync(sourceParent)) {
    return { ok: false, imported, errors: [`${sourceParent}: directory not found`], warnings };
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(sourceParent);
  } catch (err) {
    return { ok: false, imported, errors: [(err as Error).message], warnings };
  }

  for (const entry of entries) {
    const dir = join(sourceParent, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const result = importSkillFromDir(repo, dir);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (result.ok) imported.push(...result.imported);
  }
  return { ok: errors.length === 0, imported, errors, warnings };
}
