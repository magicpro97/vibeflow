// src/commands/orchestrate-reviewer.ts
//
// ADR-001: reviewer context isolation. buildReviewerPrompt produces input
// that contains ONLY goal + spec + diff — no dispatch prompt, no self-report.

export interface ReviewerPromptOpts {
  goal: string;
  spec?: string;
  diff: string;
}

/**
 * Build the reviewer's input. Receives ONLY goal + spec + diff.
 * Context isolation guarantee: no dispatch prompt, no self-report, no workflow reasoning.
 * ADR-001: different session (fresh context) is already enforced by vf's spawner.
 * This function enforces WHAT the reviewer sees, not just that it's fresh.
 */
export function buildReviewerPrompt(opts: ReviewerPromptOpts): string {
  return [
    "You are an independent code reviewer. You have NOT seen the implementation process.",
    "Review only what you see in this diff. Do not infer intent beyond what is explicit.",
    "",
    `Goal: ${opts.goal}`,
    opts.spec ? `Spec: ${opts.spec}` : "",
    "",
    "Diff:",
    opts.diff,
    "",
    "Answer:",
    "1. Does this diff implement the goal as stated?",
    "2. What edge cases from the goal/spec are NOT covered?",
    "3. Are there tests that only test the happy path?",
    "",
    "Cite file:line for every finding. No bare opinions.",
    "Respond COVERED if all goal behaviors are present, or list specific missing behaviors.",
  ]
    .filter(Boolean)
    .join("\n");
}
