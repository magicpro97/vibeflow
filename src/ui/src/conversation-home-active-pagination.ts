import type { ComputedRef, Ref, ShallowRef } from "vue";
import { PUBLIC_ERROR_CODE } from "../../actions/public-error-contract.js";
import { conversationHomeApi } from "./conversation-home-api.js";
import {
  homeTimelineItemKey,
  mergeHomePage,
  staleHomeCursor,
} from "./conversation-home-pagination.js";
import { mergeHomePendingPage } from "./conversation-home-query-active.js";
import type { HomeQueryApiAuthority } from "./conversation-home-query-authority.js";
import { readableHomeError } from "./conversation-home-runtime.js";
import type { ActivationToken } from "./conversation-home-state.js";
import type {
  HomeActionView,
  HomePagingState,
  HomeTimelineResponse,
} from "./conversation-home-types.js";

interface HomeActivePaginationInput {
  token(): ActivationToken | null;
  generation(): number;
  activeRootId: Ref<string | null>;
  selectedConversationId: ComputedRef<string | null>;
  timeline: ShallowRef<HomeTimelineResponse | null>;
  pendingActions: Ref<HomeActionView[]>;
  paging: Pick<HomePagingState, "timeline" | "pending">;
  activationError: Ref<string>;
  restart(rootSessionId: string): Promise<void>;
}

export function createHomeActivePaginationRuntime(
  input: HomeActivePaginationInput,
  api: HomeQueryApiAuthority = conversationHomeApi,
) {
  let timelineController: AbortController | null = null;
  let pendingController: AbortController | null = null;

  function invalidate(): void {
    timelineController?.abort();
    pendingController?.abort();
    timelineController = null;
    pendingController = null;
    input.paging.timeline.loadingMore = false;
    input.paging.pending.loadingMore = false;
  }

  function beginRefresh(): void {
    invalidate();
    input.paging.timeline.nextCursor = null;
    input.paging.pending.nextCursor = null;
  }

  function matchesCurrentTimelineAuthority(
    response: HomeTimelineResponse,
    rootSessionId: string,
  ): boolean {
    const current = input.timeline.value;
    return Boolean(
      current &&
        response.root_session_id === rootSessionId &&
        current.root_session_id === rootSessionId &&
        response.head_epoch === current.head_epoch &&
        response.head_digest === current.head_digest &&
        response.head.conversation_id === current.head.conversation_id &&
        response.head.revision_id === current.head.revision_id &&
        response.head.revision_ordinal === current.head.revision_ordinal,
    );
  }

  async function loadMoreTimeline(): Promise<void> {
    const token = input.token();
    const rootSessionId = input.activeRootId.value;
    const cursor = input.paging.timeline.nextCursor;
    if (!token || !rootSessionId || !cursor || input.paging.timeline.loadingMore) return;
    const generation = input.generation();
    const controller = new AbortController();
    timelineController = controller;
    input.paging.timeline.loadingMore = true;
    try {
      const response = await api.timeline({ rootSessionId, cursor, limit: 50 }, controller.signal);
      if (
        !token.isCurrent() ||
        controller.signal.aborted ||
        generation !== input.generation() ||
        input.activeRootId.value !== rootSessionId ||
        input.paging.timeline.nextCursor !== cursor
      )
        return;
      if (!matchesCurrentTimelineAuthority(response, rootSessionId)) {
        await input.restart(rootSessionId);
        return;
      }
      input.timeline.value = input.timeline.value
        ? {
            ...response,
            items: mergeHomePage(input.timeline.value.items, response.items, homeTimelineItemKey),
          }
        : response;
      input.paging.timeline.nextCursor = response.next_cursor;
    } catch (error) {
      if (controller.signal.aborted || !token.isCurrent() || generation !== input.generation())
        return;
      if (staleHomeCursor(error) === PUBLIC_ERROR_CODE.STALE_TIMELINE_CURSOR)
        await input.restart(rootSessionId);
      else input.activationError.value = readableHomeError(error);
    } finally {
      if (timelineController === controller) timelineController = null;
      if (
        token.isCurrent() &&
        generation === input.generation() &&
        input.activeRootId.value === rootSessionId
      )
        input.paging.timeline.loadingMore = false;
    }
  }

  async function loadMorePendingActions(): Promise<void> {
    const token = input.token();
    const conversationId = input.selectedConversationId.value;
    const rootSessionId = input.activeRootId.value;
    const cursor = input.paging.pending.nextCursor;
    if (!token || !conversationId || !rootSessionId || !cursor || input.paging.pending.loadingMore)
      return;
    const generation = input.generation();
    const controller = new AbortController();
    pendingController = controller;
    input.paging.pending.loadingMore = true;
    try {
      const response = await api.pending(conversationId, { cursor, limit: 50 }, controller.signal);
      if (
        !token.isCurrent() ||
        controller.signal.aborted ||
        generation !== input.generation() ||
        input.activeRootId.value !== rootSessionId ||
        input.selectedConversationId.value !== conversationId ||
        input.paging.pending.nextCursor !== cursor
      )
        return;
      mergeHomePendingPage(input.pendingActions, input.paging, response);
    } catch (error) {
      if (controller.signal.aborted || !token.isCurrent() || generation !== input.generation())
        return;
      if (staleHomeCursor(error) === PUBLIC_ERROR_CODE.STALE_PENDING_PROPOSAL_CURSOR)
        await input.restart(rootSessionId);
      else input.activationError.value = readableHomeError(error);
    } finally {
      if (pendingController === controller) pendingController = null;
      if (
        token.isCurrent() &&
        generation === input.generation() &&
        input.activeRootId.value === rootSessionId &&
        input.selectedConversationId.value === conversationId
      )
        input.paging.pending.loadingMore = false;
    }
  }

  return { beginRefresh, invalidate, loadMoreTimeline, loadMorePendingActions };
}
