// #675: check staged impact evidence before commit.
// Pure core with injection seam. Never throws.
// Required evidence when computed requiredChecks contain domain-facts-check
// or a policy match domain has required checks.

import { spawnSync } from "node:child_process";
import { c } from "../core.js";
import { out } from "../logbus.js";
import {
  type ChangedPathReader,
  computeRequiredChecks,
  deriveRiskClass,
  gitChangedPathReader,
} from "../skills/policy-checks.js";
import {
  type SkillPolicy,
  matchPolicyPaths,
  patternToRegex,
  type readSkillPolicy,
  validateSkillPolicy,
} from "../skills/policy.js";

export const EVIDENCE_REL = ".vibeflow/evidence/skill-impact.json";

export interface ImpactEvidence {
  paths: string[];
  checks: string[];
}

export interface EvidenceCheckResult {
  required: boolean;
  ok: boolean;
  reason?: string;
}

export type ReadStagedEvidence = (repo: string) => string | null;
export type ReadStagedPolicy = (repo: string) => SkillPolicy | null;

function defaultStagedEvidenceReader(repo: string, spawn?: typeof spawnSync): string | null {
  const fn = spawn ?? spawnSync;
  const result = fn("git", ["show", `:${EVIDENCE_REL}`], {
    cwd: repo,
    encoding: "utf8",
    timeout: 10000,
  });
  if (result.error || result.status !== 0) return null;
  const stdout = result.stdout ?? "";
  return stdout.length > 0 ? stdout : null;
}

function defaultStagedPolicyReader(repo: string, spawn?: typeof spawnSync): SkillPolicy | null {
  const fn = spawn ?? spawnSync;

  const index = fn("git", ["show", ":.vibeflow/SKILL_POLICY.json"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 10000,
  });
  let raw: unknown;
  if (index.error === null && index.status === 0 && (index.stdout ?? "").length > 0) {
    try {
      raw = JSON.parse(index.stdout);
    } catch {
      return null;
    }
  } else {
    const head = fn("git", ["show", "HEAD:.vibeflow/SKILL_POLICY.json"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 10000,
    });
    if (head.error || head.status !== 0 || (head.stdout ?? "").length === 0) return null;
    try {
      raw = JSON.parse(head.stdout);
    } catch {
      return null;
    }
  }

  const result = validateSkillPolicy(raw);
  return result.errors.length === 0 ? result.policy : null;
}

