// #668: audit skill catalog for duplicate patterns — owns fact collisions,
// trigger Jaccard overlap >0.7, and duplicate procedure sections with line refs.
// No LLM / no semantic similarity. Deterministic, case-insensitive, sorted output.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import { discoverSkills } from "./registry.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface DuplicateLineRef {
  skill: string;
  line: number;
}

export interface AuditDuplicateFinding {
  type: "owns-fact-collision" | "trigger-overlap" | "procedure-duplicate";
  skills: string[];
  detail: string;
  recommendation: "merge" | "split" | "parent-child" | "deprecate";
  lines?: DuplicateLineRef[];
}

export interface AuditDuplicatesResult {
  errors: string[];
  findings: AuditDuplicateFinding[];
}

// ── Safety (matches facts.ts) ───────────────────────────────────────────

const ID_SAFE_RE = /^[a-zA-Z0-9_-]+$/;
const HAS_CONTROL_CHAR = new RegExp(`[${String.fromCharCode(0, 31)}\\x7f]`);
const HAS_PATH_TRAVERSAL = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

function isUnsafeIdentifier(v: string): boolean {
  return HAS_CONTROL_CHAR.test(v) || HAS_PATH_TRAVERSAL.test(v) || !ID_SAFE_RE.test(v);
}

// ── Tokenization (case-insensitive, safe) ───────────────────────────────

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-zA-Z0-9_-]+/)
    .filter(Boolean);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── Section extraction from Markdown body ───────────────────────────────

interface Section {
  heading: string;
  body: string;
  startLine: number;
}

function extractSections(text: string): Section[] {
  const norm = text.replace(/\r\n/g, "\n");
  const lines = norm.split("\n");
  const sections: Section[] = [];
  let currentHeading = "";
  const currentBody: string[] = [];
  let currentStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const h = line.match(/^#{2,}\s+(.+)/);
    if (h) {
      if (currentHeading && currentBody.length > 0) {
        const body = currentBody.join("\n").trim();
        if (body) {
          sections.push({ heading: currentHeading, body, startLine: currentStart });
        }
      }
      currentHeading = h[1] as string;
      currentBody.length = 0;
      currentStart = i + 1;
    } else if (currentHeading) {
      currentBody.push(line);
    }
  }
  if (currentHeading && currentBody.length > 0) {
    const body = currentBody.join("\n").trim();
    if (body) {
      sections.push({ heading: currentHeading, body, startLine: currentStart });
    }
  }
  return sections;
}

function isGenericSection(heading: string, body: string): boolean {
  const genericHeadings = new Set([
    "when to use",
    "when not to use",
    "when NOT to use",
    "verification",
    "overview",
    "requirements",
    "prerequisites",
  ]);
  return genericHeadings.has(heading.toLowerCase().trim()) && body.replace(/\s+/g, "").length < 100;
}

