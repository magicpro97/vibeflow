import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, c } from "../core.js";
import { out } from "../logbus.js";
import { checkAnchors } from "./anchor-freshness.js";
import { auditSkillDuplicates } from "./audit-duplicates.js";
import { handleCuratorProposalSubcommand } from "./curator-proposals.js";
import {
  type GitRunner,
  curatorFingerprint,
  parseCuratorScanOptions,
  renderCuratorSyncPreview,
  resolveCleanCuratorCommit,
  syncCuratorMarkers,
} from "./curator-sync.js";
import { discoverSkills } from "./discovery.js";
import { parseRegistryLock } from "./registry-channel.js";

export {
  CURATOR_NOTES_REF,
  CURATOR_REMOTE,
  curatorFingerprint,
  isSafeCuratorIdentity,
  parseCuratorMarkers,
  parseCuratorScanOptions,
  renderCuratorMarkers,
  renderCuratorSyncPreview,
} from "./curator-sync.js";
export type { CuratorMarker, CuratorScanOptions, CuratorScope, GitRunner } from "./curator-sync.js";
export function parseCuratorScope(args: string[]): "local" | "repo" | null {
  return parseCuratorScanOptions(args)?.scope ?? null;
}

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

export function findingKey(f: Finding): string {
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
  withKey.sort((a, b) => (a._key < b._key ? -1 : a._key > b._key ? 1 : 0));

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
  return handleCuratorSubcommandWithDeps(repo, rest);
}

export function handleCuratorSubcommandWithDeps(
  repo: string,
  rest: string[],
  deps: {
    scan?: typeof curatorScan;
    writeFindings?: typeof writeCuratorFindings;
    resolveCommit?: (repo: string) => string | null;
    sync?: typeof syncCuratorMarkers;
    git?: GitRunner;
  } = {},
): number {
  const sub = rest[0];
  if (sub === "scan") {
    const opts = parseCuratorScanOptions(rest.slice(1));
    if (opts === null) {
      out(
        "vf",
        c.dim(
          "Usage: vf skills curator scan [--scope=local|repo] [--sync] [--yes]  (--sync previews; --yes syncs Git notes)",
        ),
      );
      return 2;
    }
    const git: GitRunner =
      deps.git ??
      ((args, cwd) => {
        const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      });
    const resolveCommit = deps.resolveCommit ?? ((cwd) => resolveCleanCuratorCommit(cwd, git));
    const commit = opts.scope === "repo" ? resolveCommit(repo) : null;
    if (opts.scope === "repo" && !commit) {
      out("vf", c.red("Repo scope requires a clean worktree and a valid HEAD commit."), {
        level: "error",
      });
      return 2;
    }
    const scan = deps.scan ?? curatorScan;
    const writeFindings = deps.writeFindings ?? writeCuratorFindings;
    const result = scan(repo);
    writeFindings(repo, result);
    if (opts.scope === "local") {
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
    if (!commit) return 1;
    if (!opts.sync) {
      out("vf", c.dim(`Scope: repo — anchored to ${commit.slice(0, 12)}; shared sync disabled.`));
      return result.findings.length > 0 ? 1 : 0;
    }
    if (!opts.yes) {
      for (const line of renderCuratorSyncPreview()) out("vf", c.dim(line));
      return result.findings.length > 0 ? 1 : 0;
    }
    const sync = deps.sync ?? syncCuratorMarkers;
    const shared = result.findings.map((finding) => ({
      type: finding.type,
      findingKey: findingKey(finding),
    }));
    const synced = sync(repo, commit, shared, git);
    if (!synced.synced) {
      out(
        "vf",
        c.red(
          "Shared curator sync failed; local findings were preserved and shared dedup is unverified.",
        ),
        {
          level: "error",
        },
      );
      return 2;
    }
    const duplicates = new Set(synced.duplicateFingerprints);
    const newFindings = result.findings.filter((finding) => {
      const fingerprint = curatorFingerprint(commit, finding.type, findingKey(finding));
      return fingerprint !== null && !duplicates.has(fingerprint);
    });
    out("vf", c.green(`✔ Shared curator sync complete; ${newFindings.length} new finding(s).`));
    return newFindings.length > 0 ? 1 : 0;
  }
  if (sub === "issue" || sub === "pr") {
    return handleCuratorProposalSubcommand(repo, sub, rest.slice(1));
  }
  out(
    "vf",
    c.dim(
      "Usage: vf skills curator scan [--scope=local|repo] [--sync] [--yes] | issue [--dry-run] | pr [--dry-run]",
    ),
  );
  return 2;
}
