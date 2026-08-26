import type { ComputedRef, Ref, ShallowRef } from "vue";
import type { HomeMessageQueueSnapshot } from "./conversation-home-message-queue-types.js";
import type { ActivationEpoch } from "./conversation-home-state.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomeCapabilityItem,
  HomePagingState,
  HomeRevisionSummary,
  HomeSessionSummary,
  HomeTimelineResponse,
} from "./conversation-home-types.js";

export interface HomeQueryRuntimeInput {
  sessions: Ref<HomeSessionSummary[]>;
  sessionQuery: Ref<string>;
  catalogHealth: Ref<"ready" | "rebuilding" | "degraded">;
  catalogLoading: Ref<boolean>;
  catalogError: Ref<string>;
  activeRootId: Ref<string | null>;
  selectedSession: ShallowRef<HomeSessionSummary | null>;
  authoritativeHead: ShallowRef<HomeAuthoritativeHeadResponse | null>;
  timeline: ShallowRef<HomeTimelineResponse | null>;
  pendingActions: Ref<HomeActionView[]>;
  adoptMessageQueueSnapshot(snapshot: HomeMessageQueueSnapshot, rootSessionId: string): void;
  clearMessageQueueProjection(): void;
  messageQueueHasLiveItems(): boolean;
  activationLoading: Ref<boolean>;
  activationError: Ref<string>;
  online: Ref<boolean>;
  streamStatus: Ref<"idle" | "connecting" | "live" | "reconnecting" | "error">;
  streamError: Ref<string>;
  capabilities: Ref<HomeCapabilityItem[]>;
  capabilityQuery: Ref<string>;
  capabilityScope: Ref<"project" | "user">;
  capabilityLoading: Ref<boolean>;
  capabilityError: Ref<string>;
  paging: HomePagingState;
  activeRevision: ComputedRef<HomeRevisionSummary | null>;
  selectedConversationId: ComputedRef<string | null>;
  readEpoch: ActivationEpoch;
  commandAuthority: ActivationEpoch;
}
