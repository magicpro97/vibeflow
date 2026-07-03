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
    "You are a hostile code reviewer. Your default assumption is that this diff contains bugs.",
    "You have NOT seen the implementation process. Review only what is in this diff.",
    "",
    `Goal: ${opts.goal}`,
    opts.spec ? `Spec: ${opts.spec}` : "",
    "",
    "Diff:",
    opts.diff,
    "",
    "STEP 1 — Before reading the diff, list every behavior the goal/spec requires as numbered claims.",
    "STEP 2 — For each claim, find the EXACT line(s) in the diff that implement it, or write MISSING.",
    "STEP 3 — List edge cases implied by each claim that have NO test coverage.",
    "",
    "Cite file:line for every finding. No bare opinions.",
    "Respond COVERED only if ALL claims have implementing lines AND no critical edge cases are untested.",
  ]
    .filter(Boolean)
    .join("\n");
}
