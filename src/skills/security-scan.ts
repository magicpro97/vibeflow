// src/skills/security-scan.ts
//
// Optional static security scan of a skill dir before it can be promoted to
// `verified` (issue #632). Wraps NVIDIA SkillSpector
// (https://github.com/NVIDIA/skillspector) as an OPTIONAL external tool, same
// spawn pattern as the ctx7/engine spawns (src/commands/init-ctx7.ts).
//
// Trust boundary this closes: schema validation (validator.ts) never inspects
// the SKILL.md body or scripts/ for prompt injection / exfiltration / dangerous
// commands. After #631 a skill promoted once is trusted for every project on
// the machine, so the promotion step (`vf skills verify`) is the gate.
//
// Hard invariants:
//  - Absent tool → {scanned:false}, NEVER throws, NEVER blocks (optional dep).
//  - `--no-llm` ALWAYS passed: static analysis only (regex/AST/YARA). No API
//    key, no network egress of skill content — matches docs/SECURITY_MODEL.md
//    "no silent network" posture. Enforced here, not just documented.
//  - Baseline lives OUTSIDE the skill tree (~/.vibeflow/security-baselines/)
//    so re-import can't wipe it and re-flag already-triaged findings.
//
// ponytail: no --format json schema validation lib; we defensively read the
// three fields we need off the parsed object. Add a zod schema only if
// SkillSpector's JSON shape starts drifting between versions.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { hasCommand } from "../core.js";

/** SkillSpector risk severities, low→high. Order matters for the gate compare. */
export type RiskSeverity = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

const SEVERITY_RANK: Record<RiskSeverity, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/** One finding surfaced to the user when a scan blocks promotion. */
export interface ScanFinding {
  rule_id: string;
  message: string;
  severity?: string;
}

export interface SecurityScanResult {
  /** false when SkillSpector is not installed — promotion proceeds, flagged not-scanned. */
  scanned: boolean;
  /** Why the scan did not run (only when scanned === false). */
  reason?: string;
  risk_severity?: RiskSeverity;
  risk_score?: number;
  findings: ScanFinding[];
}

/** Baseline file for a skill, kept OUT of the skill's own tree (survives re-import). */
export function baselinePath(skillName: string, inject: { homedir?: () => string } = {}): string {
  const home = inject.homedir ? inject.homedir() : (process.env.VF_SKILLS_HOME ?? homedir());
  const dir = join(home, ".vibeflow", "security-baselines");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${skillName}.yaml`);
}

/** Parse SkillSpector `--format json` stdout into a SecurityScanResult. Lenient:
 *  unknown/missing fields degrade to a scanned-but-empty result rather than throw. */
export function parseScanJson(stdout: string): SecurityScanResult {
  let obj: unknown;
  try {
    obj = JSON.parse(stdout);
  } catch {
    return { scanned: false, reason: "unparseable scanner output", findings: [] };
  }
  if (!obj || typeof obj !== "object") {
    return { scanned: false, reason: "unexpected scanner output", findings: [] };
  }
  const r = obj as Record<string, unknown>;
  const sevRaw = typeof r.risk_severity === "string" ? r.risk_severity.toUpperCase() : "";
  const risk_severity =
    (SEVERITY_RANK as Record<string, number>)[sevRaw] !== undefined
      ? (sevRaw as RiskSeverity)
      : undefined;
  const risk_score = typeof r.risk_score === "number" ? r.risk_score : undefined;
  const rawFindings = Array.isArray(r.filtered_findings) ? r.filtered_findings : [];
  const findings: ScanFinding[] = [];
  for (const f of rawFindings) {
    if (!f || typeof f !== "object") continue;
    const fr = f as Record<string, unknown>;
    findings.push({
      rule_id: typeof fr.rule_id === "string" ? fr.rule_id : "unknown",
      message: typeof fr.message === "string" ? fr.message : "",
      severity: typeof fr.severity === "string" ? fr.severity : undefined,
    });
  }
  return { scanned: true, risk_severity, risk_score, findings };
}

export interface ScanDeps {
  hasCommand?: (cmd: string) => boolean;
  spawnSync?: typeof spawnSync;
  homedir?: () => string;
}

/**
 * Statically scan a skill dir with SkillSpector. OPTIONAL: absent tool returns
 * {scanned:false} and never throws. Present → spawns
 * `skillspector scan <dir> --no-llm --format json --baseline <path>` and parses
 * the result. `--no-llm` is hard-coded (static only, no content egress).
 */
export function scanSkillDir(skillDir: string, deps: ScanDeps = {}): SecurityScanResult {
  const _hasCommand = deps.hasCommand ?? hasCommand;
  const _spawnSync = deps.spawnSync ?? spawnSync;
  if (!_hasCommand("skillspector")) {
    return { scanned: false, reason: "skillspector not installed", findings: [] };
  }
  // Everything that can throw (mkdirSync in baselinePath, spawnSync on EACCES/
  // ENOMEM/ENOENT-race) is caught: a throw MUST degrade to {scanned:false}, never
  // crash the promotion command (invariant #1 — optional dep never hard-blocks).
  try {
    const name = basename(skillDir);
    const baseline = baselinePath(name, { homedir: deps.homedir });
    const r = _spawnSync(
      "skillspector",
      ["scan", skillDir, "--no-llm", "--format", "json", "--baseline", baseline],
      { encoding: "utf8", timeout: 120_000 },
    );
    // A non-zero exit is EXPECTED when findings exist — SkillSpector still emits
    // JSON on stdout. Only treat a truly empty stdout as a scan failure.
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    if (!stdout.trim()) {
      const err = typeof r.stderr === "string" && r.stderr.trim() ? r.stderr.trim() : "no output";
      return { scanned: false, reason: `scanner produced no output (${err})`, findings: [] };
    }
    return parseScanJson(stdout);
  } catch (err) {
    return { scanned: false, reason: `scan failed: ${(err as Error).message}`, findings: [] };
  }
}

/**
 * The promotion gate decision. Default policy (#632, confirm-before-merge):
 *  HIGH/CRITICAL → block; MEDIUM → warn; LOW/NONE/not-scanned → pass.
 * Returns {blocked, reason?} — the caller (verify.ts) turns a block into a
 * non-zero exit with the findings surfaced.
 */
export function scanBlocksPromotion(result: SecurityScanResult): {
  blocked: boolean;
  warn: boolean;
  reason?: string;
} {
  if (!result.scanned) return { blocked: false, warn: false };
  const sev = result.risk_severity;
  if (sev && SEVERITY_RANK[sev] >= SEVERITY_RANK.HIGH) {
    const top = result.findings
      .slice(0, 3)
      .map((f) => `${f.rule_id}: ${f.message}`)
      .join("; ");
    return {
      blocked: true,
      warn: false,
      reason: `security scan risk=${sev}${top ? ` — ${top}` : ""}`,
    };
  }
  if (sev === "MEDIUM") {
    return {
      blocked: false,
      warn: true,
      reason: "security scan risk=MEDIUM (allowed, review advised)",
    };
  }
  return { blocked: false, warn: false };
}
