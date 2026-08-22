import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { PersistedResumeBinding } from "./artifact-store.js";
import type { ConversationManifest } from "./types.js";

export interface AttemptConversationAuthority {
  readonly manifest: ConversationManifest;
  readonly bindings: readonly MaterializedAgentBinding[];
  readonly operationId: string;
  readonly resumeBindings: Map<string, PersistedResumeBinding>;
  readonly resumeOrdinals: Map<string, number>;
  readonly resumeCounter: { value: number };
}
