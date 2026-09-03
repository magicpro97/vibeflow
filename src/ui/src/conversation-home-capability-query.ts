import type { Ref } from "vue";
import { conversationHomeApi } from "./conversation-home-api.js";
import { mergeHomePage, staleHomeCursor } from "./conversation-home-pagination.js";
import type { HomeQueryApiAuthority } from "./conversation-home-query-authority.js";
import { readableHomeError } from "./conversation-home-runtime.js";
import type { HomeCapabilityItem, HomePagingSection } from "./conversation-home-types.js";

interface HomeCapabilityQueryInput {
  capabilities: Ref<HomeCapabilityItem[]>;
  query: Ref<string>;
  scope: Ref<"project" | "user">;
  loading: Ref<boolean>;
  error: Ref<string>;
  paging: HomePagingSection;
}

export function createHomeCapabilityQueryRuntime(
  input: HomeCapabilityQueryInput,
  api: Pick<HomeQueryApiAuthority, "capabilities"> = Object.freeze({
    capabilities: conversationHomeApi.capabilities,
  }),
) {
  let generation = 0;
  let refreshController: AbortController | null = null;
  let moreController: AbortController | null = null;
  let refreshInFlight: Promise<void> | null = null;
  let trailingRefresh = false;
  let disposed = false;

  async function performRefresh(): Promise<void> {
    const requestGeneration = ++generation;
    const query = input.query.value.trim();
    const scope = input.scope.value;
    refreshController?.abort();
    moreController?.abort();
    moreController = null;
    input.paging.nextCursor = null;
    input.paging.loadingMore = false;
    input.loading.value = true;
    input.error.value = "";
    const controller = new AbortController();
    refreshController = controller;
    try {
      const response = await api.capabilities(
        { query: query || undefined, scope },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        refreshController !== controller ||
        requestGeneration !== generation ||
        input.query.value.trim() !== query ||
        input.scope.value !== scope
      )
        return;
      input.capabilities.value = response.items;
      input.paging.nextCursor = response.next_cursor;
    } catch (error) {
      if (
        !controller.signal.aborted &&
        refreshController === controller &&
        requestGeneration === generation &&
        input.query.value.trim() === query &&
        input.scope.value === scope
      )
        input.error.value = readableHomeError(error);
    } finally {
      if (refreshController === controller) refreshController = null;
      if (requestGeneration === generation) input.loading.value = false;
    }
  }

  async function searchCapabilities(): Promise<void> {
    if (disposed) return;
    if (refreshInFlight) {
      trailingRefresh = true;
      refreshController?.abort();
      return refreshInFlight;
    }
    const run = (async () => {
      do {
        trailingRefresh = false;
        await performRefresh();
      } while (trailingRefresh && !disposed);
    })();
    const tracked = run.finally(() => {
      if (refreshInFlight === tracked) refreshInFlight = null;
    });
    refreshInFlight = tracked;
    return tracked;
  }

  async function loadMoreCapabilities(): Promise<void> {
    const cursor = input.paging.nextCursor;
    if (!cursor || input.paging.loadingMore || refreshInFlight) return;
    const requestGeneration = generation;
    const query = input.query.value.trim();
    const scope = input.scope.value;
    const controller = new AbortController();
    moreController = controller;
    input.paging.loadingMore = true;
    try {
      const response = await api.capabilities(
        { query: query || undefined, scope, cursor },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        moreController !== controller ||
        requestGeneration !== generation ||
        input.query.value.trim() !== query ||
        input.scope.value !== scope ||
        input.paging.nextCursor !== cursor
      )
        return;
      input.capabilities.value = mergeHomePage(
        input.capabilities.value,
        response.items,
        (item) => `${item.scope}:${item.package_id}:${item.version ?? ""}`,
      );
      input.paging.nextCursor = response.next_cursor;
    } catch (error) {
      if (
        controller.signal.aborted ||
        moreController !== controller ||
        requestGeneration !== generation
      )
        return;
      if (
        staleHomeCursor(error) === "stale_capability_cursor" &&
        input.query.value.trim() === query &&
        input.scope.value === scope
      )
        await searchCapabilities();
      else input.error.value = readableHomeError(error);
    } finally {
      if (moreController === controller) moreController = null;
      if (requestGeneration === generation) input.paging.loadingMore = false;
    }
  }

  return {
    searchCapabilities,
    loadMoreCapabilities,
    dispose() {
      disposed = true;
      trailingRefresh = false;
      refreshController?.abort();
      moreController?.abort();
      input.loading.value = false;
      input.paging.loadingMore = false;
    },
  };
}
