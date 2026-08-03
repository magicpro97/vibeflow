import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR } from "../core.js";
import type { Finding, FindingType } from "./curator-scan.js";

export type { FindingType };

/** #689: derived severity per finding type — unpinned-registry is highest. */
export type Severity = "low" | "medium" | "high";

export function findingSeverity(f: Finding): Severity {
  switch (f.type) {
    case "unpinned-registry":
      return "high";
    case "duplicate-owner":
      return "medium";
    case "stale-anchor":
      return "low";
  }
}

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

/** #689: collapse whitespace + strip control chars, then cap at `limit` chars. */
function sanitize(s: string, limit: number): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c <= 31 || c === 127 ? " " : s[i];
  }
  return out.replace(/\s+/g, " ").trim().slice(0, limit);
}

const ID_CAP = 16;
const SUMMARY_CAP = 160;
const SKILLS_CAP = 32;

/** #689: validate a stale-anchor finding fully before casting. */
function safeStale(item: Record<string, unknown>): Finding | null {
  if (typeof item.skill !== "string" || sanitize(item.skill, SUMMARY_CAP).length === 0) return null;
  if (typeof item.detail !== "string") return null;
  return {
    id: sanitize(item.id as string, ID_CAP),
    type: "stale-anchor",
    skill: item.skill,
    detail: item.detail,
  };
}

/** #689: validate a duplicate-owner finding — all skills must be non-empty strings. */
function safeDuplicate(item: Record<string, unknown>): Finding | null {
  if (!Array.isArray(item.skills) || item.skills.length === 0 || item.skills.length > SKILLS_CAP)
    return null;
  const skills: string[] = [];
  for (const s of item.skills) {
    if (typeof s !== "string" || sanitize(s, SUMMARY_CAP).length === 0) return null;
    skills.push(s);
  }
  if (typeof item.detail !== "string") return null;
  return {
    id: sanitize(item.id as string, ID_CAP),
    type: "duplicate-owner",
    skills,
    detail: item.detail,
  };
}

/** #689: validate an unpinned-registry finding — safe registry + skill. */
function safeUnpinned(item: Record<string, unknown>): Finding | null {
  if (typeof item.registry !== "string" || sanitize(item.registry, SUMMARY_CAP).length === 0)
    return null;
  if (typeof item.skill !== "string" || sanitize(item.skill, SUMMARY_CAP).length === 0) return null;
  if (typeof item.detail !== "string") return null;
  return {
    id: sanitize(item.id as string, ID_CAP),
    type: "unpinned-registry",
    registry: item.registry,
    skill: item.skill,
    detail: item.detail,
  };
}

/** #689: validate a single raw finding by its discriminated type; null → drop. */
function safeFinding(item: unknown): Finding | null {
  if (!item || typeof item !== "object") return null;
  const f = item as Record<string, unknown>;
  if (typeof f.id !== "string" || !f.id) return null;
  if (typeof f.type !== "string") return null;
  switch (f.type) {
    case "stale-anchor":
      return safeStale(f);
    case "duplicate-owner":
      return safeDuplicate(f);
    case "unpinned-registry":
      return safeUnpinned(f);
    default:
      return null;
  }
}

/** #689: minimal safe view of one finding for the UI. */
export interface CuratorFindingView {
  id: string;
  type: FindingType;
  severity: Severity;
  summary: string;
}

/** #689: fixed counts object — all three keys always present, initialized 0. */
export interface CuratorCounts {
  "stale-anchor": number;
  "duplicate-owner": number;
  "unpinned-registry": number;
}

export interface CuratorView {
  findings: CuratorFindingView[];
  counts: CuratorCounts;
  total: number;
}

function emptyCounts(): CuratorCounts {
  return { "stale-anchor": 0, "duplicate-owner": 0, "unpinned-registry": 0 };
}

/** #689: sanitized summary for a finding (<=160 chars, whitespace-collapsed,
 *  control chars stripped from every component). */
export function summarizeFinding(f: Finding): string {
  const detail = sanitize(f.detail, SUMMARY_CAP);
  switch (f.type) {
    case "stale-anchor":
      return `${sanitize(f.skill, SUMMARY_CAP)}: ${detail}`.slice(0, SUMMARY_CAP);
    case "duplicate-owner":
      return `${f.skills.map((s) => sanitize(s, SUMMARY_CAP)).join(", ")}: ${detail}`.slice(
        0,
        SUMMARY_CAP,
      );
    case "unpinned-registry":
      return `${sanitize(f.registry, SUMMARY_CAP)}/${sanitize(f.skill, SUMMARY_CAP)}: ${detail}`.slice(
        0,
        SUMMARY_CAP,
      );
  }
}

/** #689: pure reduction of raw findings into a sanitized, display-safe view.
 *  Malformed entries are dropped (fail closed); ordering is severity-desc. */
export function toCuratorView(raw: unknown): CuratorView {
  const out: CuratorView = { findings: [], counts: emptyCounts(), total: 0 };
  if (!raw || typeof raw !== "object") return out;
  const arr = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(arr)) return out;
  const rows: CuratorFindingView[] = [];
  for (const item of arr) {
    const finding = safeFinding(item);
    if (!finding) continue;
    const severity = findingSeverity(finding);
    rows.push({ id: finding.id, type: finding.type, severity, summary: summarizeFinding(finding) });
  }
  rows.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  for (const r of rows) out.counts[r.type] += 1;
  out.findings = rows;
  out.total = rows.length;
  return out;
}

/** #689: read result — distinguishes missing (ok) from corrupt (typed error). */
export type CuratorReadResult = { ok: true; findings: unknown } | { ok: false; error: string };

/** #689: injected reader — default reads the on-disk findings file. */
export function readCuratorFindingsFile(repo: string): CuratorReadResult {
  const path = join(repo, CTX_DIR, "curator", "findings.json");
  if (!existsSync(path)) return { ok: true, findings: null };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, error: "unreadable curator findings file" };
  }
  try {
    return { ok: true, findings: JSON.parse(text) };
  } catch {
    return { ok: false, error: "corrupt curator findings file" };
  }
}

/** #689: guarded route helper — read findings for a repo, fail closed on
 *  malformed JSON (typed error). Missing file → empty view. */
export function curatorView(
  repo: string,
  read: (r: string) => CuratorReadResult = readCuratorFindingsFile,
): CuratorView | { ok: false; error: string } {
  const result = read(repo);
  if (!result.ok) return { ok: false, error: result.error };
  return toCuratorView(result.findings);
}
