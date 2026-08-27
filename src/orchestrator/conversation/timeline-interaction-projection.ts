import { CONVERSATION_INTERACTION_STATE } from "./conversation-interaction-contract.js";
import type {
  ConversationInteractionProjectionV1,
  ConversationTimelineInteractionV1,
} from "./conversation-interaction-types.js";

export function timelineInteractionProjection(
  eventId: string,
  projection: ConversationInteractionProjectionV1 | undefined,
): ConversationTimelineInteractionV1 {
  if (!projection || projection.state === CONVERSATION_INTERACTION_STATE.DEGRADED)
    return {
      state: CONVERSATION_INTERACTION_STATE.DEGRADED,
      message_locator: null,
      quote_refs: [],
      reactions: [],
      diagnostic_code: null,
    };
  return {
    state: CONVERSATION_INTERACTION_STATE.READY,
    message_locator: structuredClone(projection.message_locators_by_event_id[eventId] ?? null),
    quote_refs: (projection.quote_projections_by_response_event_id[eventId] ?? []).map(
      (target, index) => ({
        quoting_message_id: eventId,
        quote_order: index + 1,
        target: structuredClone(target),
      }),
    ),
    reactions: structuredClone(
      projection.reaction_projections.filter(
        (reaction) => reaction.target.target_event_id === eventId,
      ),
    ),
    diagnostic_code: projection.diagnostics_by_response_event_id[eventId] ?? null,
  };
}
