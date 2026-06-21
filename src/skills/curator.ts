import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The 3-arg form of spawnSync used by the curator (command, args, options). */
type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => ReturnType<typeof spawnSync>;
import { CTX_DIR, type Engine } from "../core.js";
import { pruneUnselectedEngineFolders } from "../workflow-artifacts.js";
import { curatorCacheKeyForProject, readCuratorCache, writeCuratorCache } from "./curator-cache.js";
import { importSkillsFromParent } from "./importer.js";
import { syncSkillMirrors } from "./sync.js";
import { DEFAULT_WHITELIST } from "./whitelist.js";
import type { WhitelistEntry } from "./whitelist.js";

export { DEFAULT_WHITELIST } from "./whitelist.js";
export type { WhitelistEntry } from "./whitelist.js";

/**
 * Resolve a detected component name against the whitelist.
 * Case-insensitive, prefix-match (e.g. "PostgreSQL 16" → "postgresql").
 */
function matchWhitelist(rawName: string, whitelist: WhitelistEntry[]): WhitelistEntry | undefined {
  const lower = rawName
    .toLowerCase()
    .replace(/[\s-]+/g, " ")
    .trim();
  // Exact match on keyword
  const exact = whitelist.find((e) => e.keyword.toLowerCase() === lower);
  if (exact) return exact;
  // Prefix match: "spring boot 3.3.10" -> "spring boot"
  for (const entry of whitelist) {
    if (
      lower.startsWith(`${entry.keyword.toLowerCase()} `) ||
      lower.startsWith(`${entry.keyword.toLowerCase()}.`)
    ) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Read stack-evidence.md and extract component names.
 * Returns all rows from the markdown table that have a non-trivial value,
 * ignoring confidence/source columns.
 */
export function extractStackComponents(base: string): string[] {
  const path = join(base, CTX_DIR, "ai-context", "stack-evidence.md");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const components: string[] = [];
  for (const line of lines) {
    // Detect markdown table row: `| Name | Value | ...`
    if (line.startsWith("|") && line.endsWith("|")) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length >= 2) {
        const name = cells[0]?.toLowerCase() ?? "";
        const value = cells[1] ?? "";
        // Skip header, separator, and metadata-only rows
        if (
          name !== "" &&
          !name.startsWith("---") &&
          !name.match(/^(component|name|column|parameter|field)\s*$/) &&
          value.length > 2
        ) {
          components.push(value);
        }
      }
    }
  }
  return components;
}

/**
 * Result of the deterministic skill curation pass. The AI skill-curator
 * unit reads `unmatched` to know which tech keywords still need a skill
 * (it should handle the gap — usually by authoring from `ctx7 docs`).
 */
export interface CurateResult {
  /** Skill names newly installed into .vibeflow/skills/. */
  installed: string[];
  /** Tech keywords (lowercased, version-stripped) that did NOT match the
   *  whitelist. The AI skill-curator unit is expected to handle these. */
  unmatched: string[];
}

/**
 * Deterministic skill curation: read stack-evidence.md → whitelist match →
 * ctx7 install → import canonical → sync engine mirror → prune scratch
 * dirs → record unmatched tech for the AI skill-curator fallback.
 *
 * Idempotent: skips skills already in .vibeflow/skills/<name>/. Safe to
 * call multiple times (from both init and orchestrate loops).
 *
 * Side effect: writes `.vibeflow/ai-context/unmatched-tech.txt` listing
 * tech keywords that did not match the whitelist. The AI skill-curator
 * reads this file to know which tech still needs a skill. Always
 * written (even when empty) so the AI can rely on its existence.
 *
 * @returns installed + unmatched lists.
 */
