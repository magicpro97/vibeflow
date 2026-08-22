// biome-ignore format: entire-file — tight formatting keeps file ≤400 lines
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { SkillScope } from "../core.js";
import type { Skill, SkillMatch, SkillRequires, SkillStatus } from "../core.js";
import { parseFrontmatter } from "../frontmatter.js";
import type { UserMcpServer } from "../tools/index.js";
import { parseSourceAnchors } from "./anchor-freshness.js";
import { parseDomainMeta } from "./domain.js";
import {
  parseLifecycleChangelog,
  parseLifecycleOwners,
  parseLifecycleSupersedes,
} from "./lifecycle.js";
// biome-ignore format: compact single-line keeps file ≤400
import { type ParseSkillOpts, hasValidReviewProof } from "./review-proof.js";

/**
 * Directories that may contain `<name>/SKILL.md` folders.
 *
 * Resolution order (first root wins on name collision):
 *  1. CTX_DIR/skills        — project-local override (repo can vendor/shadow)
 *  2. .kiro/skills          — Kiro engine (third-party, not in our mirror list)
 *  3. SKILL_MIRRORS         — per-engine roots (workflow-artifacts.ts)
 *
 * `discoverSkills` also scans the SHARED catalog (~/.vibeflow/skills/) AFTER
 * project-local roots, so a project-local skill always shadows the shared one.
 *
 * Extracted to `./discovery.js` to keep this file ≤400 lines. */
export { discoverSkills } from "./discovery.js";

const VALID_STATUS: SkillStatus[] = [
  "verified",
  "enriched",
  "experimental",
  "baseline",
  "template",
  "draft",
  "deprecated",
  "unverified",
];

export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
// biome-ignore format: compact descriptor stats keep this capped module within 400 lines
type SkillFileStats = ReturnType<typeof fstatSync> & {
  dev: bigint; ino: bigint; nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint;
};

function skillFileStats(fd: number): SkillFileStats {
  return fstatSync(fd, { bigint: true }) as SkillFileStats;
}

function sameSkillFile(left: SkillFileStats, right: SkillFileStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Descriptor-backed, bounded snapshot used by discovery and authority materialization. */
export function readSkillFileSnapshot(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const before = skillFileStats(fd);
    const entry = lstatSync(path, { bigint: true }) as SkillFileStats;
    // biome-ignore format: compact fail-closed descriptor identity check
    if (
      !before.isFile() || entry.isSymbolicLink() || !entry.isFile() ||
      before.nlink !== 1n || entry.nlink !== 1n || !sameSkillFile(before, entry)
    ) throw new Error("unsafe skill file");
    if (before.size > BigInt(MAX_SKILL_FILE_BYTES)) throw new Error("skill file exceeds 1 MiB");
    const bytes = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_SKILL_FILE_BYTES) throw new Error("skill file exceeds 1 MiB");
    const after = skillFileStats(fd);
    const finalEntry = lstatSync(path, { bigint: true }) as SkillFileStats;
    // biome-ignore format: compact fail-closed descriptor stability check
    if (
      !sameSkillFile(before, after) || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      !sameSkillFile(after, finalEntry) || finalEntry.isSymbolicLink()
    ) throw new Error("skill file changed during read");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Where a skill came from. ONLY skills that live under the repo's own local skill roots
 * (`local`) are allowed to declare themselves `verified`. Anything sourced from external
 * discovery (`discovered`) is forced down to `experimental` at most — this enforces the
 * hard product invariant: external/unknown skills must NEVER be auto-verified.
 */
export type SkillProvenance = "local" | "discovered";

/** Rank order used by the resolver: higher = preferred. `deprecated` is never selectable. */
export const STATUS_RANK: Record<SkillStatus, number> = {
  verified: 7,
  enriched: 6,
  experimental: 5,
  baseline: 4,
  template: 3,
  draft: 2,
  unverified: 1,
  deprecated: 0,
};

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x)).filter(Boolean);
  return out.length ? out : undefined;
}

/** #552: parse one mcp block from frontmatter into a Skill.mcp entry (inline shape, not UserMcpServer,
 *  to avoid a type-only import problem; see Skill interface). Returns undefined if malformed. */
