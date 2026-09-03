import type {
  AuthorityRepairCliCriticalReviewPromptV1,
  AuthorityRepairCliInteractionV1,
  AuthorityRepairCliRecoveryReviewPromptV1,
} from "../../capabilities/cli/ports.js";

import {
  type AuthorityPromptIoV1,
  DEFAULT_AUTHORITY_PROMPT_IO,
  exactAuthorityConfirmation,
} from "./authority-prompt-io.js";

export type AuthorityRepairPromptIoV1 = AuthorityPromptIoV1;

function criticalReview(
  io: AuthorityRepairPromptIoV1,
  input: AuthorityRepairCliCriticalReviewPromptV1,
): boolean {
  io.write(
    `\nCritical authority repair\n  Domain: ${input.candidate.action_domain}\n  Scope: ${input.candidate.authority_scope}\n  Strategy: ${input.candidate.strategy}\n  Recovery bootstrap: ${input.bootstrap_required ? "required" : "not required"}\n`,
  );
  return exactAuthorityConfirmation(io, "Approve this immutable repair plan?", input.repair_id);
}

function recoveryReview(
  io: AuthorityRepairPromptIoV1,
  input: AuthorityRepairCliRecoveryReviewPromptV1,
): boolean {
  io.write(
    `\nRecovery-TTY checkpoint approval\n  Scope: ${input.candidate.authority_scope}\n  Strategy: ${input.candidate.strategy}\n`,
  );
  return exactAuthorityConfirmation(
    io,
    "Authorize only this isolated recovery operation?",
    input.operation_id,
  );
}

/** Authenticated local-TTY interaction; prompts use stderr so JSON stdout remains clean. */
export function createLocalAuthorityRepairInteractionV1(
  io: AuthorityRepairPromptIoV1 = DEFAULT_AUTHORITY_PROMPT_IO,
): AuthorityRepairCliInteractionV1 {
  const interaction: AuthorityRepairCliInteractionV1 = {
    authenticated_local_tty: true,
    selectCandidate(input) {
      if (input.candidates.length === 0) return null;
      io.write("\nValidated authority repair checkpoints:\n");
      input.candidates.forEach((candidate, index) => {
        io.write(
          `  ${index + 1}. ${candidate.action_domain} / ${candidate.authority_scope} / ${candidate.strategy} (${candidate.control_state})\n`,
        );
      });
      io.write(`Select 1-${input.candidates.length}, or press Enter to cancel: `);
      const answer = io.readLine();
      if (!answer || !/^[1-9][0-9]*$/.test(answer)) return null;
      return input.candidates[Number(answer) - 1]?.candidate_id ?? null;
    },
    confirmCriticalReview: (input) => criticalReview(io, input),
    confirmRecoveryReview: (input) => recoveryReview(io, input),
  };
  return Object.freeze(interaction);
}
