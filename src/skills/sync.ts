import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { ENGINES, type Engine, c } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { ENGINE_CONFIGS } from "../workflow-artifacts/types.js";
import { skillBundleHash } from "./bundle-hash.js";
import { sharedCatalogDir } from "./catalog.js";
import { parseRegistryLock } from "./registry-channel.js";
import { validateSkillDir } from "./validator.js";

// Project-local canonical dir. Kept as an override/shadow layer on top of the
// shared catalog (issue #631) — mirrors discoverSkills' resolution order in
// registry.ts (project-local first, shared catalog after).
const CANONICAL = join(".vibeflow", "skills");

function mirrorsFor(engines?: readonly Engine[]): string[] {
  if (!engines || engines.length === 0) {
    // Default-engine scope: when no engines are passed we fall back to
    // copilot-only. Surface that loudly so the user knows other engines
    // were not mirrored in this pass.
    c.yellow("⚠ defaulting to copilot; re-run with --engine <name> for other engines");
    return [ENGINE_CONFIGS.copilot.skillRoot];
  }
  return engines
    .filter((e): e is Engine => (ENGINES as readonly string[]).includes(e))
    .map((e) => ENGINE_CONFIGS[e].skillRoot);
}

function pointerTarget(body: string): string | undefined {
  const match = body.match(/Canonical skill lives at:\n+`([^`]+)`/u);
  return match?.[1];
}

export type SyncMode = "pointer" | "full";

export interface SyncSkillOptions {
  mode?: SyncMode;
  engines?: readonly Engine[];
  skills?: readonly string[];
  /** When true, also mirror every skill pinned in the project's registry lock. */
  fromRegistry?: boolean;
}

export interface SkillSyncResult {
  ok: boolean;
  mode: SyncMode;
  synced: string[];
  errors: string[];
  warnings: string[];
}

/** List skill names visible to `repo`: project-local .vibeflow/skills/ (override layer)
 *  UNIONed with the shared ~/.vibeflow/skills/ catalog (issue #631). Same resolution
 *  order as discoverSkills in registry.ts — kept in sync intentionally. */
export function skillNames(
  repo: string,
  inject: {
    readdirSync?: (path: string) => string[];
    statSync?: (path: string) => { isDirectory(): boolean };
    catalogDir?: string;
  } = {},
): string[] {
  const _readdirSync = inject.readdirSync ?? readdirSync;
  const _statSync = inject.statSync ?? statSync;
  const listDir = (base: string): string[] => {
    if (!existsSync(base)) return [];
    return _readdirSync(base).filter((n) => {
      if (n.startsWith(".")) return false;
      try {
        return _statSync(join(base, n)).isDirectory();
      } catch {
        return false;
      }
    });
  };
  const local = listDir(join(repo, CANONICAL));
  const shared = listDir(inject.catalogDir ?? sharedCatalogDir());
  return [...new Set([...local, ...shared])];
}

/** Extract skill names pinned/required from the project's registry lock.
 *  Returns only names whose installed entry has a matching directory in the
 *  shared catalog (~/.vibeflow/skills/). Missing entries produce actionable
 *  errors.
 *  ponytail: resolves from the shared catalog only. Extend to project-local
 *  .vibeflow/skills/ when registry install writes there too. */
export function requiredSkillNames(
  repo: string,
  inject: {
    existsSync?: (path: string) => boolean;
    readdirSync?: (path: string) => string[];
    statSync?: (path: string) => { isDirectory(): boolean };
    catalogDir?: string;
  } = {},
): { names: string[]; errors: string[] } {
  const _exists = inject.existsSync ?? existsSync;
  const lock = parseRegistryLock(repo);
  const names: string[] = [];
  const errors: string[] = [];
  const catalog = inject.catalogDir ?? sharedCatalogDir();
  for (const reg of lock.registries) {
    for (const sk of reg.installed ?? []) {
      if (names.includes(sk.name)) continue;
      const catDir = join(catalog, sk.name);
      if (_exists(catDir)) {
        names.push(sk.name);
      } else {
        errors.push(
          `"${sk.name}" (from registry "${reg.name}") pinned in lock but missing from catalog — run \`vf skills registry install ${reg.name}/${sk.name} --yes\``,
        );
      }
    }
  }
  return { names, errors };
}

