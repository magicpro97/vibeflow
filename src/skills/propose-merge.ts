// #669: propose non-destructive merge of two skills — unified SKILL.md draft,
// replaces metadata, deprecation stubs, eval plan. No file writes. No LLM.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import { mergeBodies } from "./adapter.js";
import { discoverSkills } from "./registry.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface MergeProposal {
  mergedName: string;
  sources: [string, string];
  skillMd: string;
  replaces: Record<string, string>;
  deprecationStubs: Array<{ name: string; skillMd: string }>;
  evalPlan: string;
}

export interface ProposeMergeResult {
  errors: string[];
  proposal: MergeProposal | null;
  exitCode: number;
}

// ── Safety (same as audit-duplicates.ts) ────────────────────────────────

const ID_SAFE_RE = /^[a-zA-Z0-9_-]+$/;
const HAS_CONTROL_CHAR = new RegExp(`[${String.fromCharCode(0, 31)}\\x7f]`);
const HAS_PATH_TRAVERSAL = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

function isUnsafeIdentifier(v: string): boolean {
  return HAS_CONTROL_CHAR.test(v) || HAS_PATH_TRAVERSAL.test(v) || !ID_SAFE_RE.test(v);
}

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateSkillArg(name: string): string | null {
  if (!name || !SKILL_NAME_RE.test(name))
    return `"${name}" is not a valid skill name (lowercase-hyphen)`;
  if (isUnsafeIdentifier(name)) return `"${name}" contains unsafe characters`;
  return null;
}

// ── Core: propose merge of two skills ───────────────────────────────────

export function proposeMerge(
  repo: string,
  nameA: string,
  nameB: string,
  inject?: {
    readFileSync?: (path: string, enc: string) => string;
  },
): ProposeMergeResult {
  const rf = inject?.readFileSync ?? readFileSync;
  const errors: string[] = [];

  const errA = validateSkillArg(nameA);
  if (errA) {
    errors.push(errA);
    return { errors, proposal: null, exitCode: 2 };
  }
  const errB = validateSkillArg(nameB);
  if (errB) {
    errors.push(errB);
    return { errors, proposal: null, exitCode: 2 };
  }

  const skills = discoverSkills(repo);
  const skillA = skills.find((s) => s.name === nameA);
  const skillB = skills.find((s) => s.name === nameB);

  if (!skillA) {
    errors.push(`Unknown skill: "${nameA}"`);
    return { errors, proposal: null, exitCode: 2 };
  }
  if (!skillB) {
    errors.push(`Unknown skill: "${nameB}"`);
    return { errors, proposal: null, exitCode: 2 };
  }

  if (nameA === nameB) {
    errors.push(`Cannot merge a skill with itself: "${nameA}"`);
    return { errors, proposal: null, exitCode: 2 };
  }

  // Read both SKILL.md files
  const readSkillMd = (
    dir: string | undefined,
  ): { data: Record<string, unknown>; body: string } | null => {
    if (!dir) return null;
    const p = join(dir, "SKILL.md");
    try {
      const text = rf(p, "utf8");
      const parsed = parseFrontmatter(text);
      return { data: parsed.data, body: parsed.body };
    } catch {
      return null;
    }
  };

  const aMd = readSkillMd(skillA.dir);
  const bMd = readSkillMd(skillB.dir);
  if (!aMd || !bMd) {
    if (!aMd) errors.push(`Cannot read SKILL.md for "${nameA}"`);
    if (!bMd) errors.push(`Cannot read SKILL.md for "${nameB}"`);
    return { errors, proposal: null, exitCode: 1 };
  }

  // Sorted sources for deterministic output
  const first = nameA < nameB ? nameA : nameB;
  const second = nameA < nameB ? nameB : nameA;
  const firstMd = nameA < nameB ? aMd : bMd;
  const secondMd = nameA < nameB ? bMd : aMd;

  // Merged name: {first}-{second}
  const mergedName = `${first}-${second}`;

  // Union of triggers
  const triggersA = Array.isArray(firstMd.data.triggers)
    ? (firstMd.data.triggers as string[]).filter((t) => typeof t === "string")
    : [];
  const triggersB = Array.isArray(secondMd.data.triggers)
    ? (secondMd.data.triggers as string[]).filter((t) => typeof t === "string")
    : [];
  const mergedTriggers = [...new Set([...triggersA, ...triggersB])];

  // Union of capabilities
  const capsA = Array.isArray(firstMd.data.capabilities)
    ? (firstMd.data.capabilities as string[]).filter((t) => typeof t === "string")
    : [];
  const capsB = Array.isArray(secondMd.data.capabilities)
    ? (secondMd.data.capabilities as string[]).filter((t) => typeof t === "string")
    : [];
  const mergedCaps = [...new Set([...capsA, ...capsB])];

  // Combined description
  const descA = typeof firstMd.data.description === "string" ? firstMd.data.description : "";
  const descB = typeof secondMd.data.description === "string" ? secondMd.data.description : "";
  const mergedDesc = `${descA} ${descB}`.trim();

  // Merge body sections using adapter's mergeBodies (heading-matching merge)
  const mergedBody = mergeBodies(firstMd.body, secondMd.body);

  // Build unified SKILL.md
  const fmLines = ["---", `name: ${mergedName}`, `description: ${mergedDesc}`, "status: draft"];
  if (mergedCaps.length > 0) {
    fmLines.push("capabilities:");
    for (const c of mergedCaps) fmLines.push(`  - ${c}`);
  }
  if (mergedTriggers.length > 0) {
    fmLines.push("triggers:");
    for (const t of mergedTriggers) fmLines.push(`  - ${t}`);
  }
  fmLines.push("---", "");
  const skillMd = [...fmLines, mergedBody, ""].join("\n");

  // replaces metadata
  const replaces: Record<string, string> = {
    [first]: mergedName,
    [second]: mergedName,
  };

  // Deprecation stubs (printed in proposal, not written)
  const deprecationStubs = [first, second].map((name) => ({
    name,
    skillMd: [
      "---",
      `name: ${name}`,
      `description: This skill has been merged into ${mergedName}.`,
      "status: deprecated",
      `supersedes: ${mergedName}`,
      "---",
      "",
      `# ${name}`,
      "",
      `> Deprecated: merged into [${mergedName}](<proposal>).`,
      "",
    ].join("\n"),
  }));

  // Eval plan
  const evalPlan = [
    `# Eval plan for merged skill "${mergedName}"`,
    "",
    "1. **Trigger union** — verify every trigger from both source skills still matches the merged skill.",
    "2. **Negative precision** — verify no net increase in false-positive matches for unrelated tasks.",
    "3. **Procedure completeness** — verify each substantive section from both sources appears in the merged body.",
    `4. **Deprecation gate** — verify "${first}" and "${second}" resolve as deprecated (status check).`,
    "5. **Skill index** — verify the merged skill appears and both source skills are excluded from active matches.",
    "",
  ].join("\n");

  return {
    errors: [],
    proposal: {
      mergedName,
      sources: [first, second],
      skillMd,
      replaces,
      deprecationStubs,
      evalPlan,
    },
    exitCode: 0,
  };
}