export function checkImpactEvidence(
  repo: string,
  changedPaths?: string[],
  inject?: {
    readStagedEvidence?: ReadStagedEvidence;
    readStagedPolicy?: ReadStagedPolicy;
    readSkillPolicy?: typeof readSkillPolicy;
    changedPathReader?: ChangedPathReader;
    spawnSync?: typeof spawnSync;
  },
): EvidenceCheckResult {
  try {
    const reader = inject?.changedPathReader ?? gitChangedPathReader;
    const paths = changedPaths ?? reader({ repo, staged: true });
    if (!paths || paths.length === 0) {
      return { required: false, ok: true };
    }

    const stagedPolicy = inject?.readStagedPolicy
      ? inject.readStagedPolicy(repo)
      : defaultStagedPolicyReader(repo, inject?.spawnSync);

    const hasProtectedSource = paths.some(
      (p) => p.startsWith("src/") || p === ".vibeflow/DOMAIN_FACTS.json",
    );

    if (stagedPolicy === null) {
      if (hasProtectedSource) {
        return {
          required: true,
          ok: false,
          reason:
            "Cannot read skill policy — staged/HEAD policy missing or invalid. Commit blocked (fail-closed).",
        };
      }
      return { required: false, ok: true };
    }

    const policy = stagedPolicy;
    const policyMatch = matchPolicyPaths(policy, paths);
    const risk = deriveRiskClass(paths);
    const checks = computeRequiredChecks(paths, policyMatch, risk);

    const hasDomainFacts = checks.requiredChecks.includes("domain-facts-check");
    const hasDomainRequiredChecks = checks.matchedRules.some((r) => {
      if (!r.domain) return false;
      const d = policy.domains[r.domain];
      return !!d?.requiredChecks?.length;
    });

    if (!hasDomainFacts && !hasDomainRequiredChecks) {
      return { required: false, ok: true };
    }

    // Evidence required — read the staged evidence file
    const raw = inject?.readStagedEvidence
      ? inject.readStagedEvidence(repo)
      : defaultStagedEvidenceReader(repo, inject?.spawnSync);

    if (raw === null) {
      return {
        required: true,
        ok: false,
        reason: `Required impact evidence not found at ${EVIDENCE_REL}. Stage a valid ${EVIDENCE_REL} file with impacted paths and required checks.`,
      };
    }

    let evidence: unknown;
    try {
      evidence = JSON.parse(raw);
    } catch {
      return {
        required: true,
        ok: false,
        reason: `Impact evidence at ${EVIDENCE_REL} is not valid JSON.`,
      };
    }

    const ev = evidence as Record<string, unknown>;
    if (!Array.isArray(ev.paths) || !Array.isArray(ev.checks)) {
      return {
        required: true,
        ok: false,
        reason: `Impact evidence at ${EVIDENCE_REL} must contain "paths" and "checks" arrays.`,
      };
    }

    const evPaths = ev.paths as unknown[];
    const evChecks = ev.checks as unknown[];
    for (let i = 0; i < evPaths.length; i++) {
      if (typeof evPaths[i] !== "string" || (evPaths[i] as string).trim().length === 0) {
        return {
          required: true,
          ok: false,
          reason: `Impact evidence ${EVIDENCE_REL}: paths[${i}] must be a non-empty string.`,
        };
      }
    }
    for (let i = 0; i < evChecks.length; i++) {
      if (typeof evChecks[i] !== "string" || (evChecks[i] as string).trim().length === 0) {
        return {
          required: true,
          ok: false,
          reason: `Impact evidence ${EVIDENCE_REL}: checks[${i}] must be a non-empty string.`,
        };
      }
    }

    const evidencePaths = new Set(evPaths.map((p) => (p as string).replace(/\\/g, "/")));
    const evidenceChecks = new Set(evChecks.map((c) => (c as string).trim()));

    // Compute required evidence paths: impacted protected paths + DOMAIN_FACTS.json
    const normalisedChanged = paths.map((p) => p.replace(/\\/g, "/"));
    const requiredEvidencePaths = new Set<string>();

    for (const p of normalisedChanged) {
      for (const rule of checks.matchedRules) {
        if (!rule.domain) continue;
        const d = policy.domains[rule.domain];
        if (!d?.requiredChecks?.length) continue;
        const re = patternToRegex(rule.pattern);
        if (re.test(p)) {
          requiredEvidencePaths.add(p);
          break;
        }
      }
    }

    const DF = ".vibeflow/DOMAIN_FACTS.json";
    if (normalisedChanged.includes(DF)) {
      requiredEvidencePaths.add(DF);
    }

    requiredEvidencePaths.delete(EVIDENCE_REL);

    const allPathsCovered = [...requiredEvidencePaths].every((p) => evidencePaths.has(p));
    const allChecksCovered = checks.requiredChecks.every((c) => evidenceChecks.has(c));

    if (!allPathsCovered) {
      const missing = [...requiredEvidencePaths].filter((p) => !evidencePaths.has(p));
      return {
        required: true,
        ok: false,
        reason: `Impact evidence ${EVIDENCE_REL} does not cover all required paths. Missing: ${missing.join(", ")}`,
      };
    }
    if (!allChecksCovered) {
      return {
        required: true,
        ok: false,
        reason: `Impact evidence ${EVIDENCE_REL} does not cover all required checks. Missing: ${checks.requiredChecks.filter((c) => !evidenceChecks.has(c)).join(", ")}`,
      };
    }

    return { required: true, ok: true };
  } catch {
    return { required: true, ok: false, reason: "Impact evidence check failed unexpectedly." };
  }
}

export function handleImpactEvidenceSubcommand(
  repo: string,
  rest: string[],
  inject?: {
    readSkillPolicy?: typeof readSkillPolicy;
    changedPathReader?: ChangedPathReader;
    readStagedEvidence?: ReadStagedEvidence;
    readStagedPolicy?: ReadStagedPolicy;
  },
): number {
  let staged = false;
  for (const arg of rest) {
    if (arg === "--staged") {
      staged = true;
    } else {
      out("vf", c.red("Usage: vf skills impact-evidence [--staged]"), { level: "error" });
      return 2;
    }
  }

  if (!staged) {
    out("vf", c.red("Usage: vf skills impact-evidence [--staged]"), { level: "error" });
    return 2;
  }

  const reader = inject?.changedPathReader ?? gitChangedPathReader;
  const paths = reader({ repo, staged: true });
  if (paths === null) {
    out("vf", c.red("Failed to read changed paths from git."), { level: "error" });
    return 1;
  }

  const result = checkImpactEvidence(repo, paths, {
    readSkillPolicy: inject?.readSkillPolicy,
    changedPathReader: inject?.changedPathReader,
    readStagedEvidence: inject?.readStagedEvidence,
    readStagedPolicy: inject?.readStagedPolicy,
  });

  if (!result.required) {
    out("vf", c.dim("Impact evidence not required."));
    return 0;
  }

  if (result.ok) {
    out("vf", c.green("Impact evidence valid."));
    return 0;
  }

  out("vf", c.red(`Impact evidence: ${result.reason}`), { level: "error" });
  out(
    "vf",
    c.dim(`Required: stage a ${EVIDENCE_REL} file:
{
  "paths": ["src/domain/ctc/..."],
  "checks": ["domain-facts-check"]
}`),
  );
  return 1;
}
