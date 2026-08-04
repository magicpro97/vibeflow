// #691: read-only Domain & Facts projection for the UI.
// Pure DTO builder over the two authoritative sources: readDomainFacts (facts.ts)
// and discoverSkills (registry.ts). No new graph schema, no filesystem paths, no
// raw file bytes are ever emitted to the browser — every field is a bounded,
// validated value derived from those two authorities.

import { readDomainFacts } from "./facts.js";
import { discoverSkills } from "./registry.js";

/** One curated projection from the raw (untrusted) fact row. */
export interface DomainFactView {
  key: string;
  owner: string;
  version: string;
  statement: string;
  paths: string[];
}

/** One domain root (canonical domain skill) plus its owned facts and children. */
export interface DomainRootView {
  id: string;
  canonical: string;
  facts: DomainFactView[];
  children: string[];
}

/** The read-only Domain & Facts view consumed by the UI. */
export interface DomainsView {
  ok: true;
  roots: DomainRootView[];
}

export interface ImpactView {
  ok: boolean;
  query: string;
  facts: string[];
  skills: string[];
  error?: string;
}

const MAX_PATHS = 16;
const MAX_STATEMENT = 400;

export function isUnsafePath(p: string): boolean {
  return (
    p.startsWith("/") ||
    p.startsWith("~") ||
    p.includes("..") ||
    p.includes("\\") ||
    p.includes("\0")
  );
}

export function isValidFactQuery(query: string): boolean {
  if (typeof query !== "string" || query.length === 0 || query.length > 500) return false;
  if (isUnsafePath(query)) return false;
  for (let i = 0; i < query.length; i++) {
    const c = query.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return /^[a-zA-Z0-9._/-]+$/.test(query);
}

export function sanitizeStatement(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.slice(0, MAX_STATEMENT);
}

function sanitizePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string") continue;
    if (isUnsafePath(p)) continue;
    const clean = p;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

interface ProjectedFact {
  key: string;
  owner: string;
  version: string;
  statement: string;
  paths: string[];
  dependents: string[];
}

/** Pure projection of the raw fact file into curated browser-safe rows. */
function projectFacts(file: ReturnType<typeof readDomainFacts>): ProjectedFact[] {
  if (!file) return [];
  const out: ProjectedFact[] = [];
  const keys = new Set<string>();
  for (const f of file.facts) {
    if (!f || typeof f !== "object") continue;
    const key = typeof f.key === "string" ? f.key : "";
    const owner = typeof f.owner === "string" ? f.owner : "";
    if (!key || !owner || keys.has(key)) continue;
    keys.add(key);
    const dependents = Array.isArray(f.dependents)
      ? f.dependents
          .filter((d): d is string => typeof d === "string" && /^[a-zA-Z0-9_-]+$/.test(d))
          .slice(0, 512)
      : [];
    out.push({
      key,
      owner,
      version: typeof f.version === "string" ? f.version : "",
      statement: sanitizeStatement(f.statement),
      paths: sanitizePaths(f.paths),
      dependents,
    });
  }
  return out;
}

/**
 * Build the read-only Domain & Facts view: one card per canonical domain root,
 * each showing its owned facts and dependent child skills. Missing/malformed
 * facts file yields an empty view (`ok:true`), matching the CLI's no-op semantics.
 */
export function buildDomainView(
  repo: string,
  inject?: {
    readDomainFacts?: typeof readDomainFacts;
    discoverSkills?: typeof discoverSkills;
  },
): DomainsView {
  const rf = inject?.readDomainFacts ?? readDomainFacts;
  const ds = inject?.discoverSkills ?? discoverSkills;
  let file: ReturnType<typeof readDomainFacts>;
  try {
    file = rf(repo);
  } catch {
    file = null;
  }
  const projected = projectFacts(file);
  const skills = ds(repo);

  const canonicalNameById = new Map<string, string>();
  for (const skill of skills) {
    if (skill.domain?.role !== "canonical" || !skill.domain.id) continue;
    if (!canonicalNameById.has(skill.domain.id)) canonicalNameById.set(skill.domain.id, skill.name);
  }

  const childrenByDomain = new Map<string, string[]>();
  const skillNames = new Set(skills.map((skill) => skill.name));
  function addChild(id: string, name: string) {
    if (!skillNames.has(name)) return;
    const list = childrenByDomain.get(id) ?? [];
    if (!list.includes(name)) list.push(name);
    childrenByDomain.set(id, list);
  }
  for (const skill of skills) {
    const id = [...canonicalNameById].find(
      ([domain, canonical]) =>
        skill.name !== canonical &&
        (skill.dependsOn?.includes(domain) || skill.dependsOn?.includes(canonical)),
    )?.[0];
    if (!id) continue;
    addChild(id, skill.name);
  }
  for (const fact of projected) {
    const id = [...canonicalNameById].find(([, canonical]) => canonical === fact.owner)?.[0];
    if (!id) continue;
    for (const dependent of fact.dependents) addChild(id, dependent);
  }

  const roots: DomainRootView[] = [];
  for (const [id, canonical] of canonicalNameById) {
    const canonSkill = skills.find((s) => s.name === canonical);
    const owned = new Set<string>();
    for (const pf of projected) {
      if (pf.owner === canonical) owned.add(pf.key);
    }
    for (const k of canonSkill?.owns ?? []) {
      if (projected.some((pf) => pf.key === k)) owned.add(k);
    }
    roots.push({
      id,
      canonical,
      facts: projected
        .filter((pf) => owned.has(pf.key))
        .map(({ key, owner, version, statement, paths }) => ({
          key,
          owner,
          version,
          statement,
          paths,
        })),
      children: [...(childrenByDomain.get(id) ?? [])].sort(),
    });
  }
  return { ok: true, roots };
}
