// #673: machine-readable team skill policy and domain gates
// v1: parser/validator/matcher only. #674 derives checks, #675 enforces.
// matchPolicyPaths receives changed paths; caller (e.g. #674's git-diff) supplies them.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuditedHookDecision,
  HOOK_DECISION,
  isAuditedHookDecision,
} from "../core/hook-contract.js";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface ProtectedPathRule {
  pattern: string;
  domain?: string;
  requiredChecks?: string[];
}

export interface SkillPolicy {
  schemaVersion: number;
  domains: Record<string, { owners?: string[]; requiredChecks?: string[] }>;
  protectedPaths: ProtectedPathRule[];
  enforcementLevel: AuditedHookDecision;
}

export interface PolicyValidationResult {
  policy: SkillPolicy;
  errors: string[];
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/*  Default / fallback                                                */
/* ------------------------------------------------------------------ */

export function conservativeDefaultPolicy(): SkillPolicy {
  return {
    schemaVersion: 1,
    domains: {},
    protectedPaths: [],
    enforcementLevel: HOOK_DECISION.WARN,
  };
}

/* ------------------------------------------------------------------ */
/*  Schema validation                                                 */
/* ------------------------------------------------------------------ */

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateSchema(raw: unknown): PolicyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    errors.push("policy must be a JSON object");
    return { policy: conservativeDefaultPolicy(), errors, warnings };
  }

  // schemaVersion
  const sv = raw.schemaVersion;
  if (sv === undefined) errors.push('missing required field "schemaVersion"');
  else if (typeof sv !== "number" || sv !== 1) errors.push('"schemaVersion" must be 1');

  // enforcementLevel
  const el = raw.enforcementLevel;
  if (el === undefined) errors.push('missing required field "enforcementLevel"');
  else if (!isAuditedHookDecision(el)) {
    errors.push(`"enforcementLevel" must be one of: warn, require_approval, block`);
  }

  // domains
  if (raw.domains !== undefined) {
    if (!isRecord(raw.domains)) {
      errors.push('"domains" must be an object');
    } else {
      for (const [key, val] of Object.entries(raw.domains)) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
          warnings.push(`domain key "${key}" is not kebab-case`);
        }
        if (!isRecord(val)) {
          errors.push(`domain "${key}" value must be an object`);
          continue;
        }
        if (val.owners !== undefined && !isStringArray(val.owners)) {
          errors.push(`domain "${key}".owners must be a string array`);
        }
        if (val.requiredChecks !== undefined && !isStringArray(val.requiredChecks)) {
          errors.push(`domain "${key}".requiredChecks must be a string array`);
        }
      }
    }
  }

  // protectedPaths
  if (raw.protectedPaths !== undefined) {
    if (!Array.isArray(raw.protectedPaths)) {
      errors.push('"protectedPaths" must be an array');
    } else {
      for (let i = 0; i < raw.protectedPaths.length; i++) {
        const rule = raw.protectedPaths[i];
        if (!isRecord(rule)) {
          errors.push(`protectedPaths[${i}] must be an object`);
          continue;
        }
        if (typeof rule.pattern !== "string") {
          errors.push(`protectedPaths[${i}].pattern must be a string`);
        } else {
          const pErr = validatePattern(rule.pattern);
          if (pErr) errors.push(`protectedPaths[${i}].pattern: ${pErr}`);
        }
        if (rule.domain !== undefined && typeof rule.domain !== "string") {
          errors.push(`protectedPaths[${i}].domain must be a string`);
        }
        if (rule.requiredChecks !== undefined && !isStringArray(rule.requiredChecks)) {
          errors.push(`protectedPaths[${i}].requiredChecks must be a string array`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { policy: conservativeDefaultPolicy(), errors, warnings };
  }

  const domains: SkillPolicy["domains"] = {};
  if (isRecord(raw.domains)) {
    for (const [key, val] of Object.entries(raw.domains)) {
      if (isRecord(val)) {
        const entry: SkillPolicy["domains"][string] = {};
        if (isStringArray(val.owners)) entry.owners = val.owners;
        if (isStringArray(val.requiredChecks)) entry.requiredChecks = val.requiredChecks;
        domains[key] = entry;
      }
    }
  }

  const protectedPaths: ProtectedPathRule[] = [];
  if (Array.isArray(raw.protectedPaths)) {
    for (const rule of raw.protectedPaths) {
      if (isRecord(rule)) {
        const p: ProtectedPathRule = { pattern: String(rule.pattern ?? "") };
        if (typeof rule.domain === "string") p.domain = rule.domain;
        if (isStringArray(rule.requiredChecks)) p.requiredChecks = rule.requiredChecks;
        protectedPaths.push(p);
      }
    }
  }

  const policy: SkillPolicy = {
    schemaVersion: sv === 1 ? 1 : 1,
    domains,
    protectedPaths,
    enforcementLevel: isAuditedHookDecision(el) ? el : HOOK_DECISION.WARN,
  };

  return { policy, errors, warnings };
}

/** Reject absolute paths, `..`, NUL, backslash, empty string. */
function validatePattern(p: string): string | null {
  if (p.length === 0) return "pattern must not be empty";
  if (p.startsWith("/")) return "pattern must not be absolute";
  if (p.includes("..")) return 'pattern must not contain ".."';
  if (p.includes("\0")) return "pattern must not contain NUL byte";
  if (p.includes("\\")) return "pattern must not contain backslash";
  return null;
}

/* ------------------------------------------------------------------ */
/*  Read from disk                                                     */
/* ------------------------------------------------------------------ */

export function readSkillPolicy(
  repo: string,
  inject?: { existsSync?: typeof existsSync; readFileSync?: typeof readFileSync },
): { policy: SkillPolicy; warnings: string[] } {
  const exists = inject?.existsSync ?? existsSync;
  const read = inject?.readFileSync ?? readFileSync;
  const policyPath = join(repo, ".vibeflow", "SKILL_POLICY.json");

  if (!exists(policyPath)) {
    return { policy: conservativeDefaultPolicy(), warnings: [] };
  }

  let raw: unknown;
  try {
    const text = read(policyPath, "utf8");
    raw = JSON.parse(text);
  } catch {
    return {
      policy: conservativeDefaultPolicy(),
      warnings: ["SKILL_POLICY.json: malformed JSON, using conservative default"],
    };
  }

  const result = validateSkillPolicy(raw);
  const warnings = [...result.errors, ...result.warnings];
  return { policy: result.policy, warnings };
}

export function validateSkillPolicy(raw: unknown): PolicyValidationResult {
  return validateSchema(raw);
}

/* ------------------------------------------------------------------ */
/*  Glob matching (stdlib-only, deterministic)                         */
/* ------------------------------------------------------------------ */

export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLESTAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function isUnsafePath(p: string): boolean {
  return p.startsWith("/") || p.includes("\\") || p.includes("..") || p.includes("\0");
}

export function matchPolicyPaths(
  policy: SkillPolicy,
  changedPaths: string[],
): { rules: ProtectedPathRule[]; requiredChecks: string[] } {
  const seenRules = new Set<ProtectedPathRule>();
  const checks = new Set<string>();

  for (const cp of changedPaths) {
    if (isUnsafePath(cp)) continue;
    const normalised = cp.replace(/\\/g, "/");

    for (const rule of policy.protectedPaths) {
      const re = patternToRegex(rule.pattern);
      if (re.test(normalised)) {
        seenRules.add(rule);
        if (rule.requiredChecks) {
          for (const c of rule.requiredChecks) checks.add(c);
        }
      }
    }
  }

  // resolve domain-level checks
  for (const rule of seenRules) {
    const domainEntry = rule.domain ? policy.domains[rule.domain] : undefined;
    if (domainEntry?.requiredChecks) {
      for (const c of domainEntry.requiredChecks) checks.add(c);
    }
  }

  return {
    rules: [...seenRules],
    requiredChecks: [...checks].sort(),
  };
}