/** Resolve the source dir + its display path (project-local shadows the shared catalog). */
function skillSrcDir(
  repo: string,
  name: string,
  catalog: string,
): { dir: string; displayPath: string } {
  const local = join(repo, CANONICAL, name);
  if (existsSync(local)) return { dir: local, displayPath: `.vibeflow/skills/${name}/SKILL.md` };
  return { dir: join(catalog, name), displayPath: `~/.vibeflow/skills/${name}/SKILL.md` };
}

/** Only used when a canonical SKILL.md has no usable description; shared so
 *  verifySkillSync accepts exactly what pointerBody() would write. */
const PLACEHOLDER_DESCRIPTION = "See canonical SKILL.md for full details.";

/** Mirror stubs must carry the canonical description verbatim: engines (and
 *  agent runtimes) trigger on the listing, so a placeholder burns the only
 *  signal they get — and a truncated one silently drops the "Not for …" /
 *  "Skip when …" exclusions that keep a skill from firing on the wrong task.
 *  Only the line shape changes here (frontmatter wants a single flat line). */
export function mirrorDescriptionFrom(raw: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length === 0 ? undefined : flat;
}

function mirrorDescription(srcDir: string): string | undefined {
  // No local catch: an unreadable or malformed canonical SKILL.md is a real
  // failure, and syncSkillMirrors already records per-skill errors. Swallowing
  // it here would silently fall back to the placeholder this change removes.
  const parsed = parseFrontmatter(readFileSync(join(srcDir, "SKILL.md"), "utf8"));
  return mirrorDescriptionFrom(parsed.data.description as string);
}

function pointerBody(
  name: string,
  mode: SyncMode,
  canonicalPath: string,
  description?: string,
): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description ?? PLACEHOLDER_DESCRIPTION)}`,
    "---",
    "",
    `# ${name}`,
    "",
    "Canonical skill lives at:",
    "",
    `\`${canonicalPath}\``,
    "",
    "Before using this skill:",
    "1. Read canonical SKILL.md",
    "2. Read linked files under references/ (if present)",
    "3. Run scripts from scripts/ (if present) only when instructed",
    "",
    `Sync mode: ${mode}`,
    "",
  ].join("\n");
}

