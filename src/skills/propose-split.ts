// #669: propose non-destructive split of one skill into section-based pieces.
// Deterministic — no LLM. Sections extracted at H2 level.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { c } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import { out } from "../logbus.js";
import { discoverSkills } from "./registry.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface SplitProposalPiece {
  name: string;
  description: string;
  skillMd: string;
  sectionHeading: string;
}

export interface SplitProposal {
  sourceName: string;
  pieces: SplitProposalPiece[];
}

export interface ProposeSplitResult {
  errors: string[];
  proposal: SplitProposal | null;
  exitCode: number;
}

// ── Safety ──────────────────────────────────────────────────────────────

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// ── Extract H2 sections from body ───────────────────────────────────────

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
    const h = line.match(/^##\s+(.+)/);
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

const GENERIC_HEADINGS = new Set([
  "when to use",
  "when not to use",
  "when NOT to use",
  "verification",
  "overview",
  "requirements",
  "prerequisites",
  "why this exists",
  "evidence",
]);

function isGenericHeading(h: string): boolean {
  return GENERIC_HEADINGS.has(h.toLowerCase().trim());
}

// ── Core: propose split ─────────────────────────────────────────────────

export function proposeSplit(
  repo: string,
  skillName: string,
  inject?: {
    readFileSync?: (path: string, enc: string) => string;
  },
): ProposeSplitResult {
  const rf = inject?.readFileSync ?? readFileSync;
  const errors: string[] = [];

  // Validate name
  if (!skillName || !SKILL_NAME_RE.test(skillName)) {
    errors.push(`"${skillName}" is not a valid skill name (lowercase-hyphen)`);
    return { errors, proposal: null, exitCode: 2 };
  }
  const skills = discoverSkills(repo);
  const skill = skills.find((s) => s.name === skillName);

  if (!skill) {
    errors.push(`Unknown skill: "${skillName}"`);
    return { errors, proposal: null, exitCode: 2 };
  }

  const p = join(skill.dir, "SKILL.md");
  let text: string;
  try {
    text = rf(p, "utf8");
  } catch {
    errors.push(`Cannot read SKILL.md for "${skillName}"`);
    return { errors, proposal: null, exitCode: 1 };
  }

  const parsed = parseFrontmatter(text);
  const body = parsed.body;
  const sections = extractSections(body);

  // Filter to substantive non-generic sections
  const substantive = sections.filter(
    (s) => !isGenericHeading(s.heading) && s.body.replace(/\s+/g, "").length >= 10,
  );

  if (substantive.length < 2) {
    errors.push(
      `Skill "${skillName}" has ${substantive.length} substantive section(s); need ≥2 for a meaningful split proposal.`,
    );
    return { errors, proposal: null, exitCode: 1 };
  }

  const sourceDesc = typeof parsed.data.description === "string" ? parsed.data.description : "";
  const sourceTriggers = Array.isArray(parsed.data.triggers)
    ? (parsed.data.triggers as string[]).filter((t) => typeof t === "string")
    : [];

  const pieces: SplitProposalPiece[] = substantive.map((section, i) => {
    const slug = slugify(section.heading);
    const pieceName = `${skillName}-${slug}`.slice(0, 50);
    const pieceDesc = `${sourceDesc} — ${section.heading}`.slice(0, 200);

    const fmLines = ["---", `name: ${pieceName}`, `description: ${pieceDesc}`, "status: draft"];

    // Share common triggers + a section-specific trigger
    const sectionTriggers = [...sourceTriggers, slug];
    fmLines.push("triggers:");
    for (const t of sectionTriggers) fmLines.push(`  - ${t}`);

    fmLines.push("---", "");

    const skillMd = [
      ...fmLines,
      `# ${pieceName}`,
      "",
      `## ${section.heading}`,
      section.body,
      "",
      `> Proposed split from "${skillName}" — section "${section.heading}".`,
      "",
    ].join("\n");

    return { name: pieceName, description: pieceDesc, skillMd, sectionHeading: section.heading };
  });

  return {
    errors: [],
    proposal: { sourceName: skillName, pieces },
    exitCode: 0,
  };
}

// ── CLI handler ─────────────────────────────────────────────────────────

export function handleProposeSplitSubcommand(repo: string, rest: string[]): number {
  const name = rest[0]?.trim();

  if (!name) {
    out("vf", c.red("Usage: vf skills propose-split <skill-name>"), { level: "error" });
    return 2;
  }

  const result = proposeSplit(repo, name);

  for (const e of result.errors) {
    out("vf", c.red(`✗ ${e}`), { level: "error" });
  }

  if (!result.proposal) return result.exitCode;

  const p = result.proposal;

  out("vf", c.bold(`\nProposed split: "${p.sourceName}" → ${p.pieces.length} piece(s)\n`));

  for (const piece of p.pieces) {
    out("vf", c.bold(`Piece: "${piece.name}" (from "${piece.sectionHeading}")`));
    out("vf", c.dim("─── start ───"));
    process.stdout.write(`${piece.skillMd}\n`);
    out("vf", c.dim("─── end ───\n"));
  }

  out("vf", c.bold(`Eval plan for split of "${p.sourceName}":`));
  out("vf", "1. Verify each piece's SKILL.md contains the correct section body.");
  out("vf", "2. Verify piece names are unique and valid (lowercase-hyphen).");
  out("vf", "3. Verify the source skill's supersedes field points at pieces.");
  out("vf", "4. Verify trigger union matches the source skill triggers.");
  out("vf", "5. Run `vf skills validate` on each piece.");
  out("vf", "");

  out("vf", c.dim("(Proposal only — no files written. Review before applying.)"));

  return result.exitCode;
}
