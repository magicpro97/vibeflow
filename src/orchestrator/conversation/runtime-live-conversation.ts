import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { ConversationArtifactStore, PersistedResumeBinding } from "./artifact-store.js";
import { snapshotMaterializedBindings } from "./emission-authority.js";
import type { LiveConversation } from "./lifecycle-gate.js";
import type { ConversationManifest } from "./types.js";

interface RuntimeLiveConversationRequest {
  artifactStore: ConversationArtifactStore;
  manifest: ConversationManifest;
  bindings: MaterializedAgentBinding[];
  resumes: readonly PersistedResumeBinding[];
  operationId: string;
  sharedHandoff: string | null;
  transitionEpoch: number;
}

/** Captures all mutable per-process authority needed to run one durable conversation. */
export function createRuntimeLiveConversation({
  artifactStore,
  manifest,
  bindings,
  resumes,
  operationId,
  sharedHandoff,
  transitionEpoch,
}: RuntimeLiveConversationRequest): LiveConversation {
  return {
    manifest,
    bindings: snapshotMaterializedBindings(bindings),
    operationId,
    sharedHandoff,
    resumeBindings: new Map(resumes.map((resume) => [resume.participant_id, resume])),
    turnDeliveries: new Map(
      artifactStore
        .readTurnDeliveries(manifest.conversation_id)
        .map((delivery) => [delivery.participant_id, delivery]),
    ),
    turnObservations: new Map(
      artifactStore
        .readTurnDeliveries(manifest.conversation_id)
        .map((delivery) => [delivery.participant_id, delivery.through_public_seq]),
    ),
    resumeOrdinals: new Map(),
    resumeCounter: { value: 0 },
    transitionEpoch,
    needsReconcile: false,
  };
}
