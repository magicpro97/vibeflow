import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { PersistedResumeBinding } from "./artifact-store.js";
import type { PersistedTurnDeliveryV1 } from "./turn-delivery-types.js";
import type { ConversationManifest } from "./types.js";

export interface AttemptConversationAuthority {
  readonly manifest: ConversationManifest;
  readonly bindings: readonly MaterializedAgentBinding[];
  readonly operationId: string;
  readonly sharedHandoff: string | null;
  readonly resumeBindings: Map<string, PersistedResumeBinding>;
  readonly turnDeliveries: Map<string, PersistedTurnDeliveryV1>;
  readonly turnObservations: Map<string, number>;
  readonly resumeOrdinals: Map<string, number>;
  readonly resumeCounter: { value: number };
}
