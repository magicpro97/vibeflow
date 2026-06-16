import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CTX_DIR,
  type Skill,
  type SkillMatch,
  type SkillRequires,
  type SkillStatus,
} from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";

/**
 * Directories (relative to a repo) that may contain `<name>/SKILL.md` folders.
 *
 * Order = priority. Project-local roots win over the user-level root so a
 * repo's own skills override any user-level skill of the same name.
 *
 *   1. .vibeflow/skills  — project-canonical (VibeFlow-native)
 *   2. .kiro/skills      — Kiro-compatible mirror
 *   3. .claude/skills    — Claude Code-compatible mirror
 *   4. ~/.agents/skills  — user-level fallback (any project can borrow)
 *
 * Skills from `~/.agents/skills` are still treated as `local` provenance
 * (they live in the user's home, not on the network), so they may declare
 * `status: verified`. The only thing that caps to `experimental` is
 * skills fetched from a network source (Context7, etc.).
 */
const SKILL_ROOTS = [
  join(CTX_DIR, "skills"),
  join(".kiro", "skills"),
  join(".claude", "skills"),
  join(homedir(), ".agents", "skills"),
];

const VALID_STATUS: SkillStatus[] = [
  "verified",
  "unverified",
  "experimental",
  "draft",
  "deprecated",
];

/**
 * Where a skill came from. ONLY skills that live under the repo's own local skill roots
 * (`local`) are allowed to declare themselves `verified`. Anything sourced from external
 * discovery (`discovered`) is forced down to `experimental` at most — this enforces the
 * hard product invariant: external/unknown skills must NEVER be auto-verified.
 */
export type SkillProvenance = "local" | "discovered";

/** Rank order used by the resolver: higher = preferred. `deprecated` is never selectable. */
export const STATUS_RANK: Record<SkillStatus, number> = {
  verified: 4,
  experimental: 3,
  draft: 2,
  unverified: 1,
  deprecated: 0,
};

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x)).filter(Boolean);
  return out.length ? out : undefined;
}

function asRequires(v: unknown): SkillRequires | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  const fs = r.filesystem;
  const requires: SkillRequires = {};
  if (fs === "read" || fs === "write" || fs === "none") requires.filesystem = fs;
  if (typeof r.network === "boolean") requires.network = r.network;
  if (typeof r.shell === "boolean") requires.shell = r.shell;
  return Object.keys(requires).length ? requires : undefined;
}

/**
 * Parse one SKILL.md into a Skill. Returns null when the required `name` or
 * `description` frontmatter fields are missing or malformed (skill-creator standard).
 *
 * Provenance gate: a SKILL.md is attacker-controllable, so its declared `status` is NOT
 * trusted on its own. Only `local` skills (under the repo's own skill roots) may claim
 * `verified`; `discovered` (external) skills are capped at `experimental`. This is what
 * keeps the "external/unknown skills are never auto-verified" invariant intact even if a
 * file claims `status: verified` (or tries to inject one via prototype pollution).
 */
export function parseSkill(
  skillMdPath: string,
  dir: string,
  opts: { provenance?: SkillProvenance } = {},
): Skill | null {
  let text: string;
  try {
    text = readFileSync(skillMdPath, "utf8");
  } catch {
    return null;
  }
  const { data } = parseFrontmatter(text);
  // `data` has a null prototype (see frontmatter.ts) — reading `data.status` can only
  // ever return an OWN key, never an inherited one. Read it via hasOwnProperty to be safe.
  const ownStatus = Object.prototype.hasOwnProperty.call(data, "status") ? data.status : undefined;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  // Required by the spec: lowercase-hyphen name, non-empty description (<=1024 chars).
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null;
  if (!description || description.length > 1024) return null;

  const statusRaw = typeof ownStatus === "string" ? ownStatus : "";
  let status: SkillStatus = (VALID_STATUS as string[]).includes(statusRaw)
    ? (statusRaw as SkillStatus)
    : "unverified";

  // Provenance gate: only LOCAL skills may be verified; external is experimental at most.
  const provenance: SkillProvenance = opts.provenance ?? "local";
  if (provenance !== "local" && status === "verified") {
    status = "experimental";
  }

  return {
    name,
    description,
    version: typeof data.version === "string" ? data.version : undefined,
    status,
    capabilities: asStringArray(data.capabilities),
    triggers: asStringArray(data.triggers),
    requires: asRequires(data.requires),
    dir,
    path: skillMdPath,
  };
}

