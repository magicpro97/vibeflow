import type { InternalResumeBinding } from "../../dispatch/session-types.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import type { RegisteredOperation } from "./operation-registry.js";
import type { ConversationTurnDeliveryReceiptV1 } from "./turn-delivery-types.js";

export function publishAttemptResumeBinding(input: {
  live: AttemptConversationAuthority;
  operation: RegisteredOperation;
  store: ConversationArtifactStore;
  participantId: string;
  attemptId: string;
  resumeOrdinal: number;
  captured: InternalResumeBinding | undefined;
  isolatedHistory: boolean;
  retained: boolean;
  delivery?: ConversationTurnDeliveryReceiptV1;
}): void {
  const captured = input.captured;
  if (!captured || input.isolatedHistory || !input.operation.isLive() || !input.retained) return;
  if (captured.attemptId !== input.attemptId) throw new Error("resume attempt identity mismatch");
  if (input.resumeOrdinal <= (input.live.resumeOrdinals.get(input.participantId) ?? -1)) return;
  input.store.recordResumeBinding(input.live.manifest.conversation_id, input.participantId, {
    ...captured,
    ...(input.delivery
      ? {
          delivery_public_seq: input.delivery.through_public_seq,
          delivery_digest: input.delivery.envelope_digest,
          ...(input.delivery.interaction_head_digest
            ? {
                delivery_interaction_sequence: input.delivery.through_interaction_sequence,
                delivery_interaction_digest: input.delivery.interaction_head_digest,
              }
            : {}),
        }
      : {}),
  });
  input.live.resumeBindings.set(input.participantId, {
    participant_id: input.participantId,
    ...captured,
    ...(input.delivery
      ? {
          delivery_public_seq: input.delivery.through_public_seq,
          delivery_digest: input.delivery.envelope_digest,
          ...(input.delivery.interaction_head_digest
            ? {
                delivery_interaction_sequence: input.delivery.through_interaction_sequence,
                delivery_interaction_digest: input.delivery.interaction_head_digest,
              }
            : {}),
        }
      : {}),
  });
  input.live.resumeOrdinals.set(input.participantId, input.resumeOrdinal);
}
