// size-waiver: #656 — adapter resolution: load base, merge frontmatter + body

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";

export interface AdapterResolveResult {
  /**
   * #656: adapter resolution warnings. Empty when resolution succeeds
   * cleanly; non-empty when base version is stale, missing, or the pin
   * has drifted.
   */
  warnings: string[];

  /**
   * #656: fully resolved adapter skill. `resolvedBody` is the merged
   * body (base body with adapter overrides applied). Frontmatter fields
   * that the adapter does NOT override are inherited from the base.
   * When the base skill cannot be resolved, the adapter's own body is
   * used as-is and the base is not applied.
   */
  resolved: Skill;
}

const EXTENDS_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)(?:@(\d+\.\d+\.\d+))?$/;

function parseExtends(v: string): { baseName: string; version?: string } | null {
  const m = EXTENDS_RE.exec(v.trim());
  const baseName = m?.[1];
  if (!baseName) return null;
  return { baseName, version: m[2] ?? undefined };
}

/**
 * Merge two markdown bodies: apply adapter section-level overrides onto the
 * base. Walk base body headings at H1/H2 level; if an adapter heading text
 * matches exactly (same heading marker and same text), replace that section.
 * Sections that don't match are appended at the end. Headings deeper than H2
 * are treated as sub-sections of the nearest H1/H2 parent and are replaced
 * together with their parent section.
 *
 * This is intentionally a simple heading-matching merge. No tree diffing,
 * no AST parsing — keeps VibeFlow dependency-free.
 */
export function mergeBodies(baseBody: string, adapterBody: string): string {
  if (!adapterBody.trim()) return baseBody;
  const adapterSections = splitSections(adapterBody);
  if (!adapterSections.length) return adapterBody.trim();

  const baseSections = splitSections(baseBody);
  if (!baseSections.length) return adapterBody.trim();
  if (baseSections.every((section) => !section.heading)) return adapterBody.trim();

  const adapterByHeading = new Map<string, string>();
  for (const s of adapterSections) {
    adapterByHeading.set(normalizeHeading(s.heading), s.body);
  }

  const out: string[] = [];
  const replaced = new Set<number>();

  for (const [i, bs] of baseSections.entries()) {
    const key = normalizeHeading(bs.heading);
    const override = adapterByHeading.get(key);
    if (override !== undefined) {
      out.push(`${bs.heading}\n${override}`);
      replaced.add(i);
    } else {
      out.push(`${bs.heading}\n${bs.body}`);
    }
  }

  // Append adapter sections that didn't replace anything
  for (const a of adapterSections) {
    const key = normalizeHeading(a.heading);
    const alreadyReplaced = baseSections.some(
      (bs, j) => replaced.has(j) && normalizeHeading(bs.heading) === key,
    );
    if (!alreadyReplaced) {
      // Check if any base section has this heading (not through replaced)
      const inBase = baseSections.some((bs) => normalizeHeading(bs.heading) === key);
      if (!inBase) {
        out.push(`\n${a.heading}\n${a.body}`);
      }
    }
  }

  return out.join("\n");
}

interface Section {
  heading: string;
  body: string;
}