// ── CLI handler ─────────────────────────────────────────────────────────

export function handleProposeMergeSubcommand(repo: string, rest: string[]): number {
  const nameA = rest[0]?.trim();
  const nameB = rest[1]?.trim();

  if (!nameA || !nameB) {
    out("vf", c.red("Usage: vf skills propose-merge <skill-a> <skill-b>"), { level: "error" });
    return 2;
  }

  const result = proposeMerge(repo, nameA, nameB);

  for (const e of result.errors) {
    out("vf", c.red(`✗ ${e}`), { level: "error" });
  }

  if (!result.proposal) return result.exitCode;

  const p = result.proposal;

  out(
    "vf",
    c.bold(`\nProposed merge: "${p.sources[0]}" + "${p.sources[1]}" → "${p.mergedName}"\n`),
  );

  out("vf", c.bold("Unified SKILL.md:"));
  out("vf", c.dim("─── start ───"));
  process.stdout.write(`${p.skillMd}\n`);
  out("vf", c.dim("─── end ───\n"));

  out("vf", c.bold("replaces metadata:"));
  for (const [src, target] of Object.entries(p.replaces)) {
    out("vf", `  ${src} → ${target}`);
  }

  out("vf", c.bold("Deprecation stubs (not written):"));
  for (const stub of p.deprecationStubs) {
    out("vf", c.dim(`--- ${stub.name} ---`));
    process.stdout.write(`${stub.skillMd}\n`);
  }

  out("vf", c.bold("Eval plan:"));
  process.stdout.write(`${p.evalPlan}\n`);

  out("vf", c.dim("(Proposal only — no files written. Review before applying.)"));

  return result.exitCode;
}
