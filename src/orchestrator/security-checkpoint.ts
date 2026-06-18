/**
 * Security checkpoint — runs after a work unit's coding phase and before
 * the independent reviewer. The user is asked for consent before any
 * security skill is invoked (so this is opt-in per unit).
 *
 * The default `askFn` is a y/n readline prompt; the default
 * `runSkillFn` is a no-op (the orchestrator wires the real engine in
 * commands.ts). Both are test seams — unit tests inject fakes.
 *
 * Verdict is parsed from the skill's output block (see
 * `.vibeflow/skills/checklist-security/SKILL.md`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { WorkUnit } from "../core.js";

/** Decision returned by the user-prompt step. */
export type SecurityConsent = "run" | "skip" | "abstain";

/** Outcome of the skill itself. */
export type SecurityVerdict = "pass" | "fail" | "needs-review" | "skipped" | "error";

export interface SecurityCheckpointResult {
  consent: SecurityConsent;
  verdict: SecurityVerdict;
  /** Number of checklist items the skill reported checked. */
  items_checked?: number;
  /** Failed item numbers, as reported by the skill. */
  items_failed?: number[];
  /** Free-form notes from the skill (high_risk_findings, evidence). */
  notes?: string;
}

/** Default readline y/n prompt. Inert in non-TTY contexts (returns "skip"). */
export function defaultSecurityAskFn(): (q: string) => Promise<SecurityConsent> {
  return (q: string) => {
    // Non-TTY: don't block CI, skip by default. Real users get a prompt.
    if (!process.stdin.isTTY) return Promise.resolve("skip");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) =>
      rl.question(`${q} [y/n/skip] (default: skip): `, (a) => {
        rl.close();
        const v = a.trim().toLowerCase();
        if (v === "y" || v === "yes") res("run");
        else if (v === "n" || v === "no") res("abstain");
        else res("skip");
      }),
    );
  };
}

/**
 * Default skill runner — reads the skill markdown and echoes it back as
 * the "output" of an engine-less invocation. In production, commands.ts
 * overrides this with a real engine dispatch. Kept here as a test seam
 * and a no-op fallback for non-engine contexts (e.g. unit tests).
 */
export async function defaultRunSkillFn(unit: WorkUnit, base: string): Promise<string> {
  const path = join(base, ".vibeflow/skills/checklist-security/SKILL.md");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

/** Parse the SECURITY_CHECK_RESULT block from a skill response. */
export function parseSecurityVerdict(raw: string): {
  verdict: SecurityVerdict;
  items_checked?: number;
  items_failed?: number[];
  notes?: string;
} {
  const m = raw.match(/SECURITY_CHECK_RESULT([\s\S]*?)(?:```|$)/);
  if (!m || !m[1]) {
    return { verdict: "error", notes: "no SECURITY_CHECK_RESULT block in skill output" };
  }
  const body = m[1];
  const verdict = (body.match(/verdict:\s*(\S+)/)?.[1] ?? "error") as SecurityVerdict;
  const ic = body.match(/items_checked:\s*(\d+)/);
  const failedRaw = body.match(/items_failed:\s*([^\n]+)/)?.[1]?.trim() ?? "";
  const items_failed =
    failedRaw && failedRaw !== "none"
      ? failedRaw
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n))
      : undefined;
  const evidence = body.match(/evidence:\s*([^\n]+)/)?.[1]?.trim();
  return {
    verdict,
    items_checked: ic ? Number(ic[1]) : undefined,
    items_failed,
    notes: evidence,
  };
}

/**
 * Run the security checkpoint for one unit.
 *
 * Flow:
 *   1. ask the user for consent (run / skip / abstain)
 *   2. if "run", dispatch the security skill and parse the verdict
 *   3. return a structured result the orchestrator records on the unit
 *
 * Never throws — all errors degrade to `{ verdict: "error", notes }`.
 */
export async function runSecurityCheckpoint(
  unit: WorkUnit,
  base: string,
  inject: {
    askFn?: () => (q: string) => Promise<SecurityConsent>;
    runSkillFn?: (unit: WorkUnit, base: string) => Promise<string>;
  } = {},
): Promise<SecurityCheckpointResult> {
  const ask = (inject.askFn ?? defaultSecurityAskFn)();
  const runSkill = inject.runSkillFn ?? defaultRunSkillFn;
  try {
    const consent = await ask(
      `Work unit "${unit.name}" finished coding. Run checklist-security skill?`,
    );
    if (consent !== "run") return { consent, verdict: "skipped" };
    const raw = await runSkill(unit, base);
    if (!raw) {
      return {
        consent,
        verdict: "error",
        notes: "checklist-security skill not found at .vibeflow/skills/checklist-security/SKILL.md",
      };
    }
    const parsed = parseSecurityVerdict(raw);
    return { consent, ...parsed };
  } catch (err) {
    return {
      consent: "abstain",
      verdict: "error",
      notes: err instanceof Error ? err.message : String(err),
    };
  }
}
