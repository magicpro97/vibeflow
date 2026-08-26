export class ConversationRevisionConflictError extends Error {
  override readonly name: string = "ConversationRevisionConflictError";
}

export class ConversationRevisionInactiveHeadError extends ConversationRevisionConflictError {
  override readonly name = "ConversationRevisionInactiveHeadError";
  readonly code = "inactive_lineage_head" as const;

  constructor() {
    super("conversation is not the active lineage head");
  }
}

export class ConversationRevisionNotStableTerminalError extends ConversationRevisionConflictError {
  override readonly name = "ConversationRevisionNotStableTerminalError";
  readonly code = "not_stable_terminal" as const;

  constructor() {
    super("conversation is not stable terminal");
  }
}

export class ConversationRevisionCandidateInvalidError extends Error {
  override readonly name = "ConversationRevisionCandidateInvalidError";
}

export class ConversationRevisionCorruptError extends Error {
  override readonly name = "ConversationRevisionCorruptError";
}

export class ConversationHandoffTooLargeError extends Error {
  override readonly name = "ConversationHandoffTooLargeError";
  readonly public_error: PublicApiErrorV1;

  constructor(readonly candidate: PublicOversizedHandoffCandidateV1) {
    super("The shared conversation context is too large and needs reviewed compaction.");
    this.public_error = publicActionError({
      code: "handoff_too_large",
      message: this.message,
      correlation_id: candidate.candidate_id,
      retryable: false,
      recovery_action: "edit",
      details: { candidate },
    });
  }
}
import type { PublicOversizedHandoffCandidateV1 } from "../../actions/error-details.js";
import { type PublicApiErrorV1, publicActionError } from "../../actions/errors.js";