function splitSections(body: string): Section[] {
  if (!body.trim()) return [];
  const sections: Section[] = [];
  let currentHeading = "";
  let currentBody: string[] = [];

  for (const line of body.split("\n")) {
    const headingMatch = line.trim().match(/^(#{1,2})\s+(.+)$/);
    if (headingMatch) {
      if (currentHeading || currentBody.length) {
        sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
      }
      currentHeading = line;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  if (currentHeading || currentBody.length) {
    sections.push({ heading: currentHeading, body: currentBody.join("\n").trim() });
  }
  return sections;
}

function normalizeHeading(line: string): string {
  return line.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * #656: Resolve an adapter skill against its base skill. Returns the resolved
 * skill with merged content, plus any warnings.
 *
 * Resolution rules:
 * 1. Base skill must exist in `allSkills` by name
 * 2. If base declares a version and adapter pins `@version`, they must match
 * 3. Frontmatter: adapter fields shallow-merge ON TOP of base (adapter wins)
 * 4. Body: adapter H1/H2 sections replace matching base sections; new sections
 *    append. Adapter body also replaces base body in the Skill object.
 * 5. Adapter's dir/path remain unchanged — base skill source is NOT modified.
 */
export function resolveAdapter(
  adapterSkill: Skill,
  allSkills: Skill[],
  inject: {
    readFileSync?: (path: string, enc: string) => string;
    existsSync?: (path: string) => boolean;
  } = {},
): AdapterResolveResult {
  const warnings: string[] = [];
  const _readFileSync = inject.readFileSync ?? readFileSync;
  const _existsSync = inject.existsSync ?? existsSync;

  const adapterExtends = adapterSkill.extends;
  if (!adapterExtends || adapterExtends.length === 0) {
    return { warnings, resolved: adapterSkill };
  }

  let mergedBody: string | undefined;
  let mergedFm: Record<string, unknown> | undefined;

  for (const ext of adapterExtends) {
    const parsed = parseExtends(ext);
    if (!parsed) {
      warnings.push(
        `adapter "${adapterSkill.name}": invalid extends entry "${ext}" — expected "<skill-name>[@<version>]"`,
      );
      continue;
    }

    const base = allSkills.find((s) => s.name === parsed.baseName);
    if (!base) {
      warnings.push(
        `adapter "${adapterSkill.name}": extends base skill "${parsed.baseName}" not found — adapter uses its own body as-is`,
      );
      continue;
    }

    // Version pin check
    if (parsed.version) {
      const baseVersion = base.version;
      if (!baseVersion) {
        warnings.push(
          `adapter "${adapterSkill.name}": pins base "${parsed.baseName}@${parsed.version}" but base has no version field — consider removing the @version pin or adding a version to the base skill`,
        );
      } else if (baseVersion !== parsed.version) {
        warnings.push(
          `adapter "${adapterSkill.name}": pins base "${parsed.baseName}@${parsed.version}" but installed base is version "${baseVersion}" — update the pin or reinstall the base`,
        );
      }
    } else {
      // No version pin — mild nudge if base has one
      if (base.version) {
        warnings.push(
          `adapter "${adapterSkill.name}": extends "${parsed.baseName}" without version pin — recommended: "${parsed.baseName}@${base.version}"`,
        );
      }
    }

    // Read base first so its fields are inherited unless adapter overrides them.
    let baseBody = "";
    let baseFm: Record<string, unknown> = {};
    try {
      if (!_existsSync(base.path)) throw new Error("SKILL.md not found");
      const raw = _readFileSync(base.path, "utf8");
      const parsedBase = parseFrontmatter(raw);
      baseBody = base.resolvedBody ?? parsedBase.body;
      baseFm = parsedBase.data;
    } catch {
      warnings.push(
        `adapter "${adapterSkill.name}": cannot read base skill "${parsed.baseName}" body — using adapter body only`,
      );
    }

    let adapterBody = "";
    let adapterFm: Record<string, unknown> = {};
    try {
      if (_existsSync(adapterSkill.path)) {
        const raw = _readFileSync(adapterSkill.path, "utf8");
        const parsedAdapter = parseFrontmatter(raw);
        adapterBody = parsedAdapter.body;
        adapterFm = parsedAdapter.data;
      }
    } catch {
      warnings.push(`adapter "${adapterSkill.name}": cannot read adapter body`);
    }
    mergedFm = { ...(mergedFm ?? {}), ...baseFm, ...adapterFm };

    if (baseBody && adapterBody) {
      mergedBody = mergeBodies(baseBody, adapterBody);
    } else if (adapterBody) {
      mergedBody = adapterBody;
    } else {
      mergedBody = baseBody;
    }
  }

  if (!mergedBody) {
    // No base resolved; use adapter's own body
    try {
      if (_existsSync(adapterSkill.path)) {
        const raw = _readFileSync(adapterSkill.path, "utf8");
        const parsed = parseFrontmatter(raw);
        mergedBody = parsed.body || undefined;
      }
    } catch {
      // Leave undefined
    }
  }

  const resolved: Skill = {
    ...adapterSkill,
    resolvedBody: mergedBody,
  };

  // If we have merged frontmatter, override the adapter skill's capabilities
  // and triggers from the base (unless the adapter explicitly sets them).
  // This is a shallow merge: base fields that the adapter doesn't override
  // remain from the base.
  // Inherit base capabilities/triggers if adapter leaves them undefined
  const baseSkillObj = allSkills.find(
    (s) => s.name === parseExtends(adapterExtends[0] ?? "")?.baseName,
  );
  if (!adapterSkill.capabilities && baseSkillObj?.capabilities) {
    resolved.capabilities = baseSkillObj.capabilities;
  }
  if (!adapterSkill.triggers && baseSkillObj?.triggers) {
    resolved.triggers = baseSkillObj.triggers;
  }

  if (mergedFm) {
    if (!resolved.capabilities && Array.isArray(mergedFm.capabilities)) {
      resolved.capabilities = mergedFm.capabilities as string[];
    }
    if (!resolved.triggers && Array.isArray(mergedFm.triggers)) {
      resolved.triggers = mergedFm.triggers as string[];
    }
  }

  return { warnings, resolved };
}

/**
 * #656: resolve ALL adapter skills in a set. Called from discoverSkills after
 * the initial scan. Skills without `extends` pass through unchanged.
 * Adapter skills with valid extends get their `resolvedBody` set.
 */
export function resolveAllAdapters(
  skills: Skill[],
  inject?: {
    readFileSync?: (path: string, enc: string) => string;
    existsSync?: (path: string) => boolean;
  },
): {
  skills: Skill[];
  warnings: string[];
} {
  const warnings: string[] = [];

  // Resolve adapters in dependency order (skills without extends first,
  // then skills whose bases are already resolved). Simple iterative
  // approach: keep resolving until stable.
  const resolved = new Map<string, Skill>();
  const unresolved = [...skills];

  let changed = true;
  while (changed) {
    changed = false;
    const remaining: Skill[] = [];
    for (const skill of unresolved) {
      if (!skill.extends || skill.extends.length === 0) {
        resolved.set(skill.name, skill);
        changed = true;
        continue;
      }

      // Check if all bases are resolved
      const allBasesResolved = skill.extends.every((ext) => {
        const parsed = parseExtends(ext);
        return parsed && resolved.has(parsed.baseName);
      });

      if (allBasesResolved) {
        const result = resolveAdapter(skill, [...resolved.values()], inject);
        warnings.push(...result.warnings);
        resolved.set(skill.name, result.resolved);
        changed = true;
      } else {
        remaining.push(skill);
      }
    }
    unresolved.length = 0;
    unresolved.push(...remaining);
  }

  // Any remaining unresolved adapters — try to resolve anyway (bases may be missing)
  for (const skill of unresolved) {
    const result = resolveAdapter(skill, [...resolved.values()], inject);
    warnings.push(...result.warnings);
    resolved.set(skill.name, result.resolved);
  }

  return {
    skills: [...resolved.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}
