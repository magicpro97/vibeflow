import { spawnSync } from "node:child_process";
import type { RiskLevel } from "../core.js";

/**
 * Optional semantic (LLM) risk tier — a soft, injected, fail-open signal that can only
 * RAISE the deterministic regex verdict (never lower it). Off by default: without the
 * VIBEFLOW_AI bridge configured, `defaultSemanticJudge` returns undefined and scoring
 * is byte-for-byte the regex result. Mirrors `defaultGoalEvalFn` (same bridge var).
 */

/** A pluggable command classifier: returns a tier, or undefined when it has no opinion. */
export type SemanticJudge = (command: string) => RiskLevel | undefined;

/**
 * Parse a `RISK: <LOW|MED|HIGH|CRIT>` verdict out of an LLM's stdout. Pure + case-insensitive;
 * accepts the MEDIUM/CRITICAL long forms. Returns undefined when no verdict line is present, so
 * an unparseable/absent answer fails open (the regex floor stands).
 */
export function parseSemanticRisk(raw: string): RiskLevel | undefined {
  const m = /\bRISK:\s*(LOW|MED(?:IUM)?|HIGH|CRIT(?:ICAL)?)\b/i.exec(raw);
  if (!m) return undefined;
  const tier = (m[1] ?? "").toUpperCase();
  if (tier === "LOW") return "low";
  if (tier === "HIGH") return "high";
  if (tier.startsWith("MED")) return "medium";
  return "critical";
}

/**
 * Gate the (potentially expensive) LLM call: consult the semantic tier ONLY when the
 * deterministic score is none/low AND the command is non-trivial — it contains a sub-shell
 * (`$(...)` / backticks), an inline `-c` script, or a network / eval / base64 token. A plain
 * `ls` never triggers a call; an already medium+ command is left to the deterministic verdict.
 */
export function shouldConsultSemantic(regexRisk: RiskLevel, command: string): boolean {
  if (regexRisk !== "none" && regexRisk !== "low") return false;
  return /\$\(|`|\s-c\s|\b(?:https?|curl|wget|nc|base64|eval)\b/i.test(command);
}

/**
 * Default judge: spawn the VIBEFLOW_AI bridge with a tight security-classifier prompt and
 * parse its verdict. Fail-open at every edge — no bridge configured, or any spawn/parse
 * failure, yields undefined so the deterministic floor is unchanged. `spawn` is injectable
 * for tests (mirrors `defaultGoalEvalFn`).
 */
export function defaultSemanticJudge(command: string, spawn = spawnSync): RiskLevel | undefined {
  const bridge = process.env.VIBEFLOW_AI;
  if (!bridge) return undefined;
  try {
    const parts = bridge.split(" ");
    const instructions =
      "You are a security classifier. Score the RISK of running this shell command. Reply with exactly one line `RISK: <LOW|MED|HIGH|CRITICAL>` then a one-line reason.";
    const prompt = `${instructions} Command: ${command}`;
    const r = spawn(parts[0] ?? "", [...parts.slice(1), prompt], {
      encoding: "utf8",
      timeout: 10000,
    });
    return parseSemanticRisk((r.stdout ?? "").toString());
  } catch {
    return undefined;
  }
}
