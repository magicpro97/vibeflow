import { join } from "node:path";
import type { Skill } from "../core.js";
import { CTX_DIR } from "../core.js";
import type { ProjectProfile } from "../scanner.js";
import { discoverSkills, matchSkillsForFile } from "./registry.js";

/** The canonical, writable local skills root — the only one `vf skills verify` can promote. */
const CANONICAL_SKILLS_ROOT = join(CTX_DIR, "skills");

/**
 * Canonical map from a file extension to the *reader skill capability* an agent would
 * need to ingest it. This names a NEED, not a shipped artifact — VibeFlow does not bundle
 * reader skills. The resolver checks whether the need is already satisfied by a local
 * verified skill and, if not, recommends acquiring one on demand (Context7), behind
 * approval. This is the minimal-footprint principle: nothing is pre-installed.
 */
const READER_SKILL_BY_EXT: Record<string, string> = {
  md: "markdown-reader",
  markdown: "markdown-reader",
  txt: "text-reader",
  doc: "docx-reader",
  docx: "docx-reader",
  xls: "xlsx-reader",
  xlsx: "xlsx-reader",
  csv: "csv-reader",
  tsv: "csv-reader",
  ppt: "pptx-reader",
  pptx: "pptx-reader",
  pdf: "pdf-reader",
  json: "json-reader",
  yaml: "yaml-reader",
  yml: "yaml-reader",
  png: "image-ocr",
  jpg: "image-ocr",
  jpeg: "image-ocr",
  gif: "image-ocr",
  webp: "image-ocr",
};

/** Name the reader-skill capability a file would require (a need, not an installed skill). */
export function skillForFile(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return READER_SKILL_BY_EXT[ext] ?? "generic-file-reader";
}

export interface SkillNeed {
  /** The needed reader-skill capability (e.g. "xlsx-reader") or docs need. */
  need: string;
  /** Human-readable justification (which file/type/framework drove the need). */
  reason: string;
  status: "satisfied" | "available-unverified" | "missing";
  /** The local skill that satisfies the need, if any. */
  satisfiedBy?: string;
  /**
   * An unverified local skill that matches the need but is not yet promoted.
   * Carries its name so the renderer can suggest `vf skills verify <name>`
   * instead of a Context7 acquire. Set only when status is
   * "available-unverified".
   */
  promote?: string;
  /** Suggested on-demand acquisition command when missing. */
  acquire?: string;
}

export interface ResolveInput {
  repo: string;
  /** Attached sample file names (drive reader needs). */
  attachments?: string[];
  /** Declared file types in scope (extensions). */
  fileTypes?: string[];
  /** The task/goal text (drives capability needs). */
  task?: string;
  /** Evidence-based scan of the repo (drives framework-docs needs). */
  profile?: ProjectProfile;
}

/**
 * Find a local skill that matches a reader need, preferring a VERIFIED match.
 * Returns `{ skill, verified }`:
 *  - a verified match (by name, else by file capability) → verified:true. Only
 *    a verified skill may be counted as SATISFYING the need (the security
 *    invariant — an unverified skill is unproven and must be promoted first).
 *  - else an UNVERIFIED match (same lookup over the non-verified, non-deprecated
 *    set) → verified:false. Surfaced as "available, run `vf skills verify`"
 *    rather than hidden, so a full store doesn't masquerade as empty.
 *  - else undefined (truly missing → acquire on demand).
 * `deprecated` skills are excluded from both passes by the matcher / the filter.
 */
