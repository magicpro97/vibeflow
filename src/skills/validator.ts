import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CTX_DIR } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { SKILL_MIRRORS } from "../workflow-artifacts.js";

const ALLOWED_DIRS = new Set(["scripts", "references", "assets"]);

// Standard SKILL.md frontmatter fields per the Agent Skills spec
// (https://agentskills.io/specification). Anthropic's own reference
// validator (skills/skill-creator/scripts/quick_validate.py) uses the
// same set. Unknown keys are WARNED (not errored): some existing repo
// skills carry legacy non-spec keys (status/version/triggers/requires/
// when_to_load), so a hard error would break them. Promote to error in
// a future major.
const STANDARD_FRONTMATTER = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
  "type",
  "mcp",
  "scope",
  "project.id",
  "extends",
]);

const VALID_SCOPES = new Set(["common", "organization", "project", "adapter"]);

const HARDCODED_PATH_PAT = /\/Users\/\w+|C:\\Users\\\w+|\/home\/\w+/;

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;

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
  else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push("frontmatter.name must be lowercase kebab-case");
    }
    if (name.length > NAME_MAX) {
      errors.push(`frontmatter.name must be <= ${NAME_MAX} chars`);
    }
  }

  if (!description) errors.push("frontmatter.description is required");
  else {
    if (description.length > DESCRIPTION_MAX) {
      errors.push(`frontmatter.description must be <= ${DESCRIPTION_MAX} chars`);
    }
    if (/[<>]/.test(description)) {
      errors.push("frontmatter.description must not contain angle brackets (< or >)");
    }
  }

  // compatibility is optional; when present it must be a string <= 500 chars
  // (parity with quick_validate.py: a non-string compatibility is an error).
  if (data.compatibility !== undefined && typeof data.compatibility !== "string") {
    errors.push("frontmatter.compatibility must be a string");
  }
  const compatibility = typeof data.compatibility === "string" ? data.compatibility.trim() : "";
  if (compatibility && compatibility.length > COMPATIBILITY_MAX) {
    errors.push(`frontmatter.compatibility must be <= ${COMPATIBILITY_MAX} chars`);
  }

  // #543: type is optional; when present it must be "repo" or "knowledge" (unknown degrades
  // to knowledge at the injection site, so this is a warning, not a hard error).
  if (data.type !== undefined && data.type !== "repo" && data.type !== "knowledge") {
    warnings.push('frontmatter.type must be "repo" or "knowledge"');
  }

  // #552: mcp is optional; when present it must be an object. transport defaults to stdio,
  // so it's optional — but stdio needs a command, and http/sse need a url.
  if (data.mcp !== undefined) {
    const m = data.mcp;
    let malformed = false;
    if (!m || typeof m !== "object") {
      malformed = true;
    } else {
      const r = m as Record<string, unknown>;
      const t = r.transport;
      const transport = t === "http" || t === "sse" ? t : "stdio";
      if (transport === "stdio" && (typeof r.command !== "string" || !r.command)) malformed = true;
      if ((transport === "http" || transport === "sse") && (typeof r.url !== "string" || !r.url))
        malformed = true;
    }
    if (malformed) {
      warnings.push("frontmatter.mcp is malformed (need command for stdio, or url for http/sse)");
    }
  }

  // #655: scope validation — warn on unrecognized scope values.
  if (data.scope !== undefined) {
    const raw = typeof data.scope === "string" ? data.scope.trim().toLowerCase() : "";
    if (!VALID_SCOPES.has(raw)) {
      warnings.push(
        `frontmatter.scope must be one of: common, organization, project, adapter (got "${raw}")`,
      );
    }
  }

  // #655: project.id is valid only when scope=project or scope=adapter.
  if (data["project.id"] !== undefined) {
    const rawScope = typeof data.scope === "string" ? data.scope.trim().toLowerCase() : "";
    if (rawScope !== "project" && rawScope !== "adapter") {
      warnings.push(
        "frontmatter.project.id is only meaningful with scope=project or scope=adapter",
      );
    }
  }

  // Warn (not error) on frontmatter keys outside the spec's standard set,
  // so typos surface without breaking existing skills that carry legacy
  // keys (status/version/triggers/requires/when_to_load).
  for (const key of Object.keys(data)) {
    if (!STANDARD_FRONTMATTER.has(key)) {
      warnings.push(`non-standard frontmatter key: ${key}`);
    }
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

  // Anti-pattern: task-specific content leak. A reusable skill must NOT
  // embed concrete requirement IDs (BR-001, E-014, AC-032, …) or other
  // task-specific tokens. Such content freezes the skill to the first
  // task it was enriched from and defeats reusability. Report as a
  // warning (not an error) so existing skills with legacy content keep
  // validating; promote to an error in a future major version.
  // The pattern is intentionally narrow: bracketed uppercase prefixes
  // (BR/FR/NFR/AC/E/VP) followed by 2-4 digits. Real product code
  // occasionally matches (\d{2,4} is permissive) so we keep this as a
  // warning to avoid false positives in skills that genuinely reference
  // such IDs in their inputs.
  if (body) {
    const TASK_ID_PATTERN = /\b(?:BR|FR|NFR|AC|E|VP)-\d{2,4}\b/;
    const taskLeaks = body.match(new RegExp(TASK_ID_PATTERN.source, "g"));
    if (taskLeaks && taskLeaks.length > 0) {
      warnings.push(
        `task-specific content leak: skill body contains ${taskLeaks.length} concrete requirement ID(s) (e.g. ${taskLeaks.slice(0, 3).join(", ")}). A reusable skill should use placeholders like {{task.requirement_ids}} instead of embedded IDs from a sample task.`,
      );
    }
  }

  // #655: hardcoded path detection for common-scoped skills at trust boundary.
  if (data.scope === "common" && body) {
    const matches = body.match(HARDCODED_PATH_PAT);
    if (matches && matches.length > 0) {
      warnings.push(
        `hardcoded local path in common skill body: ${matches.slice(0, 3).join(", ")} — common skills must not embed repo-specific paths`,
      );
    }
  }

  try {
    for (const entry of _readdirSync(dir)) {
      // Spec allows "any additional files or directories", so extra
      // top-level entries are NOT flagged. Only the standard optional
      // dirs get an emptiness check.
      const full = join(dir, entry);
      if (ALLOWED_DIRS.has(entry)) {
        try {
          if (_statSync(full).isDirectory()) {
            const count = _readdirSync(full).filter((x: string) => !x.startsWith(".")).length;
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
