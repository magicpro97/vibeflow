import { readCapabilityDispatchBlock } from "./conversation-capability-dispatch-block.js";
import {
  ConversationCapabilityDispatchBusyError,
  readConversationCapabilityDispatchReservation,
} from "./conversation-capability-dispatch-reservation-records.js";
import {
  ConversationLineageMutationBusyError,
  readConversationLineageMutationReservation,
} from "./conversation-lineage-mutation-reservation-records.js";

export function assertNoCapabilityDispatchAuthority(
  artifactRoot: string,
  rootSessionId: string,
): void {
  const block = readCapabilityDispatchBlock(artifactRoot, rootSessionId);
  if (block)
    throw new ConversationCapabilityDispatchBusyError(
      `conversation lineage is blocked by corrupt capability dispatch ${block.proposal_id}`,
    );
  const current = readConversationCapabilityDispatchReservation(artifactRoot, rootSessionId);
  if (current?.status === "active")
    throw new ConversationCapabilityDispatchBusyError(
      "conversation lineage has an active capability dispatch",
    );
}

export function assertNoLineageMutationAuthority(
  artifactRoot: string,
  rootSessionId: string,
): void {
  const current = readConversationLineageMutationReservation(artifactRoot, rootSessionId);
  if (current?.status === "active")
    throw new ConversationLineageMutationBusyError(
      "conversation lineage has an active same-revision mutation",
    );
}

export function assertConversationLineageWritable(
  artifactRoot: string,
  rootSessionId: string,
): void {
  assertNoCapabilityDispatchAuthority(artifactRoot, rootSessionId);
  assertNoLineageMutationAuthority(artifactRoot, rootSessionId);
}