function satisfier(
  local: Skill[],
  reader: string,
  filename: string,
): { skill: Skill; verified: boolean } | undefined {
  const find = (pool: Skill[]): Skill | undefined =>
    pool.find((s) => s.name === reader) ?? matchSkillsForFile(pool, filename)[0]?.skill;

  const verifiedHit = find(local.filter((s) => s.status === "verified"));
  if (verifiedHit) return { skill: verifiedHit, verified: true };

  // An unverified match is only actionable if it lives in the canonical store,
  // because the promote hint (`vf skills verify`) only operates on
  // CTX_DIR/skills/<name>. A match from a mirror root (.kiro/, engine mirrors)
  // can't be promoted there, so we do NOT surface it as available — it falls
  // through to "missing" (acquire on demand) instead of dangling an
  // un-followable hint (#435 review).
  const unverifiedHit = find(
    local.filter(
      (s) =>
        s.status !== "verified" &&
        s.status !== "deprecated" &&
        s.dir
          .split(/[\\/]/)
          .join("/")
          .includes(`${CANONICAL_SKILLS_ROOT.split(/[\\/]/).join("/")}/`),
    ),
  );
  if (unverifiedHit) return { skill: unverifiedHit, verified: false };

  return undefined;
}

/**
 * Turn an evidence-based scan + intake into a list of skill NEEDS, marking each as already
 * satisfied by a local skill or missing (with a recommended on-demand acquisition step).
 * Demand-driven: nothing is acquired here — this only reports what the task requires.
 */
export function resolveSkillNeeds(input: ResolveInput): SkillNeed[] {
  const local = discoverSkills(input.repo);
  const needs = new Map<string, SkillNeed>();

  const addReaderNeed = (filename: string, ext: string, why: string) => {
    const reader = skillForFile(filename);
    if (needs.has(reader)) return;
    const hit = satisfier(local, reader, filename);
    if (hit?.verified) {
      needs.set(reader, {
        need: reader,
        reason: why,
        status: "satisfied",
        satisfiedBy: hit.skill.name,
      });
    } else if (hit) {
      // Unverified local match: surface it with a promote hint instead of an
      // acquire line, so the user promotes the existing skill rather than
      // re-fetching from Context7.
      needs.set(reader, {
        need: reader,
        reason: why,
        status: "available-unverified",
        promote: hit.skill.name,
      });
    } else {
      needs.set(reader, {
        need: reader,
        reason: why,
        status: "missing",
        acquire: `vf discover skills ${ext} --yes`,
      });
    }
  };

  for (const name of input.attachments ?? []) {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    addReaderNeed(name, ext, `attachment ${name}`);
  }
  for (const ext of input.fileTypes ?? []) {
    const clean = ext.trim().toLowerCase().replace(/^\./, "");
    if (clean) addReaderNeed(`x.${clean}`, clean, `declared file type .${clean}`);
  }

  // Detected frameworks → version-specific docs are best fetched fresh on demand.
  for (const fw of input.profile?.frameworks ?? []) {
    const key = `docs:${fw.toLowerCase()}`;
    if (needs.has(key)) continue;
    needs.set(key, {
      need: `${fw} docs`,
      reason: `detected framework ${fw} — prefer current docs over stale model knowledge`,
      status: "missing",
      acquire: `vf discover docs ${fw} --yes`,
    });
  }

  return [...needs.values()].sort((a, b) => {
    // Most-actionable first: missing, then available-unverified, then satisfied.
    const rank = (s: SkillNeed["status"]): number =>
      s === "missing" ? 0 : s === "available-unverified" ? 1 : 2;
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return a.need.localeCompare(b.need);
  });
}

/** Render skill needs as CLI lines. */
export function renderSkillNeeds(needs: SkillNeed[]): string {
  if (!needs.length) return "No skill needs derived from the current context.\n";
  return `${needs
    .map((n) => {
      if (n.status === "satisfied") {
        return `✓ ${n.need}  (${n.reason}) — satisfied by ${n.satisfiedBy}`;
      }
      if (n.status === "available-unverified") {
        return `• ${n.need}  (${n.reason}) — available locally — run \`vf skills verify ${n.promote}\``;
      }
      return `• ${n.need}  (${n.reason}) — missing — ${n.acquire}`;
    })
    .join("\n")}\n`;
}
