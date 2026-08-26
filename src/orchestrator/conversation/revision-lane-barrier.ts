import type { ConversationArtifactStore } from "./artifact-store.js";
import type { AttemptConversationAuthority } from "./attempt-runtime-types.js";
import { ContextHandoffStore } from "./handoff-store.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import {
  type RevisionHandoffInteractionCursorV1,
  revisionHandoffInteractionCursor,
} from "./revision-handoff-cursor.js";
import type { RevisionLaneEvidenceStore } from "./revision-lane-evidence-store.js";
import type { ParticipantStartReceiptV1 } from "./revision-participant-receipt.js";

type RevisionHandoffReader = Pick<ContextHandoffStore, "read">;

function receiptEvidence(receipt: ParticipantStartReceiptV1) {
  const ref = receipt.private_native_session_ref ?? receipt.private_process_lease_ref;
  const digest =
    receipt.private_native_session_producer_receipt_digest ??
    receipt.private_process_lease_producer_receipt_digest;
  return ref && digest ? { ref, digest } : null;
}

function handoffInteractionCursor(input: {
  operation: RevisionOperationV1;
  artifacts: ConversationArtifactStore;
  handoffs?: RevisionHandoffReader;
}): RevisionHandoffInteractionCursorV1 | null {
  try {
    const handoffs =
      input.handoffs ?? new ContextHandoffStore({ artifactRoot: input.artifacts.rootPath() });
    const handoff = handoffs.read(input.operation.handoff_digest);
    if (
      !handoff ||
      handoff.digest !== input.operation.handoff_digest ||
      handoff.handoff_id !== input.operation.handoff_id
    )
      return null;
    return revisionHandoffInteractionCursor({
      handoff,
      root_session_id: input.operation.root_session_id,
      prompt_projection_digest: input.operation.prompt_projection_digest,
    });
  } catch {
    return null;
  }
}

export function publishRevisionLaneResume(input: {
  operation: RevisionOperationV1;
  receipt: ParticipantStartReceiptV1;
  evidence: RevisionLaneEvidenceStore;
  artifacts: ConversationArtifactStore;
  handoffs?: RevisionHandoffReader;
}): void {
  const binding = receiptEvidence(input.receipt);
  if (!binding) return;
  const evidence = input.evidence.read(binding.ref, binding.digest);
  if (!evidence?.native_session_id) return;
  const interaction = handoffInteractionCursor(input);
  input.artifacts.recordResumeBinding(
    input.operation.child.conversation_id,
    input.receipt.participant_id,
    {
      attemptId: input.receipt.attempt_key,
      engine: input.receipt.engine,
      nativeSessionId: evidence.native_session_id,
      delivery_public_seq: 0,
      delivery_digest: input.operation.prompt_projection_digest,
      ...(interaction
        ? {
            delivery_interaction_sequence: interaction.interaction_sequence,
            delivery_interaction_digest: interaction.interaction_head_digest,
          }
        : {}),
    },
  );
  input.artifacts.recordTurnDeliveries(input.operation.child.conversation_id, [
    {
      participant_id: input.receipt.participant_id,
      attempt_id: input.receipt.attempt_key,
      through_public_seq: 0,
      envelope_digest: input.operation.prompt_projection_digest,
      ...(interaction
        ? {
            interaction_sequence: interaction.interaction_sequence,
            interaction_head_digest: interaction.interaction_head_digest,
          }
        : {}),
    },
  ]);
}

export function publishAcceptedRevisionLaneBarrier(input: {
  operation: RevisionOperationV1;
  plan: RevisionPreparationPlanV1;
  lanes: ReadonlyMap<string, ParticipantStartReceiptV1>;
  evidence: RevisionLaneEvidenceStore;
  artifacts: ConversationArtifactStore;
  live: AttemptConversationAuthority;
  handoffs?: RevisionHandoffReader;
}): boolean {
  if (
    input.lanes.size !== input.plan.participant_starts.length ||
    input.plan.participant_starts.some(
      ({ participant_id }) => input.lanes.get(participant_id)?.state !== "accepted",
    )
  )
    return false;
  const interaction = handoffInteractionCursor(input);
  const bindings = input.plan.participant_starts.flatMap(({ participant_id }) => {
    const receipt = input.lanes.get(participant_id);
    if (!receipt) throw new Error("revision barrier lane disappeared");
    const reference = receiptEvidence(receipt);
    if (!reference) throw new Error("accepted revision lane lacks private evidence");
    const evidence = input.evidence.read(reference.ref, reference.digest);
    if (
      !evidence ||
      evidence.operation_id !== input.operation.operation_id ||
      evidence.participant_id !== participant_id ||
      evidence.start_generation !== receipt.start_generation ||
      evidence.attempt_key !== receipt.attempt_key
    )
      throw new Error("accepted revision lane evidence changed");
    return evidence.native_session_id
      ? [
          {
            participant_id,
            attemptId: receipt.attempt_key,
            engine: receipt.engine,
            nativeSessionId: evidence.native_session_id,
            delivery_public_seq: 0,
            delivery_digest: input.operation.prompt_projection_digest,
            ...(interaction
              ? {
                  delivery_interaction_sequence: interaction.interaction_sequence,
                  delivery_interaction_digest: interaction.interaction_head_digest,
                }
              : {}),
          },
        ]
      : [];
  });
  input.artifacts.recordResumeBindings(input.operation.child.conversation_id, bindings);
  const deliveries = bindings.map(({ participant_id, attemptId }) => ({
    participant_id,
    attempt_id: attemptId,
    through_public_seq: 0,
    envelope_digest: input.operation.prompt_projection_digest,
    ...(interaction
      ? {
          interaction_sequence: interaction.interaction_sequence,
          interaction_head_digest: interaction.interaction_head_digest,
        }
      : {}),
  }));
  input.artifacts.recordTurnDeliveries(input.operation.child.conversation_id, deliveries);
  const ordinal = input.live.resumeCounter.value;
  for (const binding of bindings) {
    input.live.resumeBindings.set(binding.participant_id, binding);
    input.live.resumeOrdinals.set(binding.participant_id, ordinal);
  }
  for (const delivery of deliveries)
    input.live.turnDeliveries.set(delivery.participant_id, delivery);
  for (const delivery of deliveries)
    input.live.turnObservations.set(delivery.participant_id, delivery.through_public_seq);
  return true;
}
