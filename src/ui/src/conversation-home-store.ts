import { defineStore } from "pinia";
import { computed, onScopeDispose, reactive, ref, shallowRef, watch } from "vue";
import { CAPABILITY_SCOPE, type CapabilityScope } from "../../core/capability-contract.js";
import {
  CONVERSATION_CATALOG_HEALTH,
  CONVERSATION_HEAD_STATUS,
  type ConversationCatalogHealth,
} from "../../orchestrator/conversation/conversation-catalog-contract.js";
import { CONVERSATION_CLIENT_STREAM_STATE } from "../../orchestrator/conversation/conversation-sse-contract.js";
import { createHomeActionMutationRuntime } from "./conversation-home-action-runtime.js";
import { createHomeCommandRuntime } from "./conversation-home-command-runtime.js";
import {
  createHomeQueueRecoveryRuntime,
  hasHomeLiveQueueItems,
} from "./conversation-home-message-queue-authority.js";
import { createHomeMessageQueueRuntime } from "./conversation-home-message-queue-runtime.js";
import type {
  HomeMessageQueueSnapshot,
  HomeNeedsActionQueuedMessage,
  HomeOptimisticQueuedMessage,
  HomeQueueRecoveryBusyKind,
  HomeQueuedMessageEditBinding,
  HomeRetryableQueuedMessage,
} from "./conversation-home-message-queue-types.js";
import { createHomePrivateContextRuntime } from "./conversation-home-private-context-runtime.js";
import { createHomeQueryRuntime } from "./conversation-home-query-runtime.js";
import {
  homeCapabilityAuthoritySignature,
  isHomeBrowserOnline,
} from "./conversation-home-runtime.js";
import { ActivationEpoch } from "./conversation-home-state.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomeCapabilityItem,
  HomeConversationStreamStatus,
  HomePagingState,
  HomePendingChallenge,
  HomeQuoteReference,
  HomeSessionSummary,
  HomeTimelineResponse,
} from "./conversation-home-types.js";

