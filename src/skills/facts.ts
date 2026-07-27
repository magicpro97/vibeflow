// #666: domain fact ownership registry
// Reads/validates .vibeflow/DOMAIN_FACTS.json

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../core.js";
import { out } from "../logbus.js";
import { discoverSkills } from "./registry.js";

export interface DomainFact {
  key: string;
  owner: string;
  version: string;
  statement: string;
  dependents?: string[];
}

export interface DomainFactsFile {
  schemaVersion: number;
  facts: DomainFact[];
}

export function readDomainFacts(
  repo: string,
  inject?: {
    readFileSync?: (path: string, encoding: string) => string;
    existsSync?: (path: string) => boolean;
  },
): DomainFactsFile | null {
  const rf = inject?.readFileSync ?? readFileSync;
  const ef = inject?.existsSync ?? existsSync;
  const path = join(repo, ".vibeflow", "DOMAIN_FACTS.json");
  if (!ef(path)) return null;
  const raw = rf(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Malformed DOMAIN_FACTS.json: invalid JSON");
  }
  const file = parsed as DomainFactsFile;
  if (!file || typeof file !== "object" || !Array.isArray(file.facts)) {
    throw new Error("Malformed DOMAIN_FACTS.json: missing facts array");
  }
  return file;
}

export function validateDomainFacts(
  file: DomainFactsFile,
  catalogSkillNames: string[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const seen = new Map<string, string[]>();

  for (const fact of file.facts) {
    // Track owners by key for duplicate detection
    const prev = seen.get(fact.key);
    if (prev) {
      if (!prev.includes(fact.owner)) {
        errors.push(
          `Duplicate key "${fact.key}" with different owners: "${prev[0]}" and "${fact.owner}"`,
        );
      } else {
        errors.push(`Duplicate key "${fact.key}"`);
      }
    }
    seen.set(fact.key, [...(prev ?? []), fact.owner]);

    if (!catalogSkillNames.includes(fact.owner)) {
      errors.push(`Owner "${fact.owner}" for key "${fact.key}" not in skill catalog`);
    }

    if (!fact.statement || (typeof fact.statement === "string" && fact.statement.trim() === "")) {
      warnings.push(`Missing or empty statement for key "${fact.key}"`);
    }
    if (!fact.version || (typeof fact.version === "string" && fact.version.trim() === "")) {
      warnings.push(`Missing or empty version for key "${fact.key}"`);
    }
    if (fact.dependents) {
      for (const dep of fact.dependents) {
        if (!catalogSkillNames.includes(dep)) {
          warnings.push(`Dependent "${dep}" for key "${fact.key}" not in skill catalog`);
        }
      }
    }
  }

  return { errors, warnings };
}

export function handleFactsSubcommand(repo: string, rest: string[]): number {
  const subSub = rest[0];

  if (subSub === "list") {
    const file = readDomainFacts(repo);
    if (!file) {
      out("vf", c.dim("No DOMAIN_FACTS.json found."));
      return 0;
    }
    for (const fact of file.facts) {
      out("vf", `${fact.key} → ${fact.owner} (v${fact.version})`);
    }
    return 0;
  }

  if (subSub === "check") {
    const file = readDomainFacts(repo);
    if (!file) {
      out("vf", c.dim("No DOMAIN_FACTS.json found."));
      return 0;
    }
    const catalog = discoverSkills(repo).map((s) => s.name);
    const result = validateDomainFacts(file, catalog);
    for (const e of result.errors) out("vf", c.red(`✗ ${e}`));
    for (const w of result.warnings) out("vf", c.yellow(`! ${w}`));
    return result.errors.length > 0 ? 1 : 0;
  }

  out("vf", c.dim("Usage: vf skills facts list|check"));
  return 2;
}