export function syncSkillMirrors(
  repo: string,
  opts: SyncSkillOptions & {
    // Test seam: lets unit tests inject custom readdirSync/statSync
    // to exercise the catch fallback in skillNames, and/or an isolated
    // catalogDir instead of the real shared catalog.
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

  let names = skillNames(repo, { ...opts, catalogDir: catalog });
  if (opts.fromRegistry) {
    const reg = requiredSkillNames(repo, { ...opts, catalogDir: catalog });
    if (reg.names.length) {
      names = [...new Set([...names, ...reg.names])];
    }
    warnings.push(...reg.errors.map((e) => `registry-pinned: ${e}`));
  }
  if (opts.skills && opts.skills.length > 0) {
    const selected = new Set(opts.skills);
    names = names.filter((name) => selected.has(name));
  }

  for (const name of names) {
    const { dir: src, displayPath } = skillSrcDir(repo, name, catalog);
    const validation = validateSkillDir(src);
    if (!validation.ok) {
      errors.push(...validation.errors.map((e) => `${name}: ${e}`));
      continue;
    }
    warnings.push(...validation.warnings.map((w) => `${name}: ${w}`));
    try {
      // Parse the canonical frontmatter once per skill, not once per engine: the
      // description is identical for every mirror.
      const description = mode === "pointer" ? mirrorDescription(src) : undefined;
      for (const mirror of mirrors) {
        const dst = join(repo, mirror, name);
        mkdirSync(join(repo, mirror), { recursive: true });
        rmSync(dst, { recursive: true, force: true });
        mkdirSync(dst, { recursive: true });
        if (mode === "pointer") {
          writeFileSync(join(dst, "SKILL.md"), pointerBody(name, mode, displayPath, description));
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
  opts: { catalogDir?: string; fromRegistry?: boolean } = {},
): SkillSyncResult {
  const resolvedEngines =
    opts.fromRegistry && (!engines || engines.length === 0)
      ? (ENGINES as unknown as Engine[])
      : engines;
  const mirrors = mirrorsFor(resolvedEngines);
  const errors: string[] = [];
  const warnings: string[] = [];
  const synced: string[] = [];
  let names = skillNames(repo, { catalogDir: opts.catalogDir });
  const canonical = join(repo, CANONICAL);
  const catalog = opts.catalogDir ?? sharedCatalogDir();
  if (opts.fromRegistry) {
    const reg = requiredSkillNames(repo, { catalogDir: opts.catalogDir });
    if (reg.names.length) names = [...new Set([...names, ...reg.names])];
    errors.push(...reg.errors.map((e) => `registry-pinned: ${e}`));
    const lock = parseRegistryLock(repo);
    for (const reg of lock.registries) {
      for (const sk of reg.installed ?? []) {
        if (!sk.bundleHash) {
          warnings.push(
            `"${sk.name}" (registry "${reg.name}"): no bundleHash in lock — reinstall to pin`,
          );
          continue;
        }
        const catDir = join(catalog, sk.name);
        if (!existsSync(catDir)) continue;
        const actual = skillBundleHash(catDir);
        if (actual !== sk.bundleHash) {
          errors.push(
            `"${sk.name}" (registry "${reg.name}"): bundle hash mismatch ` +
              `(expected ${sk.bundleHash.slice(0, 12)}, got ${actual.slice(0, 12)}). ` +
              `Modified outside lock. Restore via: \`vf skills registry install ${reg.name}/${sk.name} --on-collision=replace --yes\``,
          );
        }
      }
    }
  }
  for (const name of names) {
    for (const mirror of mirrors) {
      const dst = join(repo, mirror, name, "SKILL.md");
      if (!existsSync(dst)) {
        errors.push(`${mirror}/${name}/SKILL.md missing`);
      } else {
        const body = readFileSync(dst, "utf8");
        const sourceIsLocal = existsSync(join(repo, CANONICAL, name, "SKILL.md"));
        const source = sourceIsLocal
          ? join(repo, CANONICAL, name, "SKILL.md")
          : join(catalog, name, "SKILL.md");
        const sourceBody = existsSync(source) ? readFileSync(source, "utf8") : "";
        const target = pointerTarget(body);
        const expected = sourceIsLocal
          ? `.vibeflow/skills/${name}/SKILL.md`
          : `~/.vibeflow/skills/${name}/SKILL.md`;
        // Pointer stubs repeat the canonical description verbatim, so a stub
        // that still carries an older copy is stale even when its path is right.
        const stubDescription = parseFrontmatter(body).data.description;
        const canonicalDescription =
          mirrorDescriptionFrom(parseFrontmatter(sourceBody).data.description as string) ??
          PLACEHOLDER_DESCRIPTION;
        if (target !== undefined) {
          if (target !== expected) {
            errors.push(`${mirror}/${name}/SKILL.md points at wrong canonical path`);
          } else if (stubDescription !== canonicalDescription) {
            errors.push(
              `${mirror}/${name}/SKILL.md description differs from canonical (re-run vf skills sync)`,
            );
          } else {
            synced.push(`${mirror}/${name}`);
          }
        } else if (body === sourceBody && sourceBody !== "") {
          synced.push(`${mirror}/${name}`);
        } else {
          errors.push(`${mirror}/${name}/SKILL.md differs from canonical source`);
        }
      }
    }
  }
  return { ok: errors.length === 0, mode: "pointer", synced, errors, warnings };
}