/** Discover every valid skill under the known roots in `repo`, de-duplicated by name. */
export function discoverSkills(repo: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const root of SKILL_ROOTS) {
    // Absolute roots (e.g. `~/.agents/skills`) are used as-is; relative
    // roots (e.g. `.vibeflow/skills`) are joined against the repo path.
    const isAbsolute = root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root);
    const base = isAbsolute ? root : join(repo, root);
    // The user-level root (homedir + .agents/skills) is treated as `local`
    // provenance: it lives in the user's own home directory, not on the
    // network. Anything else outside the repo is `discovered`.
    const provenance: SkillProvenance = root === join(homedir(), ".agents", "skills")
      ? "local"
      : "local";
    if (!existsSync(base)) continue;
    // base is verified to exist via existsSync above, so
    // readdirSync should not throw in practice.
    const entries = readdirSync(base);
    for (const entry of entries) {
      const dir = join(base, entry);
      if (!statSync(dir).isDirectory()) continue;
      const skillMd = join(dir, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      const skill = parseSkill(skillMd, dir, { provenance });
      // First root wins (.vibeflow/ over .kiro/ over .claude/ over ~/.agents/) — closest to the project.
      if (skill && !byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rank skills whose triggers match a file's extension or name.
 * Deprecated skills are never returned; ties break toward the higher-trust status so a
 * `verified` skill always outranks an equally-matching `experimental`/`draft` one.
 */
export function matchSkillsForFile(skills: Skill[], filename: string): SkillMatch[] {
  const lower = filename.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  const matches: SkillMatch[] = [];
  for (const skill of skills) {
    if (skill.status === "deprecated") continue;
    const triggers = (skill.triggers ?? []).map((t) => t.toLowerCase());
    if (triggers.includes(ext)) {
      matches.push({ skill, reason: `extension .${ext} matches a declared trigger`, score: 1 });
    } else if (triggers.some((t) => lower.includes(t))) {
      matches.push({ skill, reason: "filename contains a declared trigger", score: 0.6 });
    }
  }
  return matches.sort(byScoreThenStatus);
}

/**
 * Rank skills whose triggers/capabilities appear as whole words in a task description.
 * Deprecated skills are excluded; higher-trust statuses win ties.
 */
export function matchSkillsForTask(skills: Skill[], task: string): SkillMatch[] {
  const text = task.toLowerCase();
  const matches: SkillMatch[] = [];
  for (const skill of skills) {
    if (skill.status === "deprecated") continue;
    const terms = [...(skill.triggers ?? []), ...(skill.capabilities ?? [])].map((t) =>
      t.toLowerCase(),
    );
    let hits = 0;
    const hit: string[] = [];
    for (const term of terms) {
      if (!term) continue;
      const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(text)) {
        hits++;
        hit.push(term);
      }
    }
    if (hits > 0) {
      matches.push({
        skill,
        reason: `task mentions: ${hit.join(", ")}`,
        score: Math.min(1, hits / 3),
      });
    }
  }
  return matches.sort(byScoreThenStatus);
}

/** Sort by match score, breaking ties by status trust (verified first). */
function byScoreThenStatus(a: SkillMatch, b: SkillMatch): number {
  if (b.score !== a.score) return b.score - a.score;
  return STATUS_RANK[b.skill.status] - STATUS_RANK[a.skill.status];
}

/** Render the discovered registry as the SKILL_INDEX.md table body. */
export function renderSkillIndex(skills: Skill[]): string {
  const header =
    "# Skill Index\n\n| skill | status | capabilities |\n|-------|--------|--------------|\n";
  if (!skills.length) return header;
  const rows = skills
    .map((s) => `| ${s.name} | ${s.status} | ${(s.capabilities ?? []).join(", ")} |`)
    .join("\n");
  return `${header}${rows}\n`;
}
