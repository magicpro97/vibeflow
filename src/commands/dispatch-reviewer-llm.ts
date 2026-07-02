// src/commands/dispatch-reviewer-llm.ts
//
// ADR-001 phase 2: LLM review layer that fires after the local makeReviewer gate passes.
import { spawnSync } from "node:child_process";
import { buildReviewerPrompt } from "./orchestrate-reviewer.js";

export interface LLMReviewOpts {
  goal: string;
  spec?: string;
  diff: string;
  llmFn: (prompt: string) => Promise<string>;
}

export interface LLMReviewResult {
  pass: boolean;
  reason: string;
}

/**
 * ADR-001: LLM review after local gate passes.
 * Reviewer sees ONLY goal+spec+diff (buildReviewerPrompt strips dispatch context).
 * Injectable llmFn keeps this unit-testable without a real engine.
 */
export async function runLLMReview(opts: LLMReviewOpts): Promise<LLMReviewResult> {
  const prompt = buildReviewerPrompt({ goal: opts.goal, spec: opts.spec, diff: opts.diff });
  const raw = await opts.llmFn(prompt);
  const pass = /^COVERED/i.test(raw.trim());
  const reason = pass ? "LLM reviewer: COVERED" : `LLM reviewer: ${raw.trim().slice(0, 300)}`;
  return { pass, reason };
}

/** Get git diff for a set of file paths relative to cwd */
export function getUnitDiff(cwd: string, scope: string[]): string {
  try {
    const args = ["diff", "HEAD~1", "HEAD", "--", ...(scope.length ? scope : ["."])];
    const r = spawnSync("git", args, { encoding: "utf8", cwd });
    return ((r.stdout as string) ?? "").slice(0, 4000);
  } catch /* coverage-waiver: #477 — spawnSync does not throw on ENOENT in Bun */ {
    return "";
  }
}

/**
 * Build an llmFn that calls VIBEFLOW_AI bridge (same bridge as dispatch).
 * Returns undefined when VIBEFLOW_AI is not set — caller skips LLM review.
 * ponytail: only bridge mode; add cli-engine path when needed.
 */
export function makeVibflowLLMFn(): ((prompt: string) => Promise<string>) | undefined {
  const cmd = process.env.VIBEFLOW_AI;
  if (!cmd) return undefined;
  return async (prompt: string): Promise<string> => {
    const shell = process.platform === "win32" ? ["cmd.exe", "/c", cmd] : ["/bin/sh", "-c", cmd];
    const r = Bun.spawnSync(shell as [string, ...string[]], {
      stdin: Buffer.from(prompt, "utf8"),
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.stdout.toString();
  };
}
