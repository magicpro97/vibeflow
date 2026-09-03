import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillScope } from "../core.js";
import { SKILL_SCOPE, isSkillScope } from "../core/skill-contract.js";
import { parseFrontmatter } from "../frontmatter.js";
import { REQUIRED_SECTIONS, checkQualityContract } from "./validator.js";

const HARDCODED_PATH_PAT = /\/Users\/\w+|C:\\Users\\\w+|\/home\/\w+/;

export interface PublishGateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Parsed scope of the skill. Undefined if absent or invalid. */
  scope?: SkillScope;
}

/**
 * Validate that a skill is publishable to the given target channel.
 * Trust boundary: prevents project-scoped skills from reaching common registries
 * and flags hardcoded local paths in common content.
 */
/** Narrow I/O seam so test lambdas returning string compile without overload fights. */
type ReadFileFn = (path: string, encoding: "utf8") => string;

export function checkPublishGate(
  skillDir: string,
  targetChannel: SkillScope,
  inject: { existsSync?: (path: string) => boolean; readFileSync?: ReadFileFn } = {},
): PublishGateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const skillMd = join(skillDir, "SKILL.md");
  if (!(inject.existsSync ?? existsSync)(skillMd)) {
    return { ok: false, errors: [`${skillDir}: missing SKILL.md`], warnings };
  }

  let text: string;
  try {
    text = (inject.readFileSync ?? ((p, enc) => readFileSync(p, enc)))(skillMd, "utf8");
  } catch (err) {
    return {
      ok: false,
      errors: [`${skillDir}: cannot read SKILL.md: ${(err as Error).message}`],
      warnings,
    };
  }

  const { data, body } = parseFrontmatter(text);
  const rawScope = typeof data.scope === "string" ? data.scope.trim().toLowerCase() : "";
  const scope = isSkillScope(rawScope) ? rawScope : undefined;

  const projectId = typeof data["project.id"] === "string" ? data["project.id"].trim() : undefined;

  // Block: project-scoped skill cannot publish to common channel.
  if (scope === SKILL_SCOPE.PROJECT && targetChannel === SKILL_SCOPE.COMMON) {
    errors.push(
      `scope=project skill "${data.name ?? "unknown"}"${projectId ? ` (project.id=${projectId})` : ""} cannot publish to common channel — project-scoped skills contain repo-specific conventions`,
    );
    return { ok: false, errors, warnings, scope };
  }

  // Block: adapter-scoped skill cannot publish to common channel.
  if (scope === SKILL_SCOPE.ADAPTER && targetChannel === SKILL_SCOPE.COMMON) {
    errors.push(
      `scope=adapter skill "${data.name ?? "unknown"}" cannot publish to common channel — adapter skills are tool-specific`,
    );
    return { ok: false, errors, warnings, scope };
  }

  // Warn: organization-scoped skill publishing to common — allowed but worth flagging.
  if (scope === SKILL_SCOPE.ORGANIZATION && targetChannel === SKILL_SCOPE.COMMON) {
    warnings.push(
      `organization-scoped skill "${data.name ?? "unknown"}" publishing to common channel — verify it contains no org-specific conventions`,
    );
  }

  // Hardcoded path detection at trust boundary for common channel.
  if (targetChannel === SKILL_SCOPE.COMMON) {
    const fullText = `${text}`;
    const pathMatches = fullText.match(HARDCODED_PATH_PAT);
    if (pathMatches && pathMatches.length > 0) {
      errors.push(
        `hardcoded local path(s) in skill content: ${pathMatches.slice(0, 3).join(", ")} — common channel skills must not embed repo-specific absolute paths`,
      );
      return { ok: false, errors, warnings, scope };
    }
  }

  // #657: skill-creator quality contract gate — blocks promotion to verified
  // when quality contract errors exist, warns on quality contract warnings.
  // Uses the `body` from parseFrontmatter (already available above) stripping
  // any leading/trailing whitespace for deterministic line-count.
  if (targetChannel === SKILL_SCOPE.COMMON && body) {
    const qc = checkQualityContract(body);
    for (const e of qc.errors) {
      errors.push(`quality: ${e}`);
    }
    for (const w of qc.warnings) {
      const missingSection = REQUIRED_SECTIONS.some(
        (section) => w === `missing required section: ${section}`,
      );
      (missingSection ? errors : warnings).push(`quality: ${w}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, scope };
}
