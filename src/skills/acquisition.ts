// src/skills/acquisition.ts
// #682 — pinned-registry skill acquisition proposals and approval gate.
// Read-only candidate construction, gather-all-decisions, delegate to
// registryInstall for approved mutations. No network, no writes, no
// fuzzy/LLM matching.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { parseMarketplace, parseRegistryLock, registryCacheDir } from "./registry-channel.js";
import type { RegistryEntry } from "./registry-types.js";
import type { SkillNeed } from "./resolver.js";
import { type SecurityScanResult, scanSkillDir } from "./security-scan.js";
import type { SkillAcquisitionDecision } from "./telemetry.js";

export type AcquisitionScanStatus =
  | { state: "not-scanned"; reason: string }
  | { state: "passed"; highestSeverity: "none" | "low" | "medium" }
  | { state: "blocked"; highestSeverity: "high" | "critical"; findings: number };

export interface SkillAcquisitionProposal {
  id: string;
  need: string;
  reason: string;
  name: string;
  version: string;
  source: {
    registryId: string;
    commitOID: string;
    skillPath: string;
  };
  scan: AcquisitionScanStatus;
  approvable: boolean;
}

export type AcquisitionDecision = "approve" | "reject";
export type AcquisitionApprover = (
  proposals: readonly SkillAcquisitionProposal[],
) => Promise<ReadonlyMap<string, AcquisitionDecision>>;

export type AcquisitionGateResult =
  | { ok: true; installed: string[]; unresolved: string[]; proposals: SkillAcquisitionProposal[] }
  | {
      ok: false;
      reason: string;
      installed: string[];
      unresolved: string[];
      proposals: SkillAcquisitionProposal[];
    };

export interface AcquisitionReadDeps {
  homedir?: () => string;
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  scanner?: (dir: string) => SecurityScanResult;
}

export type CandidateResolution =
  | { state: "proposal"; proposal: SkillAcquisitionProposal }
  | { state: "unresolved"; need: string; reason: string; acquire?: string }
  | {
      state: "ambiguous";
      need: string;
      reason: string;
      matches: Array<{ registryId: string; commitOID: string }>;
    };

export interface ProposalBuildResult {
  proposals: SkillAcquisitionProposal[];
  unresolved: string[];
  ambiguous: string[];
  resolutions: CandidateResolution[];
}

