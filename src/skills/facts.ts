// #666: domain fact ownership registry
// Reads/validates .vibeflow/DOMAIN_FACTS.json

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import { discoverSkills } from "./registry.js";

const ID_SAFE_RE = /^[a-zA-Z0-9_-]+$/;
const HAS_CONTROL_CHAR = new RegExp(`[${String.fromCharCode(0, 31)}\\x7f]`);
const HAS_PATH_TRAVERSAL = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

function isUnsafeIdentifier(v: string): boolean {
  return HAS_CONTROL_CHAR.test(v) || HAS_PATH_TRAVERSAL.test(v) || !ID_SAFE_RE.test(v);
}

export interface DomainFact {
  key: string;
  owner: string;
  version: string;
  statement: string;
  dependents?: string[];
  /** #667: repo-relative path prefixes this fact covers. Each must be safe (no traversal, no absolute). */
  paths?: string[];
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

/** Schema-validate a single fact entry from untrusted input. Returns error/warning. */
function validateFactEntry(
  entry: unknown,
  index: number,
  catalogSkillNames: string[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`Fact[${index}]: not an object`);
    return { errors, warnings };
  }
  const f = entry as Record<string, unknown>;
  const label = typeof f.key === "string" ? `"${f.key}"` : `[${index}]`;

  if (typeof f.key !== "string" || !f.key) {
    errors.push(`Fact${label}: missing or non-string key`);
  } else if (isUnsafeIdentifier(f.key)) {
    errors.push(`Fact"${f.key}": unsafe key (control char, path traversal, or invalid chars)`);
  }

  if (typeof f.owner !== "string" || !f.owner) {
    errors.push(`Fact${label}: missing or non-string owner`);
  } else if (isUnsafeIdentifier(f.owner)) {
    errors.push(
      `Fact"${f.key ?? label}": unsafe owner (control char, path traversal, or invalid chars)`,
    );
  } else if (!catalogSkillNames.includes(f.owner)) {
    errors.push(`Owner "${f.owner}" for key "${f.key}" not in skill catalog`);
  }

  if (typeof f.version !== "string" || f.version.trim() === "") {
    errors.push(`Fact${label}: missing or empty version`);
  }
  if (typeof f.statement !== "string" || f.statement.trim() === "") {
    errors.push(`Fact${label}: missing or empty statement`);
  }

  if (f.dependents !== undefined) {
    if (!Array.isArray(f.dependents)) {
      warnings.push(`Fact"${f.key}": dependents must be an array`);
    } else {
      for (let di = 0; di < f.dependents.length; di++) {
        const dep = f.dependents[di];
        if (typeof dep !== "string") {
          warnings.push(`Fact"${f.key}": dependents[${di}] is not a string`);
        } else if (isUnsafeIdentifier(dep)) {
          warnings.push(
            `Fact"${f.key}": dependent "${dep}" is unsafe (control char, path traversal, or invalid chars)`,
          );
        } else if (!catalogSkillNames.includes(dep)) {
          warnings.push(`Dependent "${dep}" for key "${f.key}" not in skill catalog`);
        }
      }
    }
  }

  if (f.paths !== undefined) {
    if (!Array.isArray(f.paths)) {
      warnings.push(`Fact"${f.key}": paths must be an array`);
    } else {
      for (let pi = 0; pi < f.paths.length; pi++) {
        const p = f.paths[pi];
        if (typeof p !== "string") {
          warnings.push(`Fact"${f.key}": paths[${pi}] is not a string`);
        } else if (isUnsafePath(p)) {
          warnings.push(
            `Fact"${f.key}": paths[${pi}] "${p}" is unsafe (absolute, traversal, backslash, or NUL)`,
          );
        }
      }
    }
  }

  return { errors, warnings };
}

function isUnsafePath(p: string): boolean {
  return p.startsWith("/") || p.includes("..") || p.includes("\\") || p.includes("\0");
}