export function curateSkillsFromEvidence(
  base: string,
  engine: Engine,
  options: {
    /** Override whitelist (defaults to DEFAULT_WHITELIST). */
    whitelist?: WhitelistEntry[];
    /** Whether ctx7 CLI is authenticated. When false/undefined, skip ctx7 install. */
    ctx7Authenticated?: boolean;
    /** Scratch dir path (default .agents/skills). */
    scratchDir?: string;
    /** Bypass the cache even on a hit (test seam + manual `--no-cache`). */
    skipCache?: boolean;
    /** Injectable child-process spawner (test seam). Defaults to node:child_process#spawnSync. */
    inject?: { spawnSync?: SpawnSyncFn };
  } = {},
): CurateResult {
  const whitelist = options.whitelist ?? DEFAULT_WHITELIST;
  const scratch = options.scratchDir ?? join(".agents", "skills");
  const _spawnSync = options.inject?.spawnSync ?? spawnSync;

  // 0. Cache short-circuit. The deterministic curator is purely a
  //    function of (stack-evidence.md + project-profile.json) — a
  //    re-run on the same inputs MUST produce the same installed +
  //    unmatched lists. Skipping the ctx7 + import + sync + prune
  //    pipeline on a cache hit saves ~1-2s of wall + avoids
  //    duplicate ctx7 binary calls (which contribute to the
  //    upstream ctx7 rate-limit on the CLI side).
  if (!options.skipCache) {
    const hash = curatorCacheKeyForProject(base);
    if (hash) {
      const hit = readCuratorCache(base, hash);
      if (hit) {
        // Still write the unmatched file (it's a side effect the AI
        // skill-curator reads), and still prune stale engine folders
        // (mirrors can have drifted since the cache entry was written).
        writeUnmatchedFile(base, hit.unmatched);
        pruneUnselectedEngineFolders(base, engine);
        return { installed: hit.installed, unmatched: hit.unmatched };
      }
    }
  }

  const installed: string[] = [];
  const unmatched: string[] = [];

  // 1. Extract components from stack-evidence.md
  const components = extractStackComponents(base);
  if (components.length === 0) {
    writeUnmatchedFile(base, unmatched);
    if (!options.skipCache) {
      const hash = curatorCacheKeyForProject(base);
      if (hash) writeCuratorCache(base, hash, installed, unmatched);
    }
    return { installed, unmatched };
  }

  // 2. Flatten component values into individual tech names.
  //    "Java 21 (primary), JS/TS (browser/E2E), Python (VMC)" →
  //    ["java", "javascript", "typescript", "python"]
  const techNames: string[] = [];
  for (const val of components) {
    const parts = val
      .split(/[,;]/)
      .map((p) => p.replace(/\(.*?\)/g, "").trim())
      .filter(Boolean);
    for (const p of parts) {
      const normalized = p
        .toLowerCase()
        .replace(/[\d][\d.]*$/, "")
        .replace(/[^a-z\s-]+/g, "")
        .trim();
      if (normalized.length >= 3 && !techNames.includes(normalized)) {
        techNames.push(normalized);
      }
    }
  }

  // 3. Match against whitelist. Track which tech names did NOT match so
  //    the AI skill-curator can fall back on them.
  const matched = new Set<WhitelistEntry>();
  for (const tech of techNames) {
    const entry = matchWhitelist(tech, whitelist);
    if (entry) {
      matched.add(entry);
    } else {
      unmatched.push(tech);
    }
  }
  // Persist the unmatched list BEFORE doing any ctx7 work, so the AI
  // skill-curator can read it even if the rest of the pipeline fails.
  writeUnmatchedFile(base, unmatched);

  if (matched.size === 0) return { installed, unmatched };

  // 4. For each matched entry, ctx7 install to scratch dir.
  //    Only runs when ctx7 is explicitly authenticated (test runners and
  //    offline modes pass undefined/false and skip this step).
  if (options.ctx7Authenticated === true) {
    const byRepo = new Map<string, WhitelistEntry[]>();
    for (const entry of matched) {
      const list = byRepo.get(entry.repo) ?? [];
      list.push(entry);
      byRepo.set(entry.repo, list);
    }
    for (const [repo, entries] of byRepo) {
      mkdirSync(join(base, scratch), { recursive: true });
      for (const entry of entries) {
        const skillDir = join(base, scratch, entry.skill);
        if (existsSync(skillDir)) continue; // already installed
        const result = _spawnSync(
          "npx",
          ["ctx7", "skills", "install", "--yes", "--universal", repo, entry.skill],
          { cwd: base, timeout: 60_000, stdio: "pipe" },
        );
        if (result.status !== 0) {
        }
      }
    }
  }

  // 5. Import installed skills from scratch dir to canonical.
  if (existsSync(join(base, scratch))) {
    const importResult = importSkillsFromParent(base, join(base, scratch));
    installed.push(...importResult.imported);
  }

  // 6. Sync canonical to the selected engine mirror only.
  if (installed.length > 0) {
    syncSkillMirrors(base, { mode: "pointer", engines: [engine] });
  }

  // 7. Prune scratch dirs for non-selected engines.
  pruneUnselectedEngineFolders(base, engine);

  // 8. Persist cache entry so the next `vf init` on the same inputs
  //    short-circuits this whole pipeline. Best-effort — see
  //    `writeCuratorCache` for failure semantics.
  if (!options.skipCache) {
    const hash = curatorCacheKeyForProject(base);
    if (hash) writeCuratorCache(base, hash, installed, unmatched);
  }

  return { installed, unmatched };
}

/**
 * Write the unmatched-tech list to .vibeflow/ai-context/unmatched-tech.txt.
 * The file is always written (even when empty) so the AI skill-curator
 * can rely on its existence. Format: one tech keyword per line, no
 * header — the AI reads it as a plain list.
 */
function writeUnmatchedFile(base: string, unmatched: string[]): void {
  const path = join(base, CTX_DIR, "ai-context", "unmatched-tech.txt");
  const dir = join(base, CTX_DIR, "ai-context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, unmatched.join("\n") + (unmatched.length > 0 ? "\n" : ""));
}
