import type {
  ConversationInteractionFoldV1,
  ConversationInteractionProjectionV1,
  ConversationReactionOperationV1,
  PublicMessageLocatorV1,
  PublicReactionProjectionV1,
  ReactionEmojiV1,
} from "./conversation-interaction-types.js";

function activeOperations(
  operations: readonly ConversationReactionOperationV1[],
): ConversationReactionOperationV1[] {
  const active = new Map<string, ConversationReactionOperationV1>();
  for (const operation of operations) {
    const key = `${operation.target.target_event_id}\0${operation.actor_public_id}\0${operation.emoji}`;
    if (operation.operation === "add") active.set(key, operation);
    else active.delete(key);
  }
  return [...active.values()];
}

function actors(
  operations: readonly ConversationReactionOperationV1[],
  recipient: string | null,
): string[] {
  return [...new Set(operations.map((row) => row.actor_public_id))]
    .filter((actor) => actor !== recipient)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

export function publicReactionProjection(
  operations: readonly ConversationReactionOperationV1[],
  recipient: string | null,
): PublicReactionProjectionV1[] {
  const groups = new Map<string, ConversationReactionOperationV1[]>();
  for (const operation of activeOperations(operations)) {
    const key = `${operation.target.target_event_id}\0${operation.emoji}`;
    groups.set(key, [...(groups.get(key) ?? []), operation]);
  }
  return [...groups.values()]
    .map((rows) => {
      const first = rows[0];
      if (!first) throw new Error("empty reaction projection group");
      const actorIds = actors(rows, null);
      return {
        target: structuredClone(first.target),
        emoji: first.emoji,
        count: actorIds.length,
        reacted_by_recipient: recipient !== null && actorIds.includes(recipient),
        actor_public_ids: actorIds,
      };
    })
    .sort(
      (left, right) =>
        Buffer.compare(
          Buffer.from(left.target.target_event_id),
          Buffer.from(right.target.target_event_id),
        ) || Buffer.compare(Buffer.from(left.emoji), Buffer.from(right.emoji)),
    );
}

export function conversationReactionChanges(
  fold: ConversationInteractionFoldV1,
  recipient: string | null,
): ConversationInteractionProjectionV1["reaction_changes"] {
  const active = activeOperations(fold.reactions);
  const groups = new Map<
    string,
    { target: PublicMessageLocatorV1; emoji: ReactionEmojiV1; sequence: number }
  >();
  for (const operation of fold.reactions) {
    const key = `${operation.target.target_event_id}\0${operation.emoji}`;
    const sequence = fold.reaction_sequences_by_operation_id[operation.operation_id];
    if (sequence === undefined) throw new Error("reaction sequence authority is absent");
    const current = groups.get(key);
    if (!current || sequence > current.sequence)
      groups.set(key, {
        target: structuredClone(operation.target),
        emoji: operation.emoji,
        sequence,
      });
  }
  return [...groups.values()]
    .map((group) => {
      const groupOperations = active.filter(
        (operation) =>
          operation.target.target_event_id === group.target.target_event_id &&
          operation.emoji === group.emoji,
      );
      const actorIds = actors(groupOperations, recipient);
      return {
        target: group.target,
        emoji: group.emoji,
        count: actorIds.length,
        reacted_by_recipient: false,
        actor_public_ids: actorIds,
        last_changed_interaction_sequence: group.sequence,
      };
    })
    .sort(
      (left, right) =>
        left.last_changed_interaction_sequence - right.last_changed_interaction_sequence ||
        Buffer.compare(
          Buffer.from(left.target.target_event_id),
          Buffer.from(right.target.target_event_id),
        ) ||
        Buffer.compare(Buffer.from(left.emoji), Buffer.from(right.emoji)),
    );
}
