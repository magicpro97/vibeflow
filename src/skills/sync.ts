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
import { ENGINES, type Engine } from "../core.js";
import { validateSkillDir } from "./validator.js";

const CANONICAL = join(".vibeflow", "skills");
const ALL_MIRRORS = [
  join(".claude", "skills"),
  join(".agents", "skills"),
  join(".github", "skills"),
];

const ENGINE_MIRROR: Record<Engine, string> = {
  claude: join(".claude", "skills"),
  codex: join(".agents", "skills"),
  copilot: join(".github", "skills"),
};

function mirrorsFor(engines?: Engine[]): string[] {
  if (!engines || engines.length === 0) return [...ALL_MIRRORS];
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
  repo: string,
  inject: {
    readdirSync?: (path: string) => string[];
    statSync?: (path: string) => { isDirectory(): boolean };
  } = {},
): string[] {
  const _readdirSync = inject.readdirSync ?? readdirSync;
  const _statSync = inject.statSync ?? statSync;
  const base = join(repo, CANONICAL);
  if (!existsSync(base)) return [];
  return _readdirSync(base).filter((n) => {
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
    `\`${".vibeflow/skills/"}${name}/SKILL.md\``,
    "",
    "Before using this skill:",
    "1. Read canonical SKILL.md",
    `2. Read linked files under .vibeflow/skills/${name}/references/ (if present)`,
    `3. Run scripts from .vibeflow/skills/${name}/scripts/ (if present) only when instructed`,
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
  } = {},
): SkillSyncResult {
  const mode: SyncMode = opts.mode ?? "pointer";
  const mirrors = mirrorsFor(opts.engines);
  const synced: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const name of skillNames(repo, opts)) {
    const src = join(repo, CANONICAL, name);
    const validation = validateSkillDir(src);
    if (!validation.ok) {
      errors.push(...validation.errors.map((e) => `${CANONICAL}/${name}: ${e}`));
      continue;
    }
    warnings.push(...validation.warnings.map((w) => `${CANONICAL}/${name}: ${w}`));
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

export function verifySkillSync(repo: string, engines?: Engine[]): SkillSyncResult {
  const mirrors = mirrorsFor(engines);
  const errors: string[] = [];
  const synced: string[] = [];
  for (const name of skillNames(repo)) {
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