export function asMcp(v: unknown, skillName: string): Skill["mcp"] | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Record<string, unknown>;
  // Transport defaults to stdio; unknown values fall back to stdio.
  const t = r.transport;
  const transport: "stdio" | "http" | "sse" = t === "http" || t === "sse" ? t : "stdio";
  // Name: use mcp.name if valid kebab-case, else fall back to skillName.
  const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const rawName = typeof r.name === "string" ? r.name : undefined;
  const name = rawName && NAME_RE.test(rawName) ? rawName : undefined;
  // Validate skillName as fallback identity.
  const resolvedName = name ?? skillName;
  if (!NAME_RE.test(resolvedName)) return undefined;
  if (transport === "stdio") {
    if (typeof r.command !== "string" || !r.command) return undefined;
    const args = Array.isArray(r.args) ? r.args.map(String).filter(Boolean) : [];
    return { name: resolvedName, transport, command: r.command, args };
  }
  // http / sse
  if (typeof r.url !== "string" || !r.url) return undefined;
  const rawHeaders = r.headers;
  const headers: Record<string, string> = {};
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [k, hv] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof hv === "string") headers[k] = hv;
    }
  }
  return {
    name: resolvedName,
    transport,
    url: r.url,
    ...(Object.keys(headers).length ? { headers } : {}),
  };
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

const VALID_SCOPES = new Set(["common", "organization", "project", "adapter"]);

