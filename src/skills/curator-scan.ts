import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, c } from "../core.js";
import { out } from "../logbus.js";
import { checkAnchors } from "./anchor-freshness.js";
import { auditSkillDuplicates } from "./audit-duplicates.js";
import { discoverSkills } from "./discovery.js";
import { parseRegistryLock } from "./registry-channel.js";

export type FindingType = "stale-anchor" | "duplicate-owner" | "unpinned-registry";

export interface StaleAnchorFinding {
  id: string;
  type: "stale-anchor";
  skill: string;
  detail: string;
}

export interface DuplicateOwnerFinding {
  id: string;
  type: "duplicate-owner";
  skills: string[];
  detail: string;
}

export interface UnpinnedRegistryFinding {
  id: string;
  type: "unpinned-registry";
  registry: string;
  skill: string;
  detail: string;
}

export type Finding = StaleAnchorFinding | DuplicateOwnerFinding | UnpinnedRegistryFinding;

export interface CuratorScanResult {
  findings: Finding[];
  schemaVersion: 1;
}

function findingKey(f: Finding): string {
  switch (f.type) {
    case "stale-anchor":
      return f.skill;
    case "duplicate-owner":
      return f.skills.slice().sort().join("\u0000");
    case "unpinned-registry":
      return `${f.registry}\u0000${f.skill}`;
  }
}

function stableId(f: Finding): string {
  const h = createHash("sha256");
  h.update(`${f.type}\u0000${findingKey(f)}\u0000${f.detail}`);
  return h.digest("hex").slice(0, 16);
}

export function curatorScan(
  repo: string,
  inject?: {
    discoverSkills?: typeof discoverSkills;
    checkAnchors?: typeof checkAnchors;
    auditSkillDuplicates?: typeof auditSkillDuplicates;
    parseRegistryLock?: typeof parseRegistryLock;
  },
): CuratorScanResult {
  const ds = inject?.discoverSkills ?? discoverSkills;
  const ca = inject?.checkAnchors ?? checkAnchors;
  const ad = inject?.auditSkillDuplicates ?? auditSkillDuplicates;
  const prl = inject?.parseRegistryLock ?? parseRegistryLock;

  const findings: Finding[] = [];

  const skills = ds(repo);
  for (const skill of skills) {
    if (skill.sourceAnchors) {
      const result = ca(skill.sourceAnchors, repo);
      if (result.status === "stale") {
        findings.push({
          id: "",
          type: "stale-anchor",
          skill: skill.name,
          detail: result.reason ?? "stale",
        });
      }
    }
  }

  const dupResult = ad(repo);
  for (const f of dupResult.findings) {
    if (f.type === "owns-fact-collision") {
      findings.push({
        id: "",
        type: "duplicate-owner",
        skills: f.skills,
        detail: f.detail,
      });
    }
  }

  const lock = prl(repo);
  for (const reg of lock.registries) {
    if (!reg.installed) continue;
    for (const s of reg.installed) {
      if (!s.commitOID) {
        findings.push({
          id: "",
          type: "unpinned-registry",
          registry: reg.name,
          skill: s.name,
          detail: `Skill "${s.name}" in registry "${reg.name}" has no commitOID`,
        });
      }
    }
  }

  const withKey: (Finding & { _key: string })[] = findings.map((f) => {
    return { ...f, _key: `${f.type}\u0000${findingKey(f)}` };
  });
  withKey.sort((a, b) => a._key.localeCompare(b._key));

  const seen = new Set<string>();
  const deduped: Finding[] = [];
  for (const f of withKey) {
    const fid = stableId(f);
    if (!seen.has(fid)) {
      seen.add(fid);
      deduped.push({ ...f, id: fid });
    }
  }

  return { findings: deduped, schemaVersion: 1 };
}

export function writeCuratorFindings(repo: string, result: CuratorScanResult): void {
  const dir = join(repo, CTX_DIR, "curator");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "findings.json"), JSON.stringify(result, null, 2));
}

export function readCuratorFindings(repo: string): CuratorScanResult | null {
  const path = join(repo, CTX_DIR, "curator", "findings.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CuratorScanResult;
  } catch {
    return null;
  }
}

export function handleCuratorSubcommand(repo: string, rest: string[]): number {
  const sub = rest[0];
  if (sub === "scan") {
    const result = curatorScan(repo);
    writeCuratorFindings(repo, result);
    const counts: Record<string, number> = {};
    for (const f of result.findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
    const total = result.findings.length;
    if (total === 0) {
      out("vf", c.green("✔ No issues found."));
    } else {
      out("vf", c.bold(`${total} issue(s) found:`));
      for (const [type, count] of Object.entries(counts)) {
        if (count > 0) out("vf", `  ${type}: ${count}`);
      }
    }
    return total > 0 ? 1 : 0;
  }
  out("vf", c.dim("Usage: vf skills curator scan"));
  return 2;
}
