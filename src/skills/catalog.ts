// src/skills/catalog.ts
//
// Shared skill catalog at ~/.vibeflow/skills/ (issue #631).
// Mirrors the homedir() precedent from src/orchestrator/marker.ts.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** User-scoped shared skill catalog. All projects on this machine share it.
 *  Test seam: VF_SKILLS_HOME overrides the home dir. os.homedir() caches its
 *  result after the first call in a process (Bun), so env.HOME mocks alone
 *  are unreliable across a full test suite — an explicit env var is read
 *  fresh every call, matching the VF_NO_NOTIFY/VF_DENY_TOOLS precedent.
 *  Priority: explicit inject.homedir > VF_SKILLS_HOME > real homedir. */
export function sharedCatalogDir(inject: { homedir?: () => string } = {}): string {
  const home = inject.homedir ? inject.homedir() : (process.env.VF_SKILLS_HOME ?? homedir());
  const dir = join(home, ".vibeflow", "skills");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** List skill names in the shared catalog. */
export function sharedSkillNames(inject: { homedir?: () => string } = {}): string[] {
  const dir = sharedCatalogDir(inject);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => {
    if (n.startsWith(".")) return false;
    try {
      return statSync(join(dir, n)).isDirectory();
    } catch {
      return false;
    }
  });
}

export interface MigrateResult {
  migrated: string[];
  skipped: string[];
  collisions: string[];
  errors: string[];
}

/**
 * Migrate project-scoped .vibeflow/skills/ into ~/.vibeflow/skills/.
 * Name collision policy: last-write-wins with a warning (issue spec).
 * Non-destructive: backs up before overwriting on collision.
 */
export function migrateToSharedCatalog(
  repo: string,
  inject: { homedir?: () => string } = {},
): MigrateResult {
  const projectStore = join(repo, ".vibeflow", "skills");
  const migrated: string[] = [];
  const skipped: string[] = [];
  const collisions: string[] = [];
  const errors: string[] = [];

  if (!existsSync(projectStore)) {
    return { migrated, skipped, collisions, errors };
  }

  const catalog = sharedCatalogDir(inject);
  let entries: string[];
  try {
    entries = readdirSync(projectStore);
  } catch (err) {
    return { migrated, skipped, collisions, errors: [(err as Error).message] };
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      skipped.push(entry);
      continue;
    }
    const src = join(projectStore, entry);
    try {
      if (!statSync(src).isDirectory()) {
        skipped.push(entry);
        continue;
      }
    } catch {
      skipped.push(entry);
      continue;
    }
    // Must have SKILL.md
    if (!existsSync(join(src, "SKILL.md"))) {
      skipped.push(entry);
      continue;
    }

    const dst = join(catalog, entry);
    try {
      if (existsSync(dst)) {
        // Collision: backup existing, then overwrite (last-write-wins)
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const backupDir = join(catalog, ".backup", ts);
        mkdirSync(backupDir, { recursive: true });
        cpSync(dst, join(backupDir, entry), { recursive: true });
        rmSync(dst, { recursive: true, force: true });
        collisions.push(entry);
      }
      // Move: copy then remove source
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
      migrated.push(entry);
    } catch (err) {
      errors.push(`${entry}: ${(err as Error).message}`);
    }
  }

  return { migrated, skipped, collisions, errors };
}
