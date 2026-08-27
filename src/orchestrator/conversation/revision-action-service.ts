import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { ActionProposalRequestV1, ActionRequestAuthorityV1 } from "../../actions/index.js";
import { CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE } from "./conversation-message-queue-contract.js";
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
    candidate.type === HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE
      ? candidate.target_participants
      : candidate.type === HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT ||
          candidate.type === HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT
        ? [candidate.participant_id]
        : CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL;
  if (
    targets !== CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL &&
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
