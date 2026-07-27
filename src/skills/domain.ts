// #665: domain ownership — extracted from validator.ts, registry.ts, skills.ts
// to keep those files under the 400-line cap.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "../core.js";
import { c } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import { discoverSkills } from "./registry.js";
import type { SkillValidationResult } from "./validator.js";
import { validateSkillRoots } from "./validator.js";

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x)).filter(Boolean);
  return out.length ? out : undefined;
}

export function validateDomainKeys(data: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  if (data["domain.id"] !== undefined) {
    if (
      typeof data["domain.id"] !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data["domain.id"])
    ) {
      warnings.push("frontmatter.domain.id must be lowercase kebab-case");
    }
  }

  if (data["domain.role"] !== undefined) {
    const role =
      typeof data["domain.role"] === "string" ? data["domain.role"].trim().toLowerCase() : "";
    if (role !== "canonical" && role !== "child") {
      warnings.push('frontmatter.domain.role must be "canonical" or "child"');
    }
  }

  if (data.owns !== undefined) {
    if (!Array.isArray(data.owns) || !data.owns.every((x: unknown) => typeof x === "string")) {
      warnings.push("frontmatter.owns must be an array of strings");
    }
  }

  if (data.dependsOn !== undefined) {
    if (
      !Array.isArray(data.dependsOn) ||
      !data.dependsOn.every((x: unknown) => typeof x === "string")
    ) {
      warnings.push("frontmatter.dependsOn must be an array of strings");
    }
  }

  return warnings;
}

export function checkDomainOwnership(skills: SkillValidationResult[]): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  const canonicalByDomain = new Map<string, string[]>();
  const childInfos: Array<{ name: string; dependsOn: string[]; domainRole?: string }> = [];

  for (const skill of skills) {
    if (!skill.ok || !skill.name) continue;
    const text = readFileSync(join(skill.dir, "SKILL.md"), "utf8");
    const { data } = parseFrontmatter(text);
    const domainId = typeof data["domain.id"] === "string" ? data["domain.id"] : undefined;
    const domainRole =
      typeof data["domain.role"] === "string"
        ? data["domain.role"].trim().toLowerCase()
        : undefined;
    const dependsOn = Array.isArray(data.dependsOn)
      ? data.dependsOn.filter((x: unknown) => typeof x === "string")
      : [];

    if (domainRole === "canonical" && domainId) {
      const list = canonicalByDomain.get(domainId) ?? [];
      list.push(skill.name);
      canonicalByDomain.set(domainId, list);
    }

    childInfos.push({ name: skill.name, dependsOn, domainRole });
  }

  const canonicalDomainIds = new Set(canonicalByDomain.keys());

  for (const { name, dependsOn, domainRole } of childInfos) {
    if (domainRole === "child" && dependsOn.length === 0) {
      warnings.push(`skill "${name}" has role "child" but no dependsOn entries`);
    }
    if (dependsOn.length > 0) {
      for (const ref of dependsOn) {
        if (!canonicalDomainIds.has(ref)) {
          warnings.push(
            `skill "${name}" depends on domain.id "${ref}" which has no canonical owner`,
          );
        }
      }
    }
  }

  for (const [domainId, names] of canonicalByDomain) {
    if (names.length > 1) {
      errors.push(
        `domain.id "${domainId}" has ${names.length} canonical skills: ${names.join(", ")}`,
      );
    }
  }

  return { errors, warnings };
}

export function parseDomainMeta(
  data: Record<string, unknown>,
): Pick<Skill, "domain" | "owns" | "dependsOn"> {
  const domainRaw = data.domain;
  let domain: Skill["domain"] =
    domainRaw && typeof domainRaw === "object" && !Array.isArray(domainRaw)
      ? {
          id:
            typeof (domainRaw as Record<string, unknown>).id === "string"
              ? ((domainRaw as Record<string, unknown>).id as string)
              : undefined,
          role:
            typeof (domainRaw as Record<string, unknown>).role === "string" &&
            ((domainRaw as Record<string, unknown>).role === "canonical" ||
              (domainRaw as Record<string, unknown>).role === "child")
              ? ((domainRaw as Record<string, unknown>).role as "canonical" | "child")
              : undefined,
        }
      : undefined;

  if (!domain) {
    const dotId = typeof data["domain.id"] === "string" ? data["domain.id"] : undefined;
    const dotRole = typeof data["domain.role"] === "string" ? data["domain.role"] : undefined;
    if (dotId || dotRole) {
      domain = {
        id: dotId,
        role: dotRole === "canonical" || dotRole === "child" ? dotRole : undefined,
      };
    }
  }

  const owns = asStringArray(data.owns);
  const dependsOn = asStringArray(data.dependsOn);

  return { domain, owns, dependsOn };
}

export function handleDomainSubcommand(repo: string, rest: string[]): number {
  const subSub = rest[0];
  if (subSub === "list") {
    const result = validateSkillRoots(repo);
    const ownership = checkDomainOwnership(result.skills);
    for (const e of ownership.errors) out("vf", c.red(`✗ ${e}`));
    for (const w of ownership.warnings) out("vf", c.yellow(`! ${w}`));
    const found = discoverSkills(repo);
    if (!found.length) {
      out("vf", c.dim("No skills discovered."));
      return 0;
    }
    const byDomain = new Map<string, typeof found>();
    const noDomain: typeof found = [];
    for (const skill of found) {
      if (skill.domain?.id) {
        const list = byDomain.get(skill.domain.id) ?? [];
        list.push(skill);
        byDomain.set(skill.domain.id, list);
      } else {
        noDomain.push(skill);
      }
    }
    if (byDomain.size === 0) {
      out("vf", c.dim("No skills with domain.id declared."));
      return 0;
    }
    for (const [did, skills] of byDomain) {
      const canonical = skills.find((s) => s.domain?.role === "canonical");
      const children = skills.filter((s) => s.domain?.role !== "canonical");
      const prefix = canonical ? c.green(`✔ ${did} (canonical)`) : c.yellow(`? ${did}`);
      out("vf", prefix);
      if (canonical) {
        const owned = canonical.owns?.length ? canonical.owns.join(", ") : "";
        out("vf", c.dim(`  canonical: ${canonical.name}${owned ? ` owns: [${owned}]` : ""}`));
      }
      for (const child of children) {
        const deps = child.dependsOn?.length ? ` dependsOn: [${child.dependsOn.join(", ")}]` : "";
        out("vf", c.dim(`  child: ${child.name}${deps}`));
      }
    }
    if (noDomain.length > 0) {
      out("vf", c.dim(`${noDomain.length} skill(s) without domain.id`));
    }
    return ownership.errors.length > 0 ? 1 : 0;
  }
  out("vf", c.dim("Usage: vf skills domain list"));
  return 2;
}
