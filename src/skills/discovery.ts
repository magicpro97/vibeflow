// biome-ignore format: entire-file — tight formatting keeps file ≤400 lines
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CTX_DIR, type Skill } from "../core.js";
import { SKILL_MIRRORS } from "../workflow-artifacts.js";
import { resolveAllAdapters } from "./adapter.js";
import { sharedCatalogDir } from "./catalog.js";
import { parseRegistryLock } from "./registry-channel.js";
// biome-ignore format: compact single-line keeps file ≤400
import { parseSkill } from "./registry.js";
import { type ParseSkillOpts, trustedIdentityForSharedSkill } from "./review-proof.js";

/**
 * Directories that may contain `<name>/SKILL.md` folders.
 *
 * Resolution order (first root wins on name collision):
 *  1. CTX_DIR/skills        — project-local override (repo can vendor/shadow)
 *  2. .kiro/skills          — Kiro engine (third-party, not in our mirror list)
 *  3. SKILL_MIRRORS         — per-engine roots (workflow-artifacts.ts)
 *
 * `discoverSkills` also scans the SHARED catalog (~/.vibeflow/skills/) AFTER
 * project-local roots, so a project-local skill always shadows the shared one.
 */
const SKILL_ROOTS: string[] = [join(CTX_DIR, "skills"), join(".kiro", "skills"), ...SKILL_MIRRORS];

/** Keep repository-controlled paths from injecting control sequences into stderr. */
function safeLog(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? "?" : ch;
  }
  return out.slice(0, 1000);
}

/** Discover every valid skill under the known roots in `repo`, de-duplicated by name.
 *  Resolution order: project-local roots first, then the shared user-scoped catalog
 *  (~/.vibeflow/skills/). A project-local skill always shadows a shared one. */
export function discoverSkills(
  repo: string,
  inject: { sharedCatalogDir?: () => string; homedir?: () => string } = {},
): Skill[] {
  const byName = new Map<string, Skill>();

  for (const root of SKILL_ROOTS) {
    const base = join(repo, root);
    if (!existsSync(base)) continue;
    const entries = readdirSync(base);
    for (const entry of entries) {
      const dir = join(base, entry);
      if (!statSync(dir).isDirectory()) continue;
      const skillMd = join(dir, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const skill = parseSkill(skillMd, dir);
      if (!skill) continue;
      const key = skill.name.toLowerCase();
      const winner = byName.get(key);
      if (winner) {
        console.error(
          `[skills] duplicate "${skill.name}" ignored: ${safeLog(skill.path)} (winner: ${safeLog(winner.path)})`,
        );
      } else byName.set(key, skill);
    }
  }

  const _sharedDir = inject.sharedCatalogDir ?? sharedCatalogDir;
  const home = inject.homedir?.() ?? process.env.VF_SKILLS_HOME ?? homedir();
  const lock = parseRegistryLock(repo);
  try {
    const shared = _sharedDir();
    if (existsSync(shared)) {
      const entries = readdirSync(shared);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const dir = join(shared, entry);
        if (!statSync(dir).isDirectory()) continue;
        const skillMd = join(dir, "SKILL.md");
        if (!existsSync(skillMd)) continue;
        const id = trustedIdentityForSharedSkill(entry, lock.registries, dir);
        // biome-ignore format: compact ternary keeps file ≤400
        const skill = parseSkill(skillMd, dir, id ? { provenance: "discovered", trustedReviewIdentity: id, homedir: () => home } : { provenance: "discovered" });
        if (!skill) continue;
        const key = skill.name.toLowerCase();
        const winner = byName.get(key);
        if (winner) {
          console.error(
            `[skills] duplicate "${skill.name}" ignored: ${safeLog(skill.path)} (winner: ${safeLog(winner.path)})`,
          );
        } else byName.set(key, skill);
      }
    }
  } catch {
    // shared catalog inaccessible — continue with local-only
  }

  const collected = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));

  const resolved = resolveAllAdapters(collected);

  for (const w of resolved.warnings) {
    console.error(`[skills] ${w}`);
  }

  return resolved.skills;
}
