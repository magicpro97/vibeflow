import type {
  AgentBinding,
  MaterializedAgentBinding,
  PreviewAgentBinding,
} from "../../agents/binding.js";
import type { PrivateFileRangeHandoffBindingV1 } from "./private-file-range-staging-store.js";
import type { ConversationHostToolV1 } from "./types.js";

export interface RuntimeBinding {
  participantId: string;
  input: AgentBinding;
  materialized: MaterializedAgentBinding;
  hostTools?: ConversationHostToolV1[];
}

export interface RuntimeCreateRequest {
  topic: string;
  policy: string;
  maxRounds: number;
  baselineEnabled?: boolean;
  evaluatorAutoAdded?: boolean;
  repoRoot: string;
  phase: number;
  bindings: RuntimeBinding[];
  parent?: { conversationId: string; revisionId: string };
  private_file_range?: PrivateFileRangeHandoffBindingV1;
}

export interface RuntimePreviewRequest extends Omit<RuntimeCreateRequest, "bindings" | "parent"> {
  bindings: Array<{
    participantId: string;
    input: AgentBinding;
    preview: PreviewAgentBinding;
    hostTools?: ConversationHostToolV1[];
  }>;
}
