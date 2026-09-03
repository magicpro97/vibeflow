import type { MaterializedAgentBinding } from "../../agents/binding.js";
import type { EngineSessionAdapter } from "../../dispatch/session-types.js";
import type { ArtifactRegistry } from "../trace/artifacts.js";
import type { TraceStore } from "../trace/store.js";
import type { PublicStoredTraceEvent } from "../trace/types.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import type { ConversationAgentActionCandidateAuthorityV1 } from "./conversation-agent-action-candidate-authority.js";
import type { ConversationDelegationWorkspaceAuthorityV1 } from "./conversation-delegation-workspace.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { ConversationPrivateContextBrokerV1 } from "./conversation-private-context-broker-store.js";
import type { ConversationSocialAuthorityV1 } from "./conversation-social-authority.js";
import type { ConversationUserMessageAuthorityV1 } from "./conversation-user-message-authority.js";
import type {
  ConversationPolicyRegistry,
  RuntimeCreateRequest,
  RuntimePreviewRequest,
} from "./policy-registry.js";
import type { RevisionCrashPointV1 } from "./revision-crash-fault.js";
import type {
  ConversationBinding,
  ConversationCreateRequest,
  ConversationManifest,
} from "./types.js";

export interface ConversationRuntimeOptions {
  traceStore: TraceStore;
  artifactRegistry: ArtifactRegistry;
  artifactStore: ConversationArtifactStore;
  sessionAdapter: EngineSessionAdapter;
  policies: ConversationPolicyRegistry;
  id?: (kind: string) => string;
  now?: () => string;
  schedule?(task: () => void): void;
  onConversationSourceCommitted?(event: PublicStoredTraceEvent): void;
  artifactRoot?: string;
  traceRoot?: string;
  homeAuthorities?: ConversationHomeAuthorities;
  socialAuthority?: ConversationSocialAuthorityV1;
  agentActionCandidates?: ConversationAgentActionCandidateAuthorityV1;
  coordinationWorkspaces?: ConversationDelegationWorkspaceAuthorityV1;
  privateContextBroker?: ConversationPrivateContextBrokerV1;
  messageQueueUserAuthority?: ConversationUserMessageAuthorityV1;
  /** Test/process-crash seam; throwing leaves durable authority for restart recovery. */
  revisionFault?(point: RevisionCrashPointV1): void;
  resolveCreateRequest?(request: ConversationCreateRequest): Promise<RuntimeCreateRequest>;
  resolveDryRunRequest?(request: ConversationCreateRequest): Promise<RuntimePreviewRequest>;
  rehydrateBinding(
    binding: ConversationBinding,
    manifest: ConversationManifest,
  ): Promise<MaterializedAgentBinding>;
}