export const useConversationHomeStore = defineStore("conversation-home", () => {
  const sessions = ref<HomeSessionSummary[]>([]);
  const sessionQuery = ref("");
  const catalogHealth = ref<ConversationCatalogHealth>(CONVERSATION_CATALOG_HEALTH.READY);
  const catalogLoading = ref(true);
  const catalogError = ref("");
  const activeRootId = ref<string | null>(null);
  const selectedSession = shallowRef<HomeSessionSummary | null>(null);
  const authoritativeHead = shallowRef<HomeAuthoritativeHeadResponse | null>(null);
  const timeline = shallowRef<HomeTimelineResponse | null>(null);
  const pendingActions = ref<HomeActionView[]>([]);
  const activationLoading = ref(false);
  const activationError = ref("");
  const online = ref(isHomeBrowserOnline(globalThis));
  const railCollapsed = ref(false);
  const draft = ref("");
  const composerError = ref("");
  const submitting = ref(false);
  const submittingToken = ref<string | null>(null);
  const messageQueue = shallowRef<HomeMessageQueueSnapshot | null>(null);
  const optimisticMessages = ref<HomeOptimisticQueuedMessage[]>([]);
  const retryableMessages = ref<HomeRetryableQueuedMessage[]>([]);
  const needsActionMessages = ref<HomeNeedsActionQueuedMessage[]>([]);
  const queuedMessageEdit = shallowRef<HomeQueuedMessageEditBinding | null>(null);
  const queuedMessageEditSaving = ref(false);
  const queueSendAsNew = ref(false);
  const queueAnnouncement = ref("");
  const queueComposerFocusEpoch = ref(0);
  const queueRecoveryBusyKey = ref<string | null>(null);
  const queueRecoveryBusyKind = ref<HomeQueueRecoveryBusyKind | null>(null);
  const privateContextPresent = ref(false);
  const privateContextDiscarding = ref(false);
  const capabilities = ref<HomeCapabilityItem[]>([]);
  const capabilityQuery = ref("");
  const capabilityScope = ref<CapabilityScope>(CAPABILITY_SCOPE.PROJECT);
  const capabilityLoading = ref(false);
  const capabilityError = ref("");
  const quoteRefs = ref<HomeQuoteReference[]>([]);
  const composerEpoch = ref(0);
  const reactionBusy = ref<Record<string, boolean>>({});
  const reactionBusyTokens = ref<Record<string, string>>({});
  const challenges = ref<Record<string, HomePendingChallenge>>({});
  const actionBusy = ref<Record<string, boolean>>({});
  const actionBusyTokens = ref<Record<string, string>>({});
  const streamStatus = ref<HomeConversationStreamStatus>(CONVERSATION_CLIENT_STREAM_STATE.IDLE);
  const streamError = ref("");
  const paging: HomePagingState = reactive({
    catalog: { nextCursor: null, loadingMore: false },
    timeline: { nextCursor: null, loadingMore: false },
    pending: { nextCursor: null, loadingMore: false },
    capability: { nextCursor: null, loadingMore: false },
  });
  const commandAuthority = new ActivationEpoch();
  const readEpoch = new ActivationEpoch();
  let refreshMessageQueue = async (): Promise<boolean> => false;

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
    authoritativeHead.value.head_status === CONVERSATION_HEAD_STATUS.COMMITTED
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
    commandRuntime.clearCapabilityTargetSelection();
  };
  const privateContextRuntime = createHomePrivateContextRuntime({
    activeRootId,
    online,
    present: privateContextPresent,
    discardBusy: privateContextDiscarding,
    composerError,
    announcement: queueAnnouncement,
    composerFocusEpoch: queueComposerFocusEpoch,
  });
  const messageQueueRuntime = createHomeMessageQueueRuntime({
    activation: commandAuthority,
    activeRootId,
    online,
    draft,
    composerError,
    snapshot: messageQueue,
    optimistic: optimisticMessages,
    retryable: retryableMessages,
    needsAction: needsActionMessages,
    edit: queuedMessageEdit,
    editSaving: queuedMessageEditSaving,
    sendAsNew: queueSendAsNew,
    announcement: queueAnnouncement,
    composerFocusEpoch: queueComposerFocusEpoch,
    refreshQueue: () => refreshMessageQueue(),
  });
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
    adoptMessageQueueSnapshot: messageQueueRuntime.adoptSnapshot,
    clearMessageQueueProjection() {
      messageQueue.value = null;
      optimisticMessages.value = [];
    },
    messageQueueHasLiveItems: () =>
      hasHomeLiveQueueItems(messageQueue.value, optimisticMessages.value.length),
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
  refreshMessageQueue = queryRuntime.refreshMessageQueue;
  const commandRuntime = createHomeCommandRuntime({
    activation: commandAuthority,
    activeRevision,
    activeRootId,
    selectedConversationId,
    draft,
    online,
    submitting,
    submittingToken,
    privateContext: {
      present: () => privateContextPresent.value,
      captureForMessage: privateContextRuntime.captureForMessage,
      captureForCreate: privateContextRuntime.captureForCreate,
    },
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
    messageQueue: {
      enqueue: messageQueueRuntime.enqueue,
      currentEdit: () => queuedMessageEdit.value,
      saveEdit: messageQueueRuntime.saveEdit,
    },
  });
  const capabilityAuthoritySignature = computed(() =>
    homeCapabilityAuthoritySignature(activeRootId.value, activeRevision.value),
  );
  watch(capabilityAuthoritySignature, () => commandRuntime.reconcileCapabilityTargetSelection(), {
    flush: "sync",
  });
  watch(draft, () => commandRuntime.reconcileCapabilityTargetDraft(), { flush: "sync" });
  watch(
    activeRootId,
    (nextRootId, previousRootId) => {
      messageQueueRuntime.switchRoot(previousRootId, nextRootId);
      privateContextRuntime.switchRoot();
    },
    { flush: "sync" },
  );
  watch(
    () => hasHomeLiveQueueItems(messageQueue.value, optimisticMessages.value.length),
    () => queryRuntime.reconcileActiveStream(),
    { flush: "sync" },
  );
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
    reconcileOperation: queryRuntime.reconcileActionOperation,
  });
  const queueRecoveryRuntime = createHomeQueueRecoveryRuntime({
    activeRootId,
    online,
    activationError,
    messageQueue,
    needsAction: needsActionMessages,
    announcement: queueAnnouncement,
    busyKey: queueRecoveryBusyKey,
    busyKind: queueRecoveryBusyKind,
    isComposerVacant: () =>
      draft.value === "" &&
      quoteRefs.value.length === 0 &&
      !privateContextPresent.value &&
      !queuedMessageEdit.value &&
      !submitting.value,
    selectSession: queryRuntime.selectSession,
    restore: messageQueueRuntime.restoreNeedsAction,
    dismiss: messageQueueRuntime.dismissNeedsAction,
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
    streamStatus.value = CONVERSATION_CLIENT_STREAM_STATE.IDLE;
    streamError.value = "";
  }

  onScopeDispose(() => {
    commandAuthority.close();
    messageQueueRuntime.dispose();
    privateContextRuntime.dispose();
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
    privateContextPresent,
    privateContextDiscarding,
    composerError,
    submitting,
    messageQueue,
    queuedMessages: messageQueueRuntime.projections,
    queuedMessageEdit,
    queuedMessageEditSaving,
    queueSendAsNew,
    queueAnnouncement,
    queueComposerFocusEpoch,
    queueRecoveryComposerVacant: queueRecoveryRuntime.composerVacant,
    queueRecoveryBusyKey,
    queueRecoveryBusyKind,
    capabilityTargetRequest: commandRuntime.capabilityTargetRequest,
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
    stagePrivateContext: privateContextRuntime.stage,
    discardPrivateContext: privateContextRuntime.discardCurrent,
    reportUnavailableInteraction: commandRuntime.reportUnavailableInteraction,
    toggleCapabilityTarget: commandRuntime.toggleCapabilityTarget,
    toggleAllCapabilityTargets: commandRuntime.toggleAllCapabilityTargets,
    cancelCapabilityTargetSelection: commandRuntime.cancelCapabilityTargetSelection,
    confirmCapabilityTargets: commandRuntime.confirmCapabilityTargets,
    beginQueuedMessageEdit(queueItemId?: string) {
      if (quoteRefs.value.length || privateContextPresent.value) return false;
      return messageQueueRuntime.beginEdit(queueItemId);
    },
    cancelQueuedMessageEdit: messageQueueRuntime.cancelEdit,
    retryQueuedMessage: messageQueueRuntime.retry,
    recoverFailedQueuedMessage: queueRecoveryRuntime.recover,
    dismissFailedQueuedMessage: queueRecoveryRuntime.dismiss,
    setOnline(value: boolean) {
      online.value = value;
      if (!value) {
        messageQueueRuntime.goOffline();
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
