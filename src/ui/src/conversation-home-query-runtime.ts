import type { ComputedRef, Ref, ShallowRef } from "vue";
import { createHomeActivePaginationRuntime } from "./conversation-home-active-pagination.js";
import { conversationHomeApi } from "./conversation-home-api.js";
import { createHomeCapabilityQueryRuntime } from "./conversation-home-capability-query.js";
import { mergeHomePage, staleHomeCursor } from "./conversation-home-pagination.js";
import { refreshHomeActiveSelection } from "./conversation-home-query-active.js";
import { readableHomeError, retainSelectedHomeSession } from "./conversation-home-runtime.js";
import { type ActivationEpoch, ActivationResourceRegistry } from "./conversation-home-state.js";
import {
  appendHomeTimelineTrace,
  homeTimelineCursorForRevision,
  shouldStreamHomeRevision,
  watchHomeConversationStream,
} from "./conversation-home-stream.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomeCapabilityItem,
  HomePagingState,
  HomeRevisionSummary,
  HomeSessionSummary,
  HomeTimelineResponse,
} from "./conversation-home-types.js";

interface HomeQueryRuntimeInput {
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

export function createHomeQueryRuntime(input: HomeQueryRuntimeInput) {
  let catalogController: AbortController | null = null;
  let catalogMoreController: AbortController | null = null;
  let catalogGeneration = 0;
  let activeToken: ReturnType<ActivationEpoch["begin"]> | null = null;
  let activeRefresh: (() => Promise<void>) | null = null;
  let activeDataGeneration = 0;
  const capabilityRuntime = createHomeCapabilityQueryRuntime({
    capabilities: input.capabilities,
    query: input.capabilityQuery,
    scope: input.capabilityScope,
    loading: input.capabilityLoading,
    error: input.capabilityError,
    paging: input.paging.capability,
  });
  const activePagination = createHomeActivePaginationRuntime({
    token: () => activeToken,
    generation: () => activeDataGeneration,
    activeRootId: input.activeRootId,
    selectedConversationId: input.selectedConversationId,
    timeline: input.timeline,
    pendingActions: input.pendingActions,
    paging: input.paging,
    activationError: input.activationError,
    restart: selectSession,
  });

  async function refreshSessions(query = input.sessionQuery.value): Promise<void> {
    const generation = ++catalogGeneration;
    catalogController?.abort();
    catalogMoreController?.abort();
    catalogMoreController = null;
    input.paging.catalog.loadingMore = false;
    input.paging.catalog.nextCursor = null;
    const controller = new AbortController();
    catalogController = controller;
    input.catalogLoading.value = true;
    input.catalogError.value = "";
    try {
      const response = await conversationHomeApi.sessions(
        { query: query.trim() || undefined, limit: 50 },
        controller.signal,
      );
      if (generation !== catalogGeneration || controller.signal.aborted) return;
      input.sessions.value = response.items;
      input.paging.catalog.nextCursor = response.next_cursor;
      input.catalogHealth.value = response.catalog_health;
      input.selectedSession.value = retainSelectedHomeSession(
        response.items,
        input.activeRootId.value,
        input.selectedSession.value,
      );
    } catch (error) {
      if (generation === catalogGeneration) input.catalogError.value = readableHomeError(error);
    } finally {
      if (generation === catalogGeneration) input.catalogLoading.value = false;
    }
  }

  async function loadMoreSessions(): Promise<void> {
    if (!input.paging.catalog.nextCursor || input.paging.catalog.loadingMore) return;
    const generation = catalogGeneration;
    const query = input.sessionQuery.value.trim();
    const cursor = input.paging.catalog.nextCursor;
    input.paging.catalog.loadingMore = true;
    const controller = new AbortController();
    catalogMoreController = controller;
    try {
      const response = await conversationHomeApi.sessions(
        { query: query || undefined, cursor, limit: 50 },
        controller.signal,
      );
      if (
        generation !== catalogGeneration ||
        controller.signal.aborted ||
        input.sessionQuery.value.trim() !== query ||
        input.paging.catalog.nextCursor !== cursor
      )
        return;
      input.sessions.value = mergeHomePage(
        input.sessions.value,
        response.items,
        (item) => item.root_session_id,
      );
      input.paging.catalog.nextCursor = response.next_cursor;
      input.catalogHealth.value = response.catalog_health;
    } catch (error) {
      if (controller.signal.aborted || generation !== catalogGeneration) return;
      if (
        staleHomeCursor(error) === "stale_catalog_cursor" &&
        input.sessionQuery.value.trim() === query
      )
        await refreshSessions(query);
      else input.catalogError.value = readableHomeError(error);
    } finally {
      if (catalogMoreController === controller) catalogMoreController = null;
      if (generation === catalogGeneration && input.sessionQuery.value.trim() === query)
        input.paging.catalog.loadingMore = false;
    }
  }

  async function activateSession(
    rootSessionId: string,
    expectedConversationId?: string,
  ): Promise<void> {
    let requiredConversationId = expectedConversationId;
    const rootChanged = input.activeRootId.value !== rootSessionId;
    if (rootChanged) input.commandAuthority.begin(rootSessionId);
    input.selectedSession.value = retainSelectedHomeSession(
      input.sessions.value,
      rootSessionId,
      input.selectedSession.value,
    );
    const token = input.readEpoch.begin(rootSessionId);
    activeToken = token;
    const streams = new ActivationResourceRegistry<EventSource>();
    token.addCleanup(() => streams.close());
    token.addCleanup(activePagination.invalidate);
    let refreshing: Promise<void> | null = null;
    let refreshAgain = false;
    const refresh = async () => {
      if (refreshing) {
        refreshAgain = true;
        return refreshing;
      }
      if (!token.isCurrent()) return;
      const run = (async () => {
        do {
          refreshAgain = false;
          if (!token.isCurrent()) return;
          const generation = ++activeDataGeneration;
          activePagination.beginRefresh();
          await refreshHomeActiveSelection({
            token,
            streams,
            rootSessionId,
            ...(requiredConversationId ? { expectedConversationId: requiredConversationId } : {}),
            authoritativeHead: input.authoritativeHead,
            timeline: input.timeline,
            pendingActions: input.pendingActions,
            paging: input.paging,
            isRefreshCurrent: () => generation === activeDataGeneration,
            reload: refresh,
            invalidUpdate: () => {
              input.activationError.value =
                "An operation update could not be read. The durable state will reload.";
            },
          });
          requiredConversationId = undefined;
        } while (refreshAgain);
      })();
      const tracked = run.finally(() => {
        if (refreshing === tracked) refreshing = null;
      });
      refreshing = tracked;
      return tracked;
    };
    activeRefresh = refresh;
    token.addCleanup(() => {
      if (activeRefresh === refresh) activeRefresh = null;
    });
    input.activeRootId.value = rootSessionId;
    if (rootChanged) {
      input.authoritativeHead.value = null;
      input.timeline.value = null;
      input.pendingActions.value = [];
    }
    input.activationLoading.value = true;
    input.activationError.value = "";
    input.streamStatus.value = "idle";
    input.streamError.value = "";
    try {
      await refresh();
      if (!token.isCurrent()) return;
      if (shouldStreamHomeRevision(input.activeRevision.value)) {
        const revision = input.activeRevision.value;
        if (revision) {
          const live = watchHomeConversationStream({
            conversationId: revision.conversation_id,
            cursor: () =>
              homeTimelineCursorForRevision(
                input.timeline.value,
                revision.conversation_id,
                revision.revision_id,
              ),
            signal: token.signal,
            isCurrent: token.isCurrent,
            setStatus(status, error) {
              if (!token.isCurrent()) return;
              input.streamStatus.value = status;
              input.streamError.value = error ?? "";
            },
            onSnapshot(snapshot) {
              if (!token.isCurrent()) return;
              if (
                snapshot.conversation_id === revision.conversation_id &&
                snapshot.last_seq >
                  homeTimelineCursorForRevision(
                    input.timeline.value,
                    revision.conversation_id,
                    revision.revision_id,
                  )
              )
                void refresh().catch(() => undefined);
            },
            onTrace(record) {
              if (!token.isCurrent()) return;
              input.timeline.value = appendHomeTimelineTrace(
                input.timeline.value,
                revision,
                record,
              );
            },
            onRefreshNeeded() {
              void refresh().catch(() => undefined);
            },
          });
          token.addCleanup(() => live.close());
        }
      }
      const timer = setInterval(() => {
        if (token.isCurrent() && input.online.value) void refresh().catch(() => undefined);
      }, 8_000);
      token.addCleanup(() => clearInterval(timer));
    } catch (error) {
      if (token.isCurrent()) input.activationError.value = readableHomeError(error);
      if (requiredConversationId) throw error;
    } finally {
      if (token.isCurrent()) input.activationLoading.value = false;
    }
  }

  async function selectSession(rootSessionId: string): Promise<void> {
    await activateSession(rootSessionId);
  }

  async function adoptAuthoritativeActiveHead(expectedConversationId: string): Promise<boolean> {
    const rootSessionId = input.activeRootId.value;
    if (!rootSessionId || !expectedConversationId) return false;
    await activateSession(rootSessionId, expectedConversationId);
    const current = input.authoritativeHead.value;
    return Boolean(
      current?.root_session_id === rootSessionId &&
        current.head_status === "committed" &&
        current.active?.conversation_id === expectedConversationId,
    );
  }

  async function refreshActiveSelection(): Promise<boolean> {
    const refresh = activeRefresh;
    const rootSessionId = input.activeRootId.value;
    if (!refresh || !rootSessionId || !activeToken?.isCurrent()) return false;
    await refresh();
    return Boolean(activeToken?.isCurrent() && input.activeRootId.value === rootSessionId);
  }

  return {
    refreshSessions,
    loadMoreSessions,
    selectSession,
    adoptAuthoritativeActiveHead,
    refreshActiveSelection,
    loadMoreTimeline: activePagination.loadMoreTimeline,
    loadMorePendingActions: activePagination.loadMorePendingActions,
    searchCapabilities: capabilityRuntime.searchCapabilities,
    loadMoreCapabilities: capabilityRuntime.loadMoreCapabilities,
    dispose() {
      catalogController?.abort();
      catalogMoreController?.abort();
      capabilityRuntime.dispose();
      activePagination.invalidate();
      input.readEpoch.close();
    },
  };
}