export function validateDomainFacts(
  file: DomainFactsFile,
  catalogSkillNames: string[],
  inject?: {
    readFileSync?: (path: string, encoding: string) => string;
    existsSync?: (path: string) => boolean;
    repo?: string;
  },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Schema validation per entry
  for (let i = 0; i < file.facts.length; i++) {
    const r = validateFactEntry(file.facts[i], i, catalogSkillNames);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  // Duplicate key detection among schema-valid entries (string-keyed only)
  const seen = new Map<string, string[]>();
  for (const fact of file.facts) {
    if (!fact || typeof fact.key !== "string") continue;
    const prev = seen.get(fact.key);
    if (prev) {
      if (typeof fact.owner !== "string") continue;
      if (!prev.includes(fact.owner)) {
        errors.push(
          `Duplicate key "${fact.key}" with different owners: "${prev[0]}" and "${fact.owner}"`,
        );
      } else {
        errors.push(`Duplicate key "${fact.key}"`);
      }
    }
    seen.set(fact.key, [...(prev ?? []), String(fact.owner ?? "")]);
  }

  return { errors, warnings };
}

/** Scan skill frontmatter `owns` for duplicate fact claims across skills. */
export function checkSkillsOwnsConflicts(
  repo: string,
  inject?: {
    readFileSync?: (path: string, encoding: string) => string;
    existsSync?: (path: string) => boolean;
  },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const skills = discoverSkills(repo);
  const ownedBy = new Map<string, string[]>();

  for (const skill of skills) {
    if (!skill.dir) continue;
    const rf = inject?.readFileSync ?? readFileSync;
    const ef = inject?.existsSync ?? existsSync;
    const skillMd = join(skill.dir, "SKILL.md");
    if (!ef(skillMd)) continue;
    let text: string;
    try {
      text = rf(skillMd, "utf8");
    } catch {
      continue;
    }
    const { data } = parseFrontmatter(text);
    const owns = Array.isArray(data.owns)
      ? data.owns.filter((x: unknown) => typeof x === "string")
      : [];
    for (const factKey of owns) {
      if (isUnsafeIdentifier(factKey)) {
        warnings.push(`Skill "${skill.name}": owns contains unsafe fact key "${factKey}"`);
        continue;
      }
      const prev = ownedBy.get(factKey);
      if (prev && !prev.includes(skill.name)) {
        errors.push(
          `Fact key "${factKey}" claimed by multiple skills: "${prev[0]}" and "${skill.name}"`,
        );
      }
      ownedBy.set(factKey, [...(prev ?? []), skill.name]);
    }
  }

  return { errors, warnings };
}

export function handleFactsSubcommand(repo: string, rest: string[]): number {
  const subSub = rest[0];

  if (subSub === "list") {
    let file: DomainFactsFile | null;
    try {
      file = readDomainFacts(repo);
    } catch (e) {
      out("vf", c.red(`✗ ${(e as Error).message}`));
      return 1;
    }
    if (!file) {
      out("vf", c.dim("No DOMAIN_FACTS.json found."));
      return 0;
    }
    for (const fact of file.facts) out("vf", `${fact.key} → ${fact.owner} (v${fact.version})`);
    return 0;
  }

  if (subSub === "check") {
    let file: DomainFactsFile | null;
    try {
      file = readDomainFacts(repo);
    } catch (e) {
      out("vf", c.red(`✗ ${(e as Error).message}`));
      return 1;
    }
    if (!file) {
      out("vf", c.dim("No DOMAIN_FACTS.json found."));
      return 0;
    }
    const catalog = discoverSkills(repo).map((s) => s.name);
    const result = validateDomainFacts(file, catalog);
    const ownsResult = checkSkillsOwnsConflicts(repo);
    const allErrors = [...result.errors, ...ownsResult.errors];
    const allWarnings = [...result.warnings, ...ownsResult.warnings];
    for (const e of allErrors) out("vf", c.red(`✗ ${e}`));
    for (const w of allWarnings) out("vf", c.yellow(`! ${w}`));
    return allErrors.length > 0 ? 1 : 0;
  }

  out("vf", c.dim("Usage: vf skills facts list|check"));
  return 2;
}
