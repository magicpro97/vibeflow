import { defineStore } from "pinia";
import { computed, onScopeDispose, reactive, ref, shallowRef } from "vue";
import { createHomeActionMutationRuntime } from "./conversation-home-action-runtime.js";
import { createHomeCommandRuntime } from "./conversation-home-command-runtime.js";
import { createHomeQueryRuntime } from "./conversation-home-query-runtime.js";
import { ActivationEpoch } from "./conversation-home-state.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomeCapabilityItem,
  HomeConversationStreamStatus,
  HomePagingState,
  HomePendingChallenge,
  HomePrivateFileRangeBinding,
  HomeQuoteReference,
  HomeSessionSummary,
  HomeTimelineResponse,
} from "./conversation-home-types.js";

function browserOnline(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("navigator" in value)) return true;
  const navigator = value.navigator;
  return typeof navigator === "object" && navigator !== null && "onLine" in navigator
    ? navigator.onLine !== false
    : true;
}

export const useConversationHomeStore = defineStore("conversation-home", () => {
  const sessions = ref<HomeSessionSummary[]>([]);
  const sessionQuery = ref("");
  const catalogHealth = ref<"ready" | "rebuilding" | "degraded">("ready");
  const catalogLoading = ref(true);
  const catalogError = ref("");
  const activeRootId = ref<string | null>(null);
  const selectedSession = shallowRef<HomeSessionSummary | null>(null);
  const authoritativeHead = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
  const timeline = shallowRef<HomeTimelineResponse | null>(null);
  const pendingActions = ref<HomeActionView[]>([]);
  const activationLoading = ref(false);
  const activationError = ref("");
  const online = ref(browserOnline(globalThis));
  const railCollapsed = ref(false);
  const draft = ref("");
  const composerError = ref("");
  const submitting = ref(false);
  const submittingToken = ref<string | null>(null);
  const privateFileRange = ref<HomePrivateFileRangeBinding | null>(null);
  const capabilities = ref<HomeCapabilityItem[]>([]);
  const capabilityQuery = ref("");
  const capabilityScope = ref<"project" | "user">("project");
  const capabilityLoading = ref(false);
  const capabilityError = ref("");
  const quoteRefs = ref<HomeQuoteReference[]>([]);
  const composerEpoch = ref(0);
  const reactionBusy = ref<Record<string, boolean>>({});
  const reactionBusyTokens = ref<Record<string, string>>({});
  const challenges = ref<Record<string, HomePendingChallenge>>({});
  const actionBusy = ref<Record<string, boolean>>({});
  const actionBusyTokens = ref<Record<string, string>>({});
  const streamStatus = ref<HomeConversationStreamStatus>("idle");
  const streamError = ref("");
  const paging: HomePagingState = reactive({
    catalog: { nextCursor: null, loadingMore: false },
    timeline: { nextCursor: null, loadingMore: false },
    pending: { nextCursor: null, loadingMore: false },
    capability: { nextCursor: null, loadingMore: false },
  });
  const commandAuthority = new ActivationEpoch();
  const readEpoch = new ActivationEpoch();

  const activeSession = computed(
    () =>
      (selectedSession.value?.root_session_id === activeRootId.value
        ? selectedSession.value
        : null) ??
      sessions.value.find((item) => item.root_session_id === activeRootId.value) ??
      null,
  );
  const activeRevision = computed(() =>
    authoritativeHead.value?.root_session_id === activeRootId.value &&
    authoritativeHead.value.head_status === "committed"
      ? authoritativeHead.value.active
      : null,
  );
  const selectedConversationId = computed(() => activeRevision.value?.conversation_id ?? null);
  const hasSessions = computed(() => sessions.value.length > 0);
  const clearCommandActivity = () => {
    submitting.value = false;
    submittingToken.value = null;
    reactionBusy.value = {};
    reactionBusyTokens.value = {};
    actionBusy.value = {};
    actionBusyTokens.value = {};
    challenges.value = {};
  };
  const clearComposerContext = () => {
    composerEpoch.value += 1;
    quoteRefs.value = [];
    privateFileRange.value = null;
  };
  const queryRuntime = createHomeQueryRuntime({
    sessions,
    sessionQuery,
    catalogHealth,
    catalogLoading,
    catalogError,
    activeRootId,
    selectedSession,
    authoritativeHead,
    timeline,
    pendingActions,
    activationLoading,
    activationError,
    online,
    capabilities,
    capabilityQuery,
    capabilityScope,
    capabilityLoading,
    capabilityError,
    streamStatus,
    streamError,
    paging,
    activeRevision,
    selectedConversationId,
    readEpoch,
    commandAuthority,
  });
  const commandRuntime = createHomeCommandRuntime({
    activation: commandAuthority,
    activeRevision,
    activeRootId,
    selectedConversationId,
    draft,
    online,
    submitting,
    submittingToken,
    privateFileRange,
    composerError,
    activationError,
    quoteRefs,
    reactionBusy,
    reactionBusyTokens,
    pendingActions,
    timeline,
    refreshSessions: queryRuntime.refreshSessions,
    refreshActiveSelection: queryRuntime.refreshActiveSelection,
    refreshAuthoritativeActiveHead: queryRuntime.adoptAuthoritativeActiveHead,
    selectSession: queryRuntime.selectSession,
    sessions,
    sessionQuery,
  });
  const actionRuntime = createHomeActionMutationRuntime({
    activation: commandAuthority,
    activeRootId,
    selectedConversationId,
    online,
    pendingActions,
    activationError,
    challenges,
    actionBusy,
    actionBusyTokens,
  });

  function newConversation(): void {
    clearCommandActivity();
    clearComposerContext();
    commandAuthority.close();
    readEpoch.close();
    activeRootId.value = null;
    selectedSession.value = null;
    authoritativeHead.value = null;
    timeline.value = null;
    pendingActions.value = [];
    activationError.value = "";
    composerError.value = "";
    reactionBusy.value = {};
    streamStatus.value = "idle";
    streamError.value = "";
  }

  onScopeDispose(() => {
    commandAuthority.close();
    queryRuntime.dispose();
  });

  return {
    sessions,
    sessionQuery,
    catalogHealth,
    catalogLoading,
    catalogError,
    activeRootId,
    activeSession,
    activeRevision,
    selectedConversationId,
    hasSessions,
    timeline,
    pendingActions,
    activationLoading,
    activationError,
    online,
    railCollapsed,
    draft,
    privateFileRange,
    composerError,
    submitting,
    capabilities,
    capabilityQuery,
    capabilityScope,
    capabilityLoading,
    capabilityError,
    quoteRefs,
    composerEpoch,
    reactionBusy,
    challenges,
    actionBusy,
    streamStatus,
    streamError,
    paging,
    refreshSessions: queryRuntime.refreshSessions,
    loadMoreSessions: queryRuntime.loadMoreSessions,
    async selectSession(rootSessionId: string) {
      if (activeRootId.value !== rootSessionId) {
        clearCommandActivity();
        clearComposerContext();
        composerError.value = "";
        activationError.value = "";
      }
      await queryRuntime.selectSession(rootSessionId);
    },
    loadMoreTimeline: queryRuntime.loadMoreTimeline,
    loadMorePendingActions: queryRuntime.loadMorePendingActions,
    searchCapabilities: queryRuntime.searchCapabilities,
    loadMoreCapabilities: queryRuntime.loadMoreCapabilities,
    proposeCandidate: commandRuntime.proposeCandidate,
    proposeSettings: commandRuntime.proposeSettings,
    proposeCapabilityRepair: commandRuntime.proposeCapabilityRepair,
    toggleQuoteReference: commandRuntime.toggleQuoteReference,
    removeQuoteReference: commandRuntime.removeQuoteReference,
    moveQuoteReference: commandRuntime.moveQuoteReference,
    toggleReaction: commandRuntime.toggleReaction,
    setPrivateFileRange(binding: HomePrivateFileRangeBinding) {
      privateFileRange.value = structuredClone(binding);
      composerError.value = "";
    },
    clearPrivateFileRange() {
      privateFileRange.value = null;
    },
    reportUnavailableInteraction: commandRuntime.reportUnavailableInteraction,
    setOnline(value: boolean) {
      online.value = value;
      if (!value) {
        clearCommandActivity();
        commandAuthority.close();
        readEpoch.close();
      } else if (activeRootId.value) void queryRuntime.selectSession(activeRootId.value);
    },
    newConversation,
    submitDraft: commandRuntime.submitDraft,
    mutateAction: actionRuntime.mutateAction,
    requestChallenge: actionRuntime.requestChallenge,
  };
});
