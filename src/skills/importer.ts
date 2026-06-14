import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { validateSkillDir } from "./validator.js";

const CANONICAL = join(".vibeflow", "skills");

export interface ImportResult {
  ok: boolean;
  imported: string[];
  errors: string[];
  warnings: string[];
}

function backupIfExists(
  dst: string,
  inject: { cpSync?: (src: string, dst: string, opts: { recursive: boolean }) => void } = {},
): void {
  const _cpSync = inject.cpSync ?? cpSync;
  if (existsSync(dst)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const parent = dirname(dst);
    const backup = join(parent, ".backup", ts, basename(dst));
    mkdirSync(join(parent, ".backup", ts), { recursive: true });
    _cpSync(dst, backup, { recursive: true });
    rmSync(dst, { recursive: true, force: true });
  }
}

/**
 * Import a single skill dir into .vibeflow/skills/<frontmatter.name>.
 * Validates the skill first. Backs up an existing skill to
 * .vibeflow/skills/.backup/<timestamp>/<name> before overwriting.
 */
// Test seam: lets unit tests inject a custom cpSync to exercise
// the catch fallback (line 53) without depending on FS quirks.
export function importSkillFromDir(
  repo: string,
  sourceDir: string,
  inject: { cpSync?: (src: string, dst: string, opts: { recursive: boolean }) => void } = {},
): ImportResult {
  const _cpSync = inject.cpSync ?? cpSync;
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
    backupIfExists(dst, inject);
    _cpSync(sourceDir, dst, { recursive: true });
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
// Test seam: lets unit tests inject a custom statSync + readdirSync
// to exercise the catch fallback (line 97 + 87) with a broken
// symlink or a throwing statSync.
export function importSkillsFromParent(
  repo: string,
  sourceParent: string,
  inject: {
    readdirSync?: (path: string) => string[];
    statSync?: (path: string) => { isDirectory(): boolean };
  } = {},
): ImportResult {
  const _readdirSync = inject.readdirSync ?? readdirSync;
  const _statSync = inject.statSync ?? statSync;
  const errors: string[] = [];
  const warnings: string[] = [];
  const imported: string[] = [];

  if (!existsSync(sourceParent)) {
    return { ok: false, imported, errors: [`${sourceParent}: directory not found`], warnings };
  }
  let entries: string[] = [];
  try {
    entries = _readdirSync(sourceParent);
  } catch (err) {
    return { ok: false, imported, errors: [(err as Error).message], warnings };
  }

  for (const entry of entries) {
    const dir = join(sourceParent, entry);
    try {
      if (!_statSync(dir).isDirectory()) continue;
    } catch {
      /* not a directory — skip (stat throws for broken symlinks) */
    }
    const result = importSkillFromDir(repo, dir);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (result.ok) imported.push(...result.imported);
  }
  return { ok: errors.length === 0, imported, errors, warnings };
}
