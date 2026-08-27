import type { AuthorityApprovalCliInteractionV1 } from "../../capabilities/cli/ports.js";
import { type AuthorityPromptIoV1, DEFAULT_AUTHORITY_PROMPT_IO } from "./authority-prompt-io.js";

/** Authenticated local-TTY interaction; prompts use stderr so JSON stdout remains clean. */
export function createLocalAuthorityApprovalInteractionV1(
  io: AuthorityPromptIoV1 = DEFAULT_AUTHORITY_PROMPT_IO,
): AuthorityApprovalCliInteractionV1 {
  const interaction: AuthorityApprovalCliInteractionV1 = {
    authenticated_local_tty: true as const,
    respondToChallenge(input) {
      io.write(
        `\nAuthority approval challenge\n  Command: ${input.command}\n  Scope: ${input.scope}\n  Proposal: ${input.proposal_id}\n  Expires: ${input.expires_at}\nType ${input.display_phrase} to approve: `,
      );
      return io.readLine();
    },
  };
  return Object.freeze(interaction);
}
