import type { ActionProposalRequestV1, ActionRequestAuthorityV1 } from "../../actions/index.js";
import { isTerminalLifecycle } from "./policy-registry.js";
import { isConversationRevisionMutation } from "./revision-action-manifest.js";
import type { ConversationDeferredRevisionAuthority } from "./revision-deferred-authority.js";
import {
  ConversationControlConflictError,
  ConversationInvalidTargetParticipantError,
  ConversationNotFoundError,
  rethrowControlConflict,
} from "./service-errors.js";
import type { ConversationManifest, ConversationSnapshot } from "./types.js";

export async function proposeDeferredConversationAction(input: {
  conversationId: string;
  manifest: ConversationManifest | null;
  snapshot: ConversationSnapshot | null;
  request: ActionProposalRequestV1;
  authority: ActionRequestAuthorityV1;
  revisions: ConversationDeferredRevisionAuthority;
}) {
  if (!input.manifest || !input.snapshot)
    throw new ConversationNotFoundError("conversation not found");
  if (!isTerminalLifecycle(input.snapshot.lifecycle))
    throw new ConversationControlConflictError("revision action requires a terminal source");
  if (!isConversationRevisionMutation(input.request.candidate))
    throw new ConversationControlConflictError("unsupported revision action");
  const candidate = input.request.candidate;
  const targets =
    candidate.type === "conversation.continue_message"
      ? candidate.target_participants
      : candidate.type === "conversation.remove_participant" ||
          candidate.type === "conversation.update_participant"
        ? [candidate.participant_id]
        : "all";
  if (
    targets !== "all" &&
    targets.some(
      (target) => !input.manifest?.bindings.some((binding) => binding.participant_id === target),
    )
  )
    throw new ConversationInvalidTargetParticipantError("unknown target participant");
  return input.revisions
    .proposeAction({
      conversationId: input.conversationId,
      snapshot: input.snapshot,
      request: input.request,
      authority: input.authority,
    })
    .catch(rethrowControlConflict);
}
