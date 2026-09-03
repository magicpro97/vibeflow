import { CONVERSATION_REACTION_OPERATION } from "./conversation-interaction-contract.js";
import type { ConversationReactionOperationV1 } from "./conversation-interaction-types.js";

function activeKey(operation: ConversationReactionOperationV1): string {
  return `${operation.target.target_event_id}\0${operation.actor_public_id}\0${operation.emoji}`;
}

function participantTargetKey(operation: ConversationReactionOperationV1): string {
  return `${operation.target.target_event_id}\0${operation.actor_public_id}`;
}

function activeReactions(
  operations: readonly ConversationReactionOperationV1[],
): Map<string, ConversationReactionOperationV1> {
  const active = new Map<string, ConversationReactionOperationV1>();
  for (const operation of operations) {
    const key = activeKey(operation);
    if (operation.operation === CONVERSATION_REACTION_OPERATION.ADD) active.set(key, operation);
    else active.delete(key);
  }
  return active;
}

export function assertParticipantReactionTransitions(
  prior: readonly ConversationReactionOperationV1[],
  next: readonly ConversationReactionOperationV1[],
): void {
  let staged = [...prior];
  for (const operation of next) {
    const active = activeReactions(staged);
    const exact = active.get(activeKey(operation));
    if (operation.operation === CONVERSATION_REACTION_OPERATION.REMOVE) {
      if (!exact) throw new Error("reaction remove lacks an active owned reaction");
    } else {
      if (exact) throw new Error("reaction is already active");
      if (
        [...active.values()].some(
          (item) => participantTargetKey(item) === participantTargetKey(operation),
        )
      )
        throw new Error("participant already reacted to target");
    }
    staged = [...staged, operation];
  }
}
