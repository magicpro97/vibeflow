import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { PersistedResumeBinding } from "./artifact-store.js";
import type { AttemptConversationAuthority } from "./attempt-runtime.js";
import type { TerminalLifecycle } from "./types.js";

export class ConversationAuthorityClosedError extends Error {
  override readonly name = "ConversationAuthorityClosedError";
}

export interface LiveConversation extends AttemptConversationAuthority {
  bindings: MaterializedAgentBinding[];
  resumeBindings: Map<string, PersistedResumeBinding>;
  transitionEpoch: number;
  needsReconcile: boolean;
}

export interface EmissionGateEntry {
  operationId: string;
  state:
    | "open"
    | "pausing"
    | "paused"
    | "resuming"
    | "cancelling"
    | "cancelled"
    | "closing"
    | "closed";
  terminal: TerminalLifecycle | null;
  terminalPrevious?: "open" | "paused" | "cancelled";
  cancellationPrevious?: "open" | "paused";
  terminalPending?: Promise<void>;
  pending?: Promise<void>;
  waiters: Set<{ resolve(): void; reject(error: Error): void }>;
}
