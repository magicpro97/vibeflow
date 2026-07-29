import { readdirSync, statSync } from "node:fs";
import type { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CTX_DIR, c } from "../core.js";
import { out } from "../logbus.js";
import { findEvalFile, loadEvalFile, runSkillEval } from "./eval.js";
import { readDomainFacts, validateDomainFacts } from "./facts.js";
import { readSkillPolicy } from "./policy.js";
import { discoverSkills } from "./registry.js";
import { scanBlocksPromotion, scanSkillDir } from "./security-scan.js";
import type { ScanDeps } from "./security-scan.js";
import { validateSkillDir } from "./validator.js";
import { verifyRegistryLockIntegrity } from "./verify-lock.js";

export interface CiGateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  scanned: boolean;
}

export interface CiGateDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  scanDeps?: ScanDeps;
}

function localSkillDirs(repo: string): { name: string; dir: string }[] {
  const root = join(repo, CTX_DIR, "skills");
  try {
    return readdirSync(root)
      .filter((name) => !name.startsWith("."))
      .map((name) => ({ name, dir: join(root, name) }))
      .filter(({ dir }) => statSync(dir).isDirectory());
  } catch {
    return [];
  }
}

export function runSkillCiGate(repo: string, deps: CiGateDeps = {}): CiGateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let anyScanned = false;
  const localSkills = localSkillDirs(repo);
  const validated = localSkills.map(({ dir }) => validateSkillDir(dir));
  errors.push(...validated.flatMap((skill) => skill.errors));
  warnings.push(...validated.flatMap((skill) => skill.warnings));
  const discovered = discoverSkills(repo);

  try {
    const facts = readDomainFacts(repo, {
      existsSync: deps.existsSync as ((path: string) => boolean) | undefined,
      readFileSync: deps.readFileSync as ((path: string, encoding: string) => string) | undefined,
    });
    if (facts) {
      const result = validateDomainFacts(
        facts,
        validated.flatMap((skill) => (skill.name ? [skill.name] : [])),
      );
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
  } catch (error) {
    errors.push(`DOMAIN_FACTS: ${(error as Error).message}`);
  }

  const localDirs = new Set(localSkills.map((skill) => skill.dir));
  for (const skill of discovered.filter((candidate) => localDirs.has(candidate.dir))) {
    const evalPath = findEvalFile(skill.dir, {
      existsSync: deps.existsSync as ((path: string) => boolean) | undefined,
    });
    if (!evalPath) continue;
    try {
      const evals = loadEvalFile(evalPath, {
        existsSync: deps.existsSync as ((path: string) => boolean) | undefined,
        readFileSync: deps.readFileSync as ((path: string, encoding: string) => string) | undefined,
      });
      if (evals.skill !== skill.name) {
        errors.push(
          `eval file skill mismatch: evals.json skill "${evals.skill}" ≠ skill "${skill.name}"`,
        );
        continue;
      }
      const result = runSkillEval(skill, evals);
      if (result.summary.triggerAccuracy < 1) {
        errors.push(
          `eval triggerAccuracy ${result.summary.triggerAccuracy.toFixed(2)} < 1 for "${skill.name}"`,
        );
      }
    } catch (error) {
      errors.push(`eval error for "${skill.name}": ${(error as Error).message}`);
    }
  }

  for (const { name, dir } of localSkills) {
    const result = scanSkillDir(dir, deps.scanDeps);
    if (!result.scanned) {
      warnings.push(`security scan not available for "${name}"`);
      continue;
    }
    anyScanned = true;
    const gate = scanBlocksPromotion(result);
    if (gate.blocked) errors.push(`security scan blocked for "${name}": ${gate.reason}`);
    if (gate.warn) warnings.push(`security scan warning for "${name}": ${gate.reason}`);
  }

  const lock = verifyRegistryLockIntegrity(repo);
  errors.push(...lock.errors);
  warnings.push(...lock.warnings);
  const policy = readSkillPolicy(repo, {
    existsSync: deps.existsSync,
    readFileSync: deps.readFileSync,
  });
  errors.push(...policy.warnings.map((warning) => `policy: ${warning}`));
  return { ok: errors.length === 0, errors, warnings, scanned: anyScanned };
}

export function handleSkillCiGate(repo: string, rest: string[] = []): number {
  if (rest.length) {
    out("vf", c.red("Usage: vf skills ci-gate"));
    return 2;
  }
  const result = runSkillCiGate(repo);
  for (const warning of result.warnings) out("vf", c.yellow(`! ${warning}`));
  for (const error of result.errors) out("vf", c.red(`✗ ${error}`));
  if (result.ok) {
    out("vf", c.green("✔ ci-gate passed"));
    return 0;
  }
  out("vf", c.red(`✗ ${result.errors.length} ci-gate error(s)`), { level: "error" });
  return 1;
}
