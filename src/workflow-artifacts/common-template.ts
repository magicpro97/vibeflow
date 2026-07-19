import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEngine } from "../agents/render.js";
import { resolveTemplatePath } from "./template-path.js";
import { ENGINE_CONFIGS } from "./types.js";

// ── Common template skill path ──────────────────────────────────────────────

/**
 * Resolve the path to the common template skill for a given phase name.
 * The templates live at `<package>/templates/skills/<phase>/SKILL.md` and
 * ship with the package (see `package.json` `files[]`).
 *
 * The resolution uses `import.meta.url` so it works from both source
 * (Bun, `dist/` after build) and the published package — Bun builds with
 * `--target=node` rewrite `import.meta.url` to a `file://` URL, and the
 * package keeps `templates/skills/` next to `dist/cli.js`.
 */
export function commonTemplateSkillPath(phaseName: string): string {
  const resolved = resolveTemplatePath(`skills/${phaseName}/SKILL.md`);
  if (resolved) return resolved;
  // Not found in either layout — return the prod-bundle path for a sensible
  // "not found at <path>" warning message (the caller checks exists()).
  return fileURLToPath(new URL(`../templates/skills/${phaseName}/SKILL.md`, import.meta.url));
}

// ── Engine skill path helpers ───────────────────────────────────────────────

export function skillDirPath(engine: AgentEngine, skillName: string): string {
  return `${ENGINE_CONFIGS[engine].skillRoot}/${skillName}`;
}

export function skillFilePath(engine: AgentEngine, skillName: string): string {
  return `${skillDirPath(engine, skillName)}/SKILL.md`;
}

// ── Common template skill copy ──────────────────────────────────────────────

/**
 * Copy the bundled common skill for a phase from `templates/skills/<phase>/SKILL.md`
 * into each engine's skill root. Mirrors `copySkillCreator` (DI for `exists`
 * + `onWarn` to keep the missing-source path testable). The phase name is
 * used as the destination skill directory name (matches the phase slug, so
 * `generateWorkflowArtifacts` writes the same final path whether it
 * renders a stub or copies a common skill).
 *
 * Returns the list of relative paths written (one per engine).
 */
export function copyCommonTemplateSkill(
  phaseName: string,
  base: string,
  engines: AgentEngine[],
  inject: {
    exists?: (p: string) => boolean;
    onWarn?: (msg: string) => void;
    mkdir?: (p: string, opts: { recursive: boolean }) => void;
    copyFile?: (from: string, to: string) => void;
  } = {},
): string[] {
  const exists = inject.exists ?? existsSync;
  const onWarn = inject.onWarn ?? ((msg) => console.warn(msg));
  const mkdir = inject.mkdir ?? mkdirSync;
  const copyFile = inject.copyFile ?? copyFileSync;
  const written: string[] = [];
  const srcPath = commonTemplateSkillPath(phaseName);
  if (!exists(srcPath)) {
    onWarn(
      `vibeflow: common template skill not found at ${srcPath} — falling back to stub for phase "${phaseName}".`,
    );
    return written;
  }
  for (const engine of engines) {
    const dstRelPath = skillFilePath(engine, phaseName);
    const dstDir = join(base, dirname(dstRelPath));
    mkdir(dstDir, { recursive: true });
    copyFile(srcPath, join(base, dstRelPath));
    written.push(dstRelPath);
  }
  return written;
}

// ── Recursive copy helper ───────────────────────────────────────────────────

function copyRecursiveSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    if (statSync(srcPath).isDirectory()) {
      copyRecursiveSync(srcPath, dstPath);
    } else {
      mkdirSync(dirname(dstPath), { recursive: true });
      copyFileSync(srcPath, dstPath);
    }
  }
}

// ── Skill-creator copy ──────────────────────────────────────────────────────

/**
 * Copy the bundled `skill-creator` skill from the package's own
 * `.agents/skills/skill-creator/` into each engine's skill root in `base`.
 *
 * Dependency-injected `exists` and `onWarn` make the missing-source path
 * testable without renaming real files. Default `exists` is `existsSync`
 * and default `onWarn` is `console.warn` — production callers don't pass
 * them.
 */
export function copySkillCreator(
  base: string,
  engines: AgentEngine[],
  inject: { exists?: (p: string) => boolean; onWarn?: (msg: string) => void } = {},
): string[] {
  const exists = inject.exists ?? existsSync;
  const onWarn = inject.onWarn ?? ((msg) => console.warn(msg));
  const written: string[] = [];
  const srcUrl = new URL("../../.agents/skills/skill-creator", import.meta.url);
  const srcPath = fileURLToPath(srcUrl);
  if (!exists(srcPath)) {
    onWarn(
      `vibeflow: skill-creator source not found at ${srcPath} — AI enrichment will be degraded. Check package.json files[] includes ".agents/skills/skill-creator".`,
    );
    return written;
  }
  for (const engine of engines) {
    const dstDir = join(base, skillDirPath(engine, "skill-creator"));
    copyRecursiveSync(srcPath, dstDir);
    written.push(skillDirPath(engine, "skill-creator"));
  }
  return written;
}
