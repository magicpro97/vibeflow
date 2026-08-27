import type {
  ConversationInteractionFoldV1,
  ConversationReactionOperationV1,
  PublicReactionProjectionV1,
} from "./conversation-interaction-types.js";
import type { ConversationMessageQueueQuoteTargetKindV1 } from "./conversation-message-queue-contract.js";
import { publicReactionProjection } from "./conversation-reaction-projection.js";
import type { LineageNodeIdentityV1 } from "./lineage-types.js";
import { ConversationRevisionCorruptError } from "./revision-errors.js";

export function selectedRevisionReactionProjection(input: {
  root_session_id: string;
  interaction_fold: ConversationInteractionFoldV1 | null;
  selected_by_revision: ReadonlyMap<string, LineageNodeIdentityV1>;
  events_by_id: ReadonlyMap<
    string,
    {
      event_id: string;
      conversation_id: string;
      revision_id: string;
      target_kind: ConversationMessageQueueQuoteTargetKindV1;
    }
  >;
}): PublicReactionProjectionV1[] {
  const selectedOperations: ConversationReactionOperationV1[] = [];
  for (const operation of input.interaction_fold?.reactions ?? []) {
    const locator = operation.target;
    const target = input.events_by_id.get(locator.target_event_id);
    const selected = input.selected_by_revision.get(
      `${locator.conversation_id}\0${locator.revision_id}`,
    );
    if (!target && !selected) continue;
    if (
      !target ||
      !selected ||
      operation.root_session_id !== input.root_session_id ||
      locator.root_session_id !== input.root_session_id ||
      target.conversation_id !== locator.conversation_id ||
      target.revision_id !== locator.revision_id ||
      target.target_kind !== locator.target_kind
    )
      throw new ConversationRevisionCorruptError("reaction projection target changed");
    selectedOperations.push(structuredClone(operation));
  }
  return publicReactionProjection(selectedOperations, null);
}
