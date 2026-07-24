import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillScope } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";

const VALID_SCOPES = new Set(["common", "organization", "project", "adapter"]);

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
export function checkPublishGate(
  skillDir: string,
  targetChannel: "common" | "organization" | "project" | "adapter",
  inject: { readFileSync?: typeof readFileSync } = {},
): PublishGateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const skillMd = join(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    return { ok: false, errors: [`${skillDir}: missing SKILL.md`], warnings };
  }

  let text: string;
  try {
    text = (inject.readFileSync ?? readFileSync)(skillMd, "utf8");
  } catch (err) {
    return {
      ok: false,
      errors: [`${skillDir}: cannot read SKILL.md: ${(err as Error).message}`],
      warnings,
    };
  }

  const { data, body } = parseFrontmatter(text);
  const rawScope = typeof data.scope === "string" ? data.scope.trim().toLowerCase() : "";
  const scope: SkillScope | undefined = VALID_SCOPES.has(rawScope)
    ? (rawScope as SkillScope)
    : undefined;

  const projectId = typeof data["project.id"] === "string" ? data["project.id"].trim() : undefined;

  // Block: project-scoped skill cannot publish to common channel.
  if (scope === "project" && targetChannel === "common") {
    errors.push(
      `scope=project skill "${data.name ?? "unknown"}"${projectId ? ` (project.id=${projectId})` : ""} cannot publish to common channel — project-scoped skills contain repo-specific conventions`,
    );
    return { ok: false, errors, warnings, scope };
  }

  // Block: adapter-scoped skill cannot publish to common channel.
  if (scope === "adapter" && targetChannel === "common") {
    errors.push(
      `scope=adapter skill "${data.name ?? "unknown"}" cannot publish to common channel — adapter skills are tool-specific`,
    );
    return { ok: false, errors, warnings, scope };
  }

  // Warn: organization-scoped skill publishing to common — allowed but worth flagging.
  if (scope === "organization" && targetChannel === "common") {
    warnings.push(
      `organization-scoped skill "${data.name ?? "unknown"}" publishing to common channel — verify it contains no org-specific conventions`,
    );
  }

  // Hardcoded path detection at trust boundary for common channel.
  if (targetChannel === "common") {
    const fullText = `${text}`;
    const pathMatches = fullText.match(HARDCODED_PATH_PAT);
    if (pathMatches && pathMatches.length > 0) {
      errors.push(
        `hardcoded local path(s) in skill content: ${pathMatches.slice(0, 3).join(", ")} — common channel skills must not embed repo-specific absolute paths`,
      );
      return { ok: false, errors, warnings, scope };
    }
  }

  return { ok: errors.length === 0, errors, warnings, scope };
}
