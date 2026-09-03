import type { ConversationArtifactStore } from "./artifact-store.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import type { RegisteredOperation } from "./operation-registry.js";
import type { ConversationTurnDeliveryReceiptV1 } from "./turn-delivery-types.js";

export function publishAttemptTurnDelivery(input: {
  live: AttemptConversationAuthority;
  operation: RegisteredOperation;
  store: ConversationArtifactStore;
  participantId: string;
  attemptId: string;
  delivery: ConversationTurnDeliveryReceiptV1 | undefined;
  capturedResume: boolean;
  retained: boolean;
}): void {
  if (!input.delivery || !input.operation.isLive() || !input.retained) return;
  const binding = {
    participant_id: input.participantId,
    attempt_id: input.attemptId,
    through_public_seq: input.delivery.through_public_seq,
    envelope_digest: input.delivery.envelope_digest,
    ...(input.delivery.interaction_head_digest
      ? {
          interaction_sequence: input.delivery.through_interaction_sequence,
          interaction_head_digest: input.delivery.interaction_head_digest,
        }
      : {}),
  };
  input.live.turnObservations.set(input.participantId, binding.through_public_seq);
  if (!input.capturedResume) return;
  input.store.recordTurnDeliveries(input.live.manifest.conversation_id, [binding]);
  input.live.turnDeliveries.set(input.participantId, binding);
}
