import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { ENGINES, type Engine, c } from "../core.js";
import { sharedCatalogDir } from "./catalog.js";
import { validateSkillDir } from "./validator.js";
const ENGINE_MIRROR: Record<Engine, string> = {
  claude: join(".claude", "skills"),
  codex: join(".agents", "skills"),
  copilot: join(".github", "skills"),
  opencode: join(".opencode", "skills"),
};

function mirrorsFor(engines?: Engine[]): string[] {
  if (!engines || engines.length === 0) {
    // Default-engine scope: when no engines are passed we fall back to
    // copilot-only. Surface that loudly so the user knows other engines
    // were not mirrored in this pass.
    c.yellow("⚠ defaulting to copilot; re-run with --engine <name> for other engines");
    return [ENGINE_MIRROR.copilot];
  }
  return engines
    .filter((e): e is Engine => (ENGINES as readonly string[]).includes(e))
    .map((e) => ENGINE_MIRROR[e]);
}

export type SyncMode = "pointer" | "full";

export interface SyncSkillOptions {
  mode?: SyncMode;
  engines?: Engine[];
}

export interface SkillSyncResult {
  ok: boolean;
  mode: SyncMode;
  synced: string[];
  errors: string[];
  warnings: string[];
}

// Test seam: exported so unit tests can exercise the statSync
// catch fallback (line 36-37) by injecting a throwing statSync.
export function skillNames(
  _repo: string,
  inject: {
    readdirSync?: (path: string) => string[];
    statSync?: (path: string) => { isDirectory(): boolean };
    catalogDir?: string;
  } = {},
): string[] {
  const _readdirSync = inject.readdirSync ?? readdirSync;
  const _statSync = inject.statSync ?? statSync;
  const base = inject.catalogDir ?? sharedCatalogDir();
  if (!existsSync(base)) return [];
  return _readdirSync(base).filter((n) => {
    if (n.startsWith(".")) return false;
    try {
      return _statSync(join(base, n)).isDirectory();
    } catch {
      return false;
    }
  });
}

function pointerBody(name: string, mode: SyncMode): string {
  return [
    "---",
    `name: ${name}`,
    "description: See canonical SKILL.md for full details.",
    "---",
    "",
    `# ${name}`,
    "",
    "Canonical skill lives at:",
    "",
    `\`~/.vibeflow/skills/${name}/SKILL.md\``,
    "",
    "Before using this skill:",
    "1. Read canonical SKILL.md",
    `2. Read linked files under ~/.vibeflow/skills/${name}/references/ (if present)`,
    `3. Run scripts from ~/.vibeflow/skills/${name}/scripts/ (if present) only when instructed`,
    "",
    `Sync mode: ${mode}`,
    "",
  ].join("\n");
}

export function syncSkillMirrors(
  repo: string,
  opts: SyncSkillOptions & {
    // Test seam: lets unit tests inject custom readdirSync/statSync
    // to exercise the catch fallback in skillNames (line 36-37).
    readdirSync?: (path: string) => string[];
    statSync?: (path: string) => { isDirectory(): boolean };
    catalogDir?: string;
  } = {},
): SkillSyncResult {
  const mode: SyncMode = opts.mode ?? "pointer";
  const mirrors = mirrorsFor(opts.engines);
  const synced: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const catalog = opts.catalogDir ?? sharedCatalogDir();

  for (const name of skillNames(repo, opts)) {
    const src = join(catalog, name);
    const validation = validateSkillDir(src);
    if (!validation.ok) {
      errors.push(...validation.errors.map((e) => `~/.vibeflow/skills/${name}: ${e}`));
      continue;
    }
    warnings.push(...validation.warnings.map((w) => `~/.vibeflow/skills/${name}: ${w}`));
    try {
      for (const mirror of mirrors) {
        const dst = join(repo, mirror, name);
        mkdirSync(join(repo, mirror), { recursive: true });
        rmSync(dst, { recursive: true, force: true });
        mkdirSync(dst, { recursive: true });
        if (mode === "pointer") {
          writeFileSync(join(dst, "SKILL.md"), pointerBody(name, mode));
        } else {
          cpSync(src, dst, { recursive: true });
        }
        synced.push(relative(repo, dst));
      }
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { ok: errors.length === 0, mode, synced, errors, warnings };
}

export function verifySkillSync(
  repo: string,
  engines?: Engine[],
  opts: { catalogDir?: string } = {},
): SkillSyncResult {
  const mirrors = mirrorsFor(engines);
  const errors: string[] = [];
  const synced: string[] = [];
  for (const name of skillNames(repo, { catalogDir: opts.catalogDir })) {
    for (const mirror of mirrors) {
      const dst = join(repo, mirror, name, "SKILL.md");
      if (!existsSync(dst)) {
        errors.push(`${mirror}/${name}/SKILL.md missing`);
      } else {
        synced.push(`${mirror}/${name}`);
      }
    }
  }
  return { ok: errors.length === 0, mode: "pointer", synced, errors, warnings: [] };
}
