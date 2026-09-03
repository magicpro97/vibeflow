import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import type { BrowserHostActionRequestV1, HostActionV1 } from "../../actions/index.js";
import type { ConversationMessageQueueTargetParticipantsV1 } from "./conversation-message-queue-contract.js";
import {
  type ConversationRevisionTopologyMutationV1,
  projectConversationRevisionTopology,
} from "./revision-topology-authority.js";
import type { ConversationManifest, MessageRequest } from "./types.js";

export type ConversationRevisionMutationV1 = ConversationRevisionTopologyMutationV1;

export const CONVERSATION_REVISION_MUTATION_KINDS = Object.freeze([
  HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT,
  HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT,
  HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT,
  HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS,
  HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE,
] as const);

export function isConversationRevisionMutation(
  action: BrowserHostActionRequestV1 | HostActionV1,
): action is ConversationRevisionMutationV1 {
  return CONVERSATION_REVISION_MUTATION_KINDS.some((kind) => kind === action.type);
}

/** Materializes the complete immutable child manifest preimage for revision-owned actions. */
export function applyConversationRevisionMutation(input: {
  parent: ConversationManifest;
  action: ConversationRevisionMutationV1;
  idempotencyKey: string;
}): ConversationManifest {
  return projectConversationRevisionTopology(input).target;
}

export function revisionMessageRequest(action: ConversationRevisionMutationV1):
  | (MessageRequest & {
      target_participants: ConversationMessageQueueTargetParticipantsV1;
    })
  | null {
  return action.type === HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE
    ? {
        content: action.content,
        target_participants: action.target_participants,
        ...(action.quote_refs ? { quote_refs: structuredClone(action.quote_refs) } : {}),
      }
    : null;
}
