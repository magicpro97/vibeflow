// src/skills/anchor-freshness.ts
// #662: sourceAnchors freshness verification for skills.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Skill } from "../core.js";
import { c } from "../core.js";
import { SKILL_FRESHNESS, type SkillFreshness } from "../core/skill-contract.js";
import { out } from "../logbus.js";

export type AnchorStatus = SkillFreshness;

export interface AnchorResult {
  status: AnchorStatus;
  reason?: string;
}

export interface AnchorFreshnessDeps {
  existsSync: (p: string) => boolean;
  readFileRaw: (p: string) => Buffer;
  realpath: (p: string) => string;
}

const DEFAULT_DEPS: AnchorFreshnessDeps = {
  existsSync,
  readFileRaw: (p) => readFileSync(p),
  realpath: realpathSync,
};

/** Parse sourceAnchors from frontmatter data. Expects nested map
 *  {"path": "hash", ...}. Returns undefined when absent/unparseable. */
export function parseSourceAnchors(
  data: Record<string, unknown>,
): Record<string, string> | undefined {
  const raw = data.sourceAnchors;
  if (raw === undefined || raw === null) return undefined;

  const out: Record<string, string> = {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function validateSourceAnchors(data: Record<string, unknown>): string[] {
  const raw = data.sourceAnchors;
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return ["frontmatter.sourceAnchors must be a path-to-SHA-256 map"];
  for (const [path, hash] of Object.entries(raw)) {
    if (
      !path ||
      isAbsolute(path) ||
      path.replace(/\\/g, "/").split("/").includes("..") ||
      typeof hash !== "string" ||
      !/^[0-9a-f]{64}$/.test(hash)
    )
      return ["frontmatter.sourceAnchors contains an invalid path or SHA-256"];
  }
  return [];
}

/** Validate + resolve a repo-relative anchor path. */
export function resolveAnchorPath(
  relPath: string,
  repo: string,
  pathExists: (path: string) => boolean = existsSync,
  realpath: (path: string) => string = realpathSync,
): { ok: true; abs: string } | { ok: false; reason: string } {
  if (!relPath) return { ok: false, reason: "empty path" };
  if (isAbsolute(relPath)) return { ok: false, reason: "absolute path not allowed" };
  if (relPath.replace(/\\/g, "/").split("/").includes(".."))
    return { ok: false, reason: "path traversal not allowed" };
  const repoRoot = resolve(repo);
  const abs = resolve(repoRoot, relPath);
  const absRelative = relative(repoRoot, abs);
  if (absRelative.startsWith("..") || isAbsolute(absRelative))
    return { ok: false, reason: "path resolves outside repo" };
  if (!pathExists(abs) || !existsSync(repoRoot)) return { ok: true, abs };
  try {
    const realRepoRoot = realpath(repoRoot);
    const real = realpath(abs);
    const realRelative = relative(realRepoRoot, real);
    if (realRelative.startsWith("..") || isAbsolute(realRelative))
      return { ok: false, reason: "symlink escapes repo" };
  } catch {
    return { ok: false, reason: "unresolvable path" };
  }
  return { ok: true, abs };
}

/** SHA-256 hex hash of file content. Null on missing/unreadable. */
export function hashFile(absPath: string, deps?: Partial<AnchorFreshnessDeps>): string | null {
  const d = { ...DEFAULT_DEPS, ...deps };
  if (!d.existsSync(absPath)) return null;
  try {
    return createHash("sha256").update(d.readFileRaw(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/** Check all sourceAnchors against current disk state. */
export function checkAnchors(
  anchors: Record<string, string>,
  repo: string,
  deps?: Partial<AnchorFreshnessDeps>,
): AnchorResult {
  const d = { ...DEFAULT_DEPS, ...deps };
  for (const [relPath, declaredHash] of Object.entries(anchors)) {
    const resolved = resolveAnchorPath(relPath, repo, d.existsSync, d.realpath);
    if (!resolved.ok) return { status: SKILL_FRESHNESS.STALE, reason: resolved.reason };
    if (!d.existsSync(resolved.abs))
      return { status: SKILL_FRESHNESS.STALE, reason: `missing target: ${relPath}` };
    try {
      const content = d.readFileRaw(resolved.abs);
      const actual = createHash("sha256").update(content).digest("hex");
      if (actual !== declaredHash)
        return { status: SKILL_FRESHNESS.STALE, reason: `content changed: ${relPath}` };
    } catch {
      return { status: SKILL_FRESHNESS.STALE, reason: `unreadable target: ${relPath}` };
    }
  }
  return { status: SKILL_FRESHNESS.FRESH };
}

/** Set skill.freshness / freshnessReason from sourceAnchors. */
export function enrichFreshness(
  skill: Skill,
  repo: string,
  deps?: Partial<AnchorFreshnessDeps>,
): void {
  if (skill.sourceAnchors) {
    const result = checkAnchors(skill.sourceAnchors, repo, deps);
    skill.freshness = result.status;
    skill.freshnessReason = result.reason;
  } else if (skill.freshnessReason === undefined) {
    skill.freshness = SKILL_FRESHNESS.UNKNOWN;
  }
}

/** `vf skills verify-freshness` handler. Returns exit code. */
export function verifyFreshnessCommand(found: Skill[], repo: string): number {
  let staleCount = 0;
  for (const skill of found) {
    if (skill.freshness === undefined) enrichFreshness(skill, repo);
    const f = skill.freshness ?? SKILL_FRESHNESS.UNKNOWN;
    if (f === SKILL_FRESHNESS.FRESH) {
      out("vf", c.green(`✔ ${skill.name}: fresh`));
    } else if (f === SKILL_FRESHNESS.STALE) {
      staleCount++;
      out("vf", c.red(`✗ ${skill.name}: stale — ${skill.freshnessReason ?? "unknown reason"}`));
    } else {
      const reason = skill.freshnessReason ? ` — ${skill.freshnessReason}` : "";
      out("vf", c.dim(`? ${skill.name}: unknown${reason}`));
    }
  }
  if (staleCount > 0) {
    out("vf", c.red(`✗ ${staleCount} stale skill(s)`));
    return 1;
  }
  out("vf", c.green(`✔ all ${found.length} skill(s) fresh`));
  return 0;
}
