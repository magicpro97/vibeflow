import type { ComputedRef, Ref, ShallowRef } from "vue";
import type { CapabilityScope } from "../../core/capability-contract.js";
import type { ConversationCatalogHealth } from "../../orchestrator/conversation/conversation-catalog-contract.js";
import type { ConversationClientStreamState } from "../../orchestrator/conversation/conversation-sse-contract.js";
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
  catalogHealth: Ref<ConversationCatalogHealth>;
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
  streamStatus: Ref<ConversationClientStreamState>;
  streamError: Ref<string>;
  capabilities: Ref<HomeCapabilityItem[]>;
  capabilityQuery: Ref<string>;
  capabilityScope: Ref<CapabilityScope>;
  capabilityLoading: Ref<boolean>;
  capabilityError: Ref<string>;
  paging: HomePagingState;
  activeRevision: ComputedRef<HomeRevisionSummary | null>;
  selectedConversationId: ComputedRef<string | null>;
  readEpoch: ActivationEpoch;
  commandAuthority: ActivationEpoch;
}