function parseScope(data: Record<string, unknown>): SkillScope | undefined {
  const raw = data.scope;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().toLowerCase() as SkillScope;
  return VALID_SCOPES.has(s) ? s : undefined;
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
export function parseSkillText(
  text: string,
  skillMdPath: string,
  dir: string,
  opts: ParseSkillOpts = {},
): Skill | null {
  const { data } = parseFrontmatter(text);
  // `data` has a null prototype (see frontmatter.ts) — reading `data.status` can only
  // ever return an OWN key, never an inherited one. Read it via hasOwnProperty to be safe.
  const ownStatus = Object.prototype.hasOwnProperty.call(data, "status") ? data.status : undefined;
  // Issue #93: normalize the declared name to lowercase BEFORE regex
  // validation. Earlier this code only `.trim()`-ed, then the regex
  // `^[a-z0-9]+(?:-[a-z0-9]+)*$` rejected any uppercase letter — so a
  // mixed-case `name: Shared-Tool` was silently dropped. Lowercasing
  // first makes the skill survive under its canonical `shared-tool`
  // form, which is also what `discoverSkills` now uses as its dedup key.
  const name = typeof data.name === "string" ? data.name.trim().toLowerCase() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";
  // Required by the spec: lowercase-hyphen name, non-empty description (<=1024 chars).
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null;
  if (!description || description.length > 1024) return null;

  const statusRaw = typeof ownStatus === "string" ? ownStatus : "";
  let status: SkillStatus = (VALID_STATUS as string[]).includes(statusRaw)
    ? (statusRaw as SkillStatus)
    : "unverified";

  // External claims are untrusted. Only a caller-supplied identity plus matching
  // local proof can preserve verified; frontmatter never supplies proof identity.
  const provenance: SkillProvenance = opts.provenance ?? "local";
  if (provenance !== "local" && status === "verified") {
    status = hasValidReviewProof(name, opts) ? "verified" : "experimental";
  }

  const { domain, owns, dependsOn } = parseDomainMeta(data as Record<string, unknown>);
  const owners = parseLifecycleOwners(data as Record<string, unknown>);
  const changelog = parseLifecycleChangelog(data as Record<string, unknown>);
  const supersedes = parseLifecycleSupersedes(data as Record<string, unknown>);

  return {
    name,
    description,
    version: typeof data.version === "string" ? data.version : undefined,
    status,
    scope: parseScope(data),
    projectId: typeof data["project.id"] === "string" ? data["project.id"].trim() : undefined,
    extends: asStringArray(data.extends),
    capabilities: asStringArray(data.capabilities),
    triggers: asStringArray(data.triggers),
    type: data.type === "repo" ? "repo" : data.type === "knowledge" ? "knowledge" : undefined,
    requires: asRequires(data.requires),
    mcp: asMcp(data.mcp, name),
    domain,
    owns,
    dependsOn,
    owners,
    changelog,
    supersedes,
    sourceAnchors: parseSourceAnchors(data as Record<string, unknown>),
    dir,
    path: skillMdPath,
  };
}

export function parseSkill(
  skillMdPath: string,
  dir: string,
  opts: ParseSkillOpts = {},
): Skill | null {
  try {
    return parseSkillText(readSkillFileSnapshot(skillMdPath), skillMdPath, dir, opts);
  } catch {
    return null;
  }
}
/** #552: collect every non-deprecated skill's mcp block into a {name → UserMcpServer} map,
 *  ready to merge into the engine MCP fan-out (same shape as settings.mcpServers).
 *  Server name = mcp.name (already resolved in asMcp). Later skills win on name clash. */
export function skillMcpServers(skills: Skill[]): Record<string, UserMcpServer> {
  const out: Record<string, UserMcpServer> = {};
  for (const skill of skills) {
    if (skill.status === "deprecated" || !skill.mcp) continue;
    const { name: serverName, transport, command, args, url, headers } = skill.mcp;
    if (!serverName) continue;
    if (transport === "stdio" && command) {
      const entry: UserMcpServer = {
        transport: "stdio",
        command,
        ...(args?.length ? { args } : {}),
      };
      out[serverName] = entry;
    } else if ((transport === "http" || transport === "sse") && url) {
      const entry: UserMcpServer = {
        transport,
        url,
        ...(headers && Object.keys(headers).length ? { headers } : {}),
      };
      out[serverName] = entry;
    }
  }
  return out;
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

/** #543: repo ("project law") skills — always-on, injected every dispatch regardless of
 *  keyword match. Deprecated excluded; higher-trust status first. */
export function repoSkills(skills: Skill[]): Skill[] {
  return skills
    .filter((s) => s.type === "repo" && s.status !== "deprecated")
    .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
}

/** #543: resolve the skills injected for one dispatch unit: always-on repo skills unioned
 *  with keyword matches (repo first, deduped). `matchedNames` is the keyword-only subset
 *  (used for the knowledge-gap flag); `skillsRequired` is the verified subset of the union. */
export interface DispatchSkillSelection {
  skillNames: string[];
  alwaysNames: string[];
  matchedNames: string[];
  skillsRequired: string[];
}

export function selectDispatchSkills(allSkills: Skill[], unitText: string): DispatchSkillSelection {
  const skillMatches = matchSkillsForTask(allSkills, unitText);
  const alwaysOn = repoSkills(allSkills);
  const alwaysNames = alwaysOn.map((s) => s.name);
  // #543: a repo skill that ALSO declares triggers can appear in skillMatches, but it is
  // always-on project law — NOT a knowledge match. Exclude repo-typed matches from
  // matchedNames so the knowledge-gap flag (matchedNames.length === 0) is not falsely
  // suppressed by an always-on skill. (Copilot review #591.)
  const matchedNames = skillMatches.filter((m) => m.skill.type !== "repo").map((m) => m.skill.name);
  const skillNames = [...new Set([...alwaysNames, ...matchedNames])];
  const skillsRequired = [
    ...new Set([
      ...alwaysOn.filter((s) => s.status === "verified").map((s) => s.name),
      ...skillMatches.filter((m) => m.skill.status === "verified").map((m) => m.skill.name),
    ]),
  ];
  return { skillNames, alwaysNames, matchedNames, skillsRequired };
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
    "# Skill Index\n\n| skill | status | capabilities | freshness |\n|-------|--------|--------------|-----------|\n";
  if (!skills.length) return header;
  const rows = skills
    .map((s) => {
      const f = s.freshness ?? "";
      const r = s.freshnessReason ? ` (${s.freshnessReason})` : "";
      return `| ${s.name} | ${s.status} | ${(s.capabilities ?? []).join(", ")} | ${f}${r} |`;
    })
    .join("\n");
  return `${header}${rows}\n`;
}
