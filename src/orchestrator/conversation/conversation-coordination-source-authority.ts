import {
  CONVERSATION_COORDINATION_PHASE,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCE,
} from "./conversation-coordination-contract.js";
import type { ConversationCoordinationStateV1 } from "./conversation-coordination-fold.js";
import { CONVERSATION_TURN_INSTRUCTION_KIND } from "./turn-delivery-contract.js";
import type { PreparedConversationTurnV1 } from "./turn-delivery-types.js";
import type { ConversationContext } from "./types.js";

function turnReferences(delivery: PreparedConversationTurnV1): ReadonlySet<string> {
  return new Set([
    ...(delivery.envelope.instruction.kind === CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_PLAN
      ? [delivery.envelope.instruction.topic_message_ref]
      : []),
    ...delivery.envelope.user_messages.map((message) => message.message_id),
    ...delivery.envelope.public_responses.map((response) => response.message_id),
    ...delivery.envelope.recipient_history.entries.map((entry) => entry.message_id),
  ]);
}

export function referencesBelongToTurn(
  references: readonly string[],
  delivery: PreparedConversationTurnV1,
): boolean {
  const authority = turnReferences(delivery);
  return references.length > 0 && references.every((reference) => authority.has(reference));
}

export function delegationCitesCurrentUserDecision(
  state: ConversationCoordinationStateV1,
  references: readonly string[],
  delivery: PreparedConversationTurnV1,
): boolean {
  if (
    state.phase !== CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT ||
    state.last_blocked?.recoverable !== false ||
    state.last_escalation === null
  )
    return true;
  const deliveredUserMessageIds = new Set(
    delivery.envelope.user_messages.map((message) => message.message_id),
  );
  const applicableUserMessageIds = delivery.applicable_user_message_ids;
  return (
    applicableUserMessageIds.length > 0 &&
    applicableUserMessageIds.length === delivery.applicable_user_message_count &&
    new Set(applicableUserMessageIds).size === applicableUserMessageIds.length &&
    applicableUserMessageIds.every((messageId) => deliveredUserMessageIds.has(messageId)) &&
    references.some((reference) => applicableUserMessageIds.includes(reference))
  );
}

export function resolutionSourceVerified(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
  delivery: PreparedConversationTurnV1,
  resolution: { source: string; source_refs: readonly string[]; assumptions: readonly string[] },
): boolean {
  if (resolution.source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.TASK_SPEC)
    return (
      resolution.source_refs.length > 0 &&
      resolution.source_refs.every((reference) =>
        state.active_task?.source_message_refs.includes(reference),
      )
    );
  if (resolution.source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.CONVERSATION_CONTEXT)
    return referencesBelongToTurn(resolution.source_refs, delivery);
  if (resolution.source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.REPO_EVIDENCE)
    return context.validateCoordinationRepoEvidence(resolution.source_refs);
  return (
    resolution.source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.SAFE_DEFAULT &&
    resolution.source_refs.length === 0 &&
    resolution.assumptions.length > 0
  );
}