function isSubstantive(body: string): boolean {
  return body.replace(/\s+/g, "").length > 20;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// ── Main audit entry point ──────────────────────────────────────────────

export function auditSkillDuplicates(
  repo: string,
  inject?: {
    readFileSync?: (path: string, encoding: string) => string;
    existsSync?: (path: string) => boolean;
  },
): AuditDuplicatesResult {
  const rf = inject?.readFileSync ?? readFileSync;
  const ef = inject?.existsSync ?? existsSync;
  const errors: string[] = [];
  const findings: AuditDuplicateFinding[] = [];

  const skills = discoverSkills(repo);
  if (skills.length < 2) return { errors: [], findings: [] };

  // Read all skill files
  const skillTexts: { name: string; text: string; dir: string }[] = [];
  for (const skill of skills) {
    if (!skill.dir) continue;
    try {
      const skillMd = join(skill.dir, "SKILL.md");
      if (ef(skillMd)) {
        skillTexts.push({ name: skill.name, text: rf(skillMd, "utf8"), dir: skill.dir });
      }
    } catch {
      // skip unreadable
    }
  }

  // 1. owns fact collision
  const ownedBy = new Map<string, string[]>();
  for (const { name, text } of skillTexts) {
    const { data } = parseFrontmatter(text);
    const owns = Array.isArray(data.owns)
      ? data.owns.filter((x: unknown) => typeof x === "string")
      : [];
    for (const factKey of owns) {
      if (isUnsafeIdentifier(factKey)) continue;
      const prev = ownedBy.get(factKey);
      if (prev && !prev.includes(name)) {
        const all = [...prev, name].sort();
        findings.push({
          type: "owns-fact-collision",
          skills: all,
          detail: `Fact key "${factKey}" claimed by multiple skills: "${all.join('", "')}"`,
          recommendation: "parent-child",
        });
      }
      ownedBy.set(factKey, [...(prev ?? []), name]);
    }
  }

  // 2. Trigger Jaccard overlap > 0.7
  const skillTriggers: { name: string; triggers: string[] }[] = [];
  for (const { name, text } of skillTexts) {
    const { data } = parseFrontmatter(text);
    const triggers = Array.isArray(data.triggers)
      ? data.triggers.filter((x: unknown) => typeof x === "string")
      : [];
    skillTriggers.push({ name, triggers });
  }

  for (let i = 0; i < skillTriggers.length; i++) {
    for (let j = i + 1; j < skillTriggers.length; j++) {
      const a = skillTriggers[i] as { name: string; triggers: string[] };
      const b = skillTriggers[j] as { name: string; triggers: string[] };
      if (a.triggers.length === 0 || b.triggers.length === 0) continue;
      const sim = jaccardSimilarity(tokenize(a.triggers.join(" ")), tokenize(b.triggers.join(" ")));
      if (sim > 0.7) {
        const sorted = [a.name, b.name].sort();
        findings.push({
          type: "trigger-overlap",
          skills: sorted,
          detail: `Trigger Jaccard similarity ${sim.toFixed(3)} between "${sorted[0]}" and "${sorted[1]}"`,
          recommendation: sim > 0.9 ? "merge" : "parent-child",
        });
      }
    }
  }

  // 3. Procedure section duplication
  const skillSections: {
    name: string;
    sections: Section[];
  }[] = [];
  for (const { name, text } of skillTexts) {
    skillSections.push({ name, sections: extractSections(text) });
  }

  for (let i = 0; i < skillSections.length; i++) {
    for (let j = i + 1; j < skillSections.length; j++) {
      const si = skillSections[i] as { name: string; sections: Section[] };
      const sj = skillSections[j] as { name: string; sections: Section[] };
      for (const sa of si.sections) {
        if (!isSubstantive(sa.body) || isGenericSection(sa.heading, sa.body)) continue;
        const saNorm = normalize(sa.body);
        for (const sb of sj.sections) {
          if (!isSubstantive(sb.body) || isGenericSection(sb.heading, sb.body)) continue;
          if (saNorm.length <= 20 || saNorm !== normalize(sb.body)) continue;
          const sorted = [si.name, sj.name].sort();
          findings.push({
            type: "procedure-duplicate",
            skills: sorted,
            detail: `Duplicate section "${sa.heading}" between "${sorted[0]}" and "${sorted[1]}"`,
            recommendation: "merge",
            lines: [
              { skill: si.name, line: sa.startLine },
              { skill: sj.name, line: sb.startLine },
            ],
          });
        }
      }
    }
  }

  findings.sort(
    (a, b) => a.type.localeCompare(b.type) || a.skills.join(",").localeCompare(b.skills.join(",")),
  );

  // Dedup repeat findings
  const seen = new Set<string>();
  const deduped: AuditDuplicateFinding[] = [];
  for (const f of findings) {
    const key = `${f.type}|${f.skills.join(",")}|${f.detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(f);
    }
  }

  return { errors, findings: deduped };
}

// ── CLI handler ─────────────────────────────────────────────────────────

function recommendationText(r: string): string {
  const map: Record<string, string> = {
    merge: "Merge into single skill",
    split: "Split into separate focused skills",
    "parent-child": "Set one skill as canonical/child relationship",
    deprecate: "Deprecate one skill in favor of the other",
  };
  return map[r] ?? r;
}

export function handleAuditDuplicatesSubcommand(
  repo: string,
  _rest: string[],
  audit: typeof auditSkillDuplicates = auditSkillDuplicates,
): number {
  let result: AuditDuplicatesResult;
  try {
    result = audit(repo);
  } catch (e) {
    out("vf", c.red(`✗ ${(e as Error).message}`));
    return 1;
  }

  if (result.findings.length === 0 && result.errors.length === 0) {
    out("vf", c.green("✔ No duplicate skill patterns detected."));
    return 0;
  }

  for (const e of result.errors) out("vf", c.red(`✗ ${e}`));

  const byType = new Map<string, AuditDuplicateFinding[]>();
  for (const f of result.findings) {
    const list = byType.get(f.type) ?? [];
    list.push(f);
    byType.set(f.type, list);
  }

  const typeOrder = ["owns-fact-collision", "trigger-overlap", "procedure-duplicate"];
  const typeLabels: Record<string, string> = {
    "owns-fact-collision": "Owns Fact Collisions",
    "trigger-overlap": "Trigger Overlap (Jaccard > 0.7)",
    "procedure-duplicate": "Duplicate Procedure Sections",
  };

  for (const type of typeOrder) {
    const list = byType.get(type);
    if (!list || list.length === 0) continue;
    out("vf", c.bold(typeLabels[type] ?? type));
    list.sort((a, b) => a.skills.join(",").localeCompare(b.skills.join(",")));
    for (const f of list) {
      out("vf", c.yellow(`  ! ${f.detail}`));
      if (f.lines) {
        for (const lr of f.lines) {
          out("vf", c.dim(`    \u2192 ${lr.skill}:${lr.line}`));
        }
      }
      out("vf", c.dim(`    Recommendation: ${recommendationText(f.recommendation)}`));
    }
  }

  return result.findings.length > 0 ? 1 : 0;
}
