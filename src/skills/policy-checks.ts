// #674: derive required skill workflow checks from changed paths and risk class
// Pure core with injection seam for changed-path reader. No network, no LLM, no new deps.

import { spawnSync } from "node:child_process";
import { c } from "../core.js";
import { WORK_UNIT_RISK_CLASS, type WorkUnitRiskClass } from "../core/workflow-contract.js";
import { out } from "../logbus.js";
import { type ProtectedPathRule, matchPolicyPaths, readSkillPolicy } from "./policy.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type RiskClass = WorkUnitRiskClass;

export interface PolicyChecksResult {
  riskClass: RiskClass;
  requiredChecks: string[];
  matchedRules: ProtectedPathRule[];
  domains: string[];
}

export type ChangedPathReader = (opts: {
  repo: string;
  staged: boolean;
}) => string[] | null;

/* ------------------------------------------------------------------ */
/*  Risk class derivation (deterministic priority)                     */
/* ------------------------------------------------------------------ */

const ARCH_FILES = new Set([
  "src/commands.ts",
  "src/commands/_shared.ts",
  "src/core.ts",
  "src/server.ts",
]);

function normalise(p: string): string {
  return p.replace(/\\/g, "/");
}

function isSkillMd(p: string): boolean {
  const n = normalise(p);
  return n === "SKILL.md" || n.endsWith("/SKILL.md");
}

function isSecurityPath(p: string): boolean {
  const n = normalise(p);
  return (
    n.startsWith("src/security/") ||
    n.startsWith("src/hooks/") ||
    n.startsWith(".github/workflows/") ||
    isSkillMd(n)
  );
}

export function deriveRiskClass(paths: string[]): RiskClass {
  // priority 1: security
  if (paths.some(isSecurityPath)) return WORK_UNIT_RISK_CLASS.SECURITY;

  // priority 2: architecture (exact file matches)
  if (paths.some((p) => ARCH_FILES.has(normalise(p)))) return WORK_UNIT_RISK_CLASS.ARCHITECTURE;

  // priority 3: feature (any src/ path)
  if (paths.some((p) => normalise(p).startsWith("src/"))) return WORK_UNIT_RISK_CLASS.FEATURE;

  // priority 4: docs (all paths are docs or markdown)
  if (
    paths.length > 0 &&
    paths.every((p) => {
      const n = normalise(p);
      return n.startsWith("docs/") || n.endsWith(".md");
    })
  )
    return WORK_UNIT_RISK_CLASS.DOCS;

  return WORK_UNIT_RISK_CLASS.SIMPLE_CODE;
}

/* ------------------------------------------------------------------ */
/*  Required checks computation                                        */
/* ------------------------------------------------------------------ */

export function computeRequiredChecks(
  paths: string[],
  policyMatch: { rules: ProtectedPathRule[]; requiredChecks: string[] },
  risk: RiskClass,
): PolicyChecksResult {
  const checks = new Set(policyMatch.requiredChecks);
  const domains = new Set<string>();

  for (const rule of policyMatch.rules) {
    if (rule.domain) domains.add(rule.domain);
  }

  // built-in: SKILL.md changes → skills-validate + skillspector
  if (paths.some(isSkillMd)) {
    checks.add("skills-validate");
    checks.add("skillspector");
  }

  // built-in: security risk → security-scan
  if (risk === WORK_UNIT_RISK_CLASS.SECURITY) checks.add("security-scan");

  // built-in: DOMAIN_FACTS.json changed → domain-facts-check
  if (
    paths.some((p) => {
      const n = normalise(p);
      return n === ".vibeflow/DOMAIN_FACTS.json" || n.endsWith("/DOMAIN_FACTS.json");
    })
  ) {
    checks.add("domain-facts-check");
  }

  return {
    riskClass: risk,
    requiredChecks: [...checks].sort(),
    matchedRules: policyMatch.rules,
    domains: [...domains].sort(),
  };
}

/* ------------------------------------------------------------------ */
/*  Changed path reader (injectable)                                   */
/* ------------------------------------------------------------------ */

export function gitChangedPathReader(
  opts: { repo: string; staged: boolean },
  inject?: { spawnSync?: typeof spawnSync },
): string[] | null {
  const spawn = inject?.spawnSync ?? spawnSync;
  const args = ["diff", "--name-only"];
  if (opts.staged) args.push("--cached");
  else args.push("HEAD");

  const result = spawn("git", args, {
    cwd: opts.repo,
    timeout: 30000,
    encoding: "utf8",
  });

  if (result.error || result.status !== 0) return null;
  const stdout = (result.stdout ?? "").trim();
  if (!stdout) return [];
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/*  CLI handler                                                        */
/* ------------------------------------------------------------------ */

export function handlePolicyChecksSubcommand(
  repo: string,
  rest: string[],
  inject?: {
    readSkillPolicy?: typeof readSkillPolicy;
    changedPathReader?: ChangedPathReader;
  },
): number {
  let staged = false;
  for (const arg of rest) {
    if (arg === "--staged") {
      staged = true;
    } else {
      out("vf", c.red("Usage: vf skills policy-checks [--staged]"), {
        level: "error",
      });
      return 2;
    }
  }

  const reader = inject?.changedPathReader ?? gitChangedPathReader;
  const paths = reader({ repo, staged });

  if (paths === null) {
    out("vf", c.red("Failed to read changed paths from git."), {
      level: "error",
    });
    return 1;
  }

  if (paths.length === 0) {
    out("vf", c.dim("No changed files detected."));
    return 0;
  }

  const { policy } = (inject?.readSkillPolicy ?? readSkillPolicy)(repo);
  const policyMatch = matchPolicyPaths(policy, paths);
  const risk = deriveRiskClass(paths);
  const result = computeRequiredChecks(paths, policyMatch, risk);

  out("vf", `Risk: ${result.riskClass}`);
  out("vf", `Changed: ${paths.length}`);
  out(
    "vf",
    `Required checks: ${
      result.requiredChecks.length > 0 ? result.requiredChecks.join(", ") : "none"
    }`,
  );

  if (result.matchedRules.length > 0) {
    for (const rule of result.matchedRules) {
      out("vf", `  protected: ${rule.pattern}${rule.domain ? ` (${rule.domain})` : ""}`);
    }
  }

  return 0;
}
