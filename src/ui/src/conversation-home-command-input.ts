import type { ComputedRef, Ref } from "vue";
import type { HomeQueueAdmissionSnapshot } from "./conversation-home-message-queue-runtime.js";
import type { HomeQueuedMessageEditBinding } from "./conversation-home-message-queue-types.js";
import type { HomePrivateContextCapture } from "./conversation-home-private-context-types.js";
import type {
  HomeActionView,
  HomeQuoteReference,
  HomeRevisionSummary,
  HomeTimelineResponse,
} from "./conversation-home-types.js";

export interface HomeCommandRuntimeInput {
  activation: {
    captureGeneration(): number;
    isGenerationCurrent(generation: number): boolean;
  };
  activeRevision: ComputedRef<HomeRevisionSummary | null>;
  activeRootId: Ref<string | null>;
  selectedConversationId: ComputedRef<string | null>;
  draft: Ref<string>;
  online: Ref<boolean>;
  submitting: Ref<boolean>;
  submittingToken: Ref<string | null>;
  privateContext: {
    present(): boolean;
    captureForMessage(rootSessionId: string): HomePrivateContextCapture | null;
    captureForCreate(): HomePrivateContextCapture | null;
  };
  composerError: Ref<string>;
  activationError: Ref<string>;
  quoteRefs: Ref<HomeQuoteReference[]>;
  reactionBusy: Ref<Record<string, boolean>>;
  reactionBusyTokens: Ref<Record<string, string>>;
  pendingActions: Ref<HomeActionView[]>;
  timeline: Ref<HomeTimelineResponse | null>;
  refreshSessions(query?: string): Promise<void>;
  refreshActiveSelection(): Promise<boolean>;
  refreshAuthoritativeActiveHead(expectedConversationId: string): Promise<boolean>;
  selectSession(rootSessionId: string): Promise<void>;
  sessions: Ref<Array<{ root_session_id: string; root: { conversation_id: string } }>>;
  sessionQuery: Ref<string>;
  messageQueue: {
    enqueue(admission: HomeQueueAdmissionSnapshot): Promise<boolean>;
    currentEdit(): HomeQueuedMessageEditBinding | null;
    saveEdit(): Promise<boolean>;
  };
}
