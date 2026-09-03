import type { EngineSessionAdapter } from "../../dispatch/session-types.js";
import type { PolicyEmission, StoredTraceEvent, TraceCorrelation } from "../trace/types.js";
import type { ConversationArtifactStore } from "./artifact-store.js";
import type { InitialRevisionLaneAuthority } from "./revision-initial-lane-authority.js";
import type { ConversationManifest } from "./types.js";

export interface AttemptRuntimeOptions {
  id(kind: string): string;
  sessionAdapter: EngineSessionAdapter;
  artifactStore: ConversationArtifactStore;
  correlation(manifest: ConversationManifest, operationId: string, id: string): TraceCorrelation;
  append(
    correlation: Readonly<TraceCorrelation>,
    emission: PolicyEmission,
    nativeSessionId?: string | null,
  ): Promise<StoredTraceEvent>;
  appendLifecycle(
    correlation: Readonly<TraceCorrelation>,
    emission: PolicyEmission,
    nativeSessionId?: string | null,
  ): Promise<void>;
  appendRuntime(
    correlation: Readonly<TraceCorrelation>,
    emission: PolicyEmission,
    nativeSessionId?: string | null,
  ): Promise<StoredTraceEvent>;
  isOpen(conversationId: string, operationId: string): boolean;
  isRetained(conversationId: string, operationId: string): boolean;
  awaitOpen(conversationId: string, operationId: string): Promise<void>;
  revisionLanes?: InitialRevisionLaneAuthority;
}