function proposalId(
  registryId: string,
  commitOID: string,
  name: string,
  version: string,
  skillPath: string,
): string {
  const raw = `${registryId}\0${commitOID}\0${name}\0${version}\0${skillPath}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function mapScanStatus(scan: SecurityScanResult): AcquisitionScanStatus {
  if (!scan.scanned) {
    return { state: "not-scanned", reason: scan.reason ?? "scanner not available" };
  }
  const sev = scan.risk_severity ?? "NONE";
  const sevUpper = sev.toUpperCase();
  if (sevUpper === "HIGH" || sevUpper === "CRITICAL") {
    return {
      state: "blocked",
      highestSeverity: sevUpper.toLowerCase() as "high" | "critical",
      findings: scan.findings.length,
    };
  }
  return {
    state: "passed",
    highestSeverity: (sevUpper === "NONE" ? "none" : sevUpper.toLowerCase()) as
      | "none"
      | "low"
      | "medium",
  };
}

function registrySkillDir(cacheDir: string, path: string): string | null {
  if (!path || path.includes("\0") || path.includes("\\")) return null;
  const resolved = join(cacheDir, path);
  const rel = relative(cacheDir, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

export function findAcquisitionCandidates(
  repo: string,
  needs: readonly SkillNeed[],
  deps?: AcquisitionReadDeps,
): CandidateResolution[] {
  const _homedir = deps?.homedir;
  const _exists = deps?.existsSync ?? existsSync;
  const _read = deps?.readFileSync ?? readFileSync;
  const _scanner = deps?.scanner;

  const missing = needs.filter((n) => n.status === "missing");
  if (missing.length === 0) return [];

  const lock = parseRegistryLock(repo);
  const resolutions: CandidateResolution[] = [];

  for (const need of missing) {
    const candidates: Array<{
      entry: RegistryEntry;
      cacheDir: string;
      mpSkills: Array<{ name: string; version: string; status?: string; path?: string }>;
    }> = [];

    for (const entry of lock.registries) {
      const cacheDir = registryCacheDir(entry.url, { homedir: _homedir });
      if (!_exists(cacheDir)) continue;
      const { skills, errors } = parseMarketplace(cacheDir, {
        existsSync: _exists,
        readFileSync: _read,
      });
      if (errors.length > 0) continue;
      const matched = skills.filter((s) => s.name === need.need && s.status === "verified");
      if (matched.length > 0) {
        candidates.push({ entry, cacheDir, mpSkills: matched });
      }
    }

    if (candidates.length === 0) {
      resolutions.push({
        state: "unresolved",
        need: need.need,
        reason: need.reason,
        acquire: need.acquire,
      });
      continue;
    }

    if (candidates.length > 1) {
      resolutions.push({
        state: "ambiguous",
        need: need.need,
        reason: need.reason,
        matches: candidates
          .map((c) => ({ registryId: c.entry.name, commitOID: c.entry.commitOID }))
          .sort((a, b) => a.registryId.localeCompare(b.registryId)),
      });
      continue;
    }

    const candidate = candidates[0];
    if (!candidate) continue;
    const { entry, cacheDir, mpSkills } = candidate;
    const mpSkill = mpSkills[0];
    if (!mpSkill) {
      resolutions.push({
        state: "unresolved",
        need: need.need,
        reason: need.reason,
        acquire: need.acquire,
      });
      continue;
    }

    const subPath = mpSkill.path ?? `skills/${mpSkill.name}`;
    const skillDir = registrySkillDir(cacheDir, subPath);
    if (!skillDir || !_exists(join(skillDir, "SKILL.md"))) {
      resolutions.push({
        state: "unresolved",
        need: need.need,
        reason: need.reason,
        acquire: need.acquire,
      });
      continue;
    }

    const scanResult = _scanner
      ? _scanner(skillDir)
      : scanSkillDir(skillDir, { homedir: _homedir });
    const scanStatus = mapScanStatus(scanResult);
    const approvable = scanStatus.state !== "blocked";

    const proposal: SkillAcquisitionProposal = {
      id: proposalId(entry.name, entry.commitOID, mpSkill.name, mpSkill.version, subPath),
      need: need.need,
      reason: need.reason,
      name: mpSkill.name,
      version: mpSkill.version,
      source: {
        registryId: entry.name,
        commitOID: entry.commitOID,
        skillPath: subPath,
      },
      scan: scanStatus,
      approvable,
    };
    resolutions.push({ state: "proposal", proposal });
  }

  return resolutions.sort((a, b) => {
    const na =
      a.state === "proposal" ? a.proposal.need : a.state === "unresolved" ? a.need : a.need;
    const nb =
      b.state === "proposal" ? b.proposal.need : b.state === "unresolved" ? b.need : b.need;
    if (na !== nb) return na.localeCompare(nb);
    const ra = a.state === "proposal" ? a.proposal.source.registryId : "";
    const rb = b.state === "proposal" ? b.proposal.source.registryId : "";
    return ra.localeCompare(rb);
  });
}

export function buildAcquisitionProposals(
  repo: string,
  needs: readonly SkillNeed[],
  deps?: AcquisitionReadDeps,
): ProposalBuildResult {
  const resolutions = findAcquisitionCandidates(repo, needs, deps);
  const proposals: SkillAcquisitionProposal[] = [];
  const unresolved: string[] = [];
  const ambiguous: string[] = [];

  for (const r of resolutions) {
    if (r.state === "proposal") proposals.push(r.proposal);
    else if (r.state === "unresolved") unresolved.push(r.need);
    else if (r.state === "ambiguous") ambiguous.push(r.need);
  }

  return { proposals, unresolved, ambiguous, resolutions };
}

export async function runSkillAcquisitionGate(opts: {
  repo: string;
  needs: readonly SkillNeed[];
  execute: boolean;
  approver?: AcquisitionApprover;
  install?: (
    repo: string,
    registryId: string,
    skillName: string,
    opts: Record<string, unknown>,
  ) => number;
  scanner?: (dir: string) => SecurityScanResult;
  readDeps?: AcquisitionReadDeps;
  command?: string;
  recordDecisions?: (events: SkillAcquisitionDecision[]) => void;
}): Promise<AcquisitionGateResult> {
  const { repo, needs, execute, approver, install, scanner, readDeps, command, recordDecisions } =
    opts;
  const deps: AcquisitionReadDeps = scanner ? { ...readDeps, scanner } : (readDeps ?? {});

  if (!execute) {
    const { proposals } = buildAcquisitionProposals(repo, needs, deps);
    const unresolved = needs.filter((n) => n.status === "missing").map((n) => n.need);
    return { ok: true, installed: [], unresolved, proposals };
  }

  const result = buildAcquisitionProposals(repo, needs, deps);
  const { proposals } = result;

  if (proposals.length === 0 || !approver) {
    const unresolved = needs.filter((n) => n.status === "missing").map((n) => n.need);
    return { ok: true, installed: [], unresolved, proposals };
  }

  const decisions = await approver(proposals);
  const approved = proposals.filter((p) => decisions.get(p.id) === "approve" && p.approvable);
  const installed: string[] = [];
  const unresolved: string[] = [...result.unresolved, ...result.ambiguous];

  for (const p of proposals) {
    if (decisions.get(p.id) !== "approve" || !p.approvable) {
      unresolved.push(p.need);
    }
  }

  let failed: string | undefined;
  if (install) {
    for (const p of approved) {
      const code = install(repo, p.source.registryId, p.name, {
        version: p.version,
        onCollision: "skip",
        yes: true,
      });
      if (code !== 0) {
        failed = p.name;
        unresolved.push(p.need);
        const remaining = approved.slice(approved.indexOf(p) + 1);
        for (const r of remaining) unresolved.push(r.need);
        break;
      }
      installed.push(p.name);
    }
  }

  if (recordDecisions) {
    recordDecisions(
      proposals.map(
        (p): SkillAcquisitionDecision => ({
          event: "acquisition-decision",
          skill: p.name,
          source: `${p.source.registryId}@${p.source.commitOID.slice(0, 12)}`,
          decision: !p.approvable
            ? "blocked"
            : decisions.get(p.id) !== "approve"
              ? "reject"
              : failed === p.name
                ? "install-failed"
                : installed.includes(p.name)
                  ? "approve"
                  : "reject",
          command: command ?? "orchestrate",
          at: new Date().toISOString(),
        }),
      ),
    );
  }

  if (failed) {
    return {
      ok: false,
      reason: `install failed for ${failed}`,
      installed,
      unresolved,
      proposals,
    };
  }

  const finalUnresolved = needs
    .filter((n) => n.status === "missing" && !installed.includes(n.need))
    .map((n) => n.need);
  return { ok: true, installed, unresolved: finalUnresolved, proposals };
}
