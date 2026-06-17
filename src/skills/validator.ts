import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CTX_DIR } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { SKILL_MIRRORS } from "../workflow-artifacts.js";

const ALLOWED_CHILDREN = new Set(["SKILL.md", "LICENSE.txt", "scripts", "references", "assets"]);
const ALLOWED_DIRS = new Set(["scripts", "references", "assets"]);

export interface SkillValidationResult {
  ok: boolean;
  dir: string;
  name?: string;
  errors: string[];
  warnings: string[];
}

function bodyAfterFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text.trim();
  const end = text.indexOf("\n---", 3);
  if (end === -1) return "";
  return text.slice(end + 4).trim();
}

// Test seam: exported so unit tests can exercise the FS-catch
// fallbacks (line 35-40, 88, 116) by injecting throwing fs ops.
export function validateSkillDir(
  dir: string,
  inject: {
    existsSync?: (path: string) => boolean;
    readFileSync?: (path: string, enc: string) => string;
    readdirSync?: (path: string) => string[];
    statSync?: (path: string) => { isDirectory(): boolean };
  } = {},
): SkillValidationResult {
  const _existsSync = inject.existsSync ?? existsSync;
  const _readFileSync = inject.readFileSync ?? readFileSync;
  const _readdirSync = inject.readdirSync ?? readdirSync;
  const _statSync = inject.statSync ?? statSync;
  const errors: string[] = [];
  const warnings: string[] = [];
  const skillMd = join(dir, "SKILL.md");

  if (!_existsSync(skillMd)) {
    return { ok: false, dir, errors: ["missing SKILL.md"], warnings };
  }

  let text = "";
  try {
    text = _readFileSync(skillMd, "utf8");
  } catch (err) {
    return {
      ok: false,
      dir,
      errors: [`cannot read SKILL.md: ${(err as Error).message}`],
      warnings,
    };
  }

  const { data } = parseFrontmatter(text);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";

  if (!name) errors.push("frontmatter.name is required");
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    errors.push("frontmatter.name must be lowercase kebab-case");
  }

  if (!description) errors.push("frontmatter.description is required");
  else if (description.length > 1024) {
    errors.push("frontmatter.description must be <= 1024 chars");
  }

  const folder = basename(dir);
  if (name && folder !== name) {
    warnings.push(`folder name (${folder}) differs from frontmatter.name (${name})`);
  }

  const body = bodyAfterFrontmatter(text);
  if (body.length < 50) {
    errors.push("SKILL.md body must contain actionable instructions (>= 50 chars)");
  }
  if (body && !/^#{1,3}\s+/m.test(body)) {
    warnings.push("SKILL.md body should contain markdown headings");
  }

  try {
    for (const entry of _readdirSync(dir)) {
      if (!ALLOWED_CHILDREN.has(entry)) {
        warnings.push(`unsupported top-level child: ${entry}`);
      }
      const full = join(dir, entry);
      if (ALLOWED_DIRS.has(entry)) {
        try {
          if (_statSync(full).isDirectory()) {
            const count = _readdirSync(full).filter((x) => !x.startsWith(".")).length;
            if (count === 0) warnings.push(`${entry}/ is empty`);
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch (err) {
    warnings.push(`could not inspect skill directory: ${(err as Error).message}`);
  }

  return { ok: errors.length === 0, dir, name: name || undefined, errors, warnings };
}

const SKILL_ROOTS = [join(CTX_DIR, "skills"), join(".kiro", "skills"), ...SKILL_MIRRORS];

export interface SkillRootsValidationResult {
  ok: boolean;
  skills: SkillValidationResult[];
  errors: string[];
  warnings: string[];
}

export function validateSkillRoots(repo: string): SkillRootsValidationResult {
  const skills: SkillValidationResult[] = [];
  for (const root of SKILL_ROOTS) {
    const base = join(repo, root);
    if (!existsSync(base)) continue;
    // base is verified to exist via existsSync above, so
    // readdirSync and statSync should not throw in practice.
    const entries = readdirSync(base);
    for (const entry of entries) {
      const dir = join(base, entry);
      if (!statSync(dir).isDirectory()) continue;
      skills.push(validateSkillDir(dir));
    }
  }
  return {
    ok: skills.length > 0 && skills.every((s) => s.ok),
    skills,
    errors: skills.flatMap((s) => s.errors.map((e) => `${s.dir}: ${e}`)),
    warnings: skills.flatMap((s) => s.warnings.map((w) => `${s.dir}: ${w}`)),
  };
}
