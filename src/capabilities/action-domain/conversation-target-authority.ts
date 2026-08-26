import {
  type BrowserHostActionRequestV1,
  validateInternalHostAction,
} from "../../actions/index.js";
import { ConversationActionTargetUnsupportedError } from "../../orchestrator/conversation/conversation-action-domain.js";
import type { CapabilityConversationProposalBaseV1 } from "../../orchestrator/conversation/conversation-action-service.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import type { CapabilityHostActionV1 } from "../planning/types.js";

export type BrowserCapabilityActionV1 = Extract<
  BrowserHostActionRequestV1,
  { type: `capability.${string}` }
>;

export function isCapabilityAction(
  candidate: BrowserHostActionRequestV1,
): candidate is BrowserCapabilityActionV1 {
  return candidate.type.startsWith("capability.");
}

function directAction(candidate: BrowserHostActionRequestV1): CapabilityHostActionV1 {
  if (!isCapabilityAction(candidate))
    throw new ConversationActionTargetUnsupportedError(candidate.type);
  return validateInternalHostAction(candidate) as CapabilityHostActionV1;
}

function targetSelectors(candidate: BrowserCapabilityActionV1) {
  return candidate.type === "capability.install" || candidate.type === "capability.retarget"
    ? candidate.requested_targets
    : candidate.type === "capability.update"
      ? candidate.requested_targets
      : null;
}

export function assertConversationCapabilityTargets(
  candidate: BrowserCapabilityActionV1 | CapabilityHostActionV1,
  conversation: CapabilityConversationProposalBaseV1,
): void {
  const selectors = targetSelectors(candidate as BrowserCapabilityActionV1);
  if (selectors === null) return;
  if (!conversation.participants)
    throw new CapabilityRuntimeError(
      "conversation capability participant authority is unavailable",
      "service-unavailable",
    );
  const participants = new Map(
    conversation.participants.map((participant) => [participant.participant_id, participant]),
  );
  const keys = new Set<string>();
  for (const selector of selectors) {
    if (selector.participant_id === null)
      throw new CapabilityRuntimeError(
        "conversation capability targets must name a current participant",
        "invalid-plan",
      );
    const participant = participants.get(selector.participant_id);
    if (!participant || participant.engine !== selector.engine)
      throw new CapabilityRuntimeError(
        "conversation capability target participant or engine is stale",
        "invalid-plan",
      );
    const key = `${selector.engine}\0${selector.participant_id}`;
    if (keys.has(key))
      throw new CapabilityRuntimeError(
        "conversation capability target selectors are duplicated",
        "invalid-plan",
      );
    keys.add(key);
  }
}

export function materializeConversationCapabilityAction(
  candidate: BrowserCapabilityActionV1,
  conversation: CapabilityConversationProposalBaseV1,
): CapabilityHostActionV1 {
  assertConversationCapabilityTargets(candidate, conversation);
  const selectors = targetSelectors(candidate);
  if (selectors === null) return directAction(candidate);
  const requestedTargets = [...selectors].sort(
    (left, right) =>
      left.engine.localeCompare(right.engine) ||
      (left.participant_id ?? "").localeCompare(right.participant_id ?? ""),
  );
  return directAction({
    ...structuredClone(candidate),
    requested_targets: requestedTargets,
  } as BrowserHostActionRequestV1);
}
