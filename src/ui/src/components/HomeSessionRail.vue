<template>
  <aside
    ref="railRoot"
    class="home-rail"
    :class="{ 'home-rail--collapsed': store.railCollapsed }"
    :aria-hidden="store.railCollapsed ? 'true' : undefined"
    :inert="store.railCollapsed ? true : undefined"
    aria-label="Conversations"
  >
    <div class="home-rail__top">
      <button class="home-new-button" type="button" @click="startNew">
        <span class="home-new-button__mark" aria-hidden="true">+</span>
        <span>New conversation</span>
      </button>
      <label class="home-search">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="5.5" />
          <path d="m13 13 4 4" />
        </svg>
        <span class="sr-only">Search conversations</span>
        <input
          v-model="store.sessionQuery"
          type="search"
          autocomplete="off"
          placeholder="Search conversations"
          @keydown.esc="store.sessionQuery = ''"
        />
        <span v-if="store.catalogLoading" class="home-search__busy" aria-label="Searching" />
      </label>
    </div>

    <div v-if="store.catalogError" class="home-rail-state" role="status">
      <strong>Conversations unavailable</strong>
      <span>{{ store.catalogError }}</span>
      <button type="button" @click="store.refreshSessions()">Try again</button>
    </div>
    <div v-else-if="store.catalogLoading && !store.sessions.length" class="home-session-skeleton" aria-label="Loading conversations">
      <span v-for="index in 5" :key="index" />
    </div>
    <div v-else-if="!store.sessions.length" class="home-rail-state">
      <strong>{{ store.sessionQuery ? "No matches" : "No conversations yet" }}</strong>
      <span>{{ store.sessionQuery ? "Try a shorter search." : "Your first conversation starts in the composer." }}</span>
    </div>
    <nav v-else class="home-session-list" aria-label="Recent conversations">
      <button
        v-for="session in store.sessions"
        :key="session.root_session_id"
        type="button"
        class="home-session"
        :class="{ 'home-session--active': session.root_session_id === store.activeRootId }"
        :aria-current="session.root_session_id === store.activeRootId ? 'page' : undefined"
        @click="select(session.root_session_id)"
      >
        <span class="home-session__row">
          <span class="home-session__title">{{ (session.active ?? session.root).topic }}</span>
          <span class="home-session__time">{{ relativeTime(session.sort_updated_at) }}</span>
        </span>
        <span class="home-session__row home-session__meta">
          <span class="home-status-dot" :data-state="(session.active ?? session.root).lifecycle" />
          <span>{{ lifecycleLabel((session.active ?? session.root).lifecycle) }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ session.revision_count }} rev</span>
          <span v-if="(session.active ?? session.root).health === 'degraded'" class="home-degraded">degraded</span>
        </span>
      </button>
    </nav>
    <div v-if="store.paging.catalog.nextCursor" class="home-rail-state">
      <button
        type="button"
        class="home-button"
        :disabled="store.paging.catalog.loadingMore"
        @click="store.loadMoreSessions()"
      >{{ store.paging.catalog.loadingMore ? "Loading…" : "Load more conversations" }}</button>
    </div>

    <footer class="home-rail__footer">
      <span :class="store.online ? 'home-online' : 'home-offline'" aria-hidden="true" />
      <span>{{ store.online ? "Local runtime connected" : "Offline · draft stays here" }}</span>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useConversationHomeStore } from "../conversation-home-store.js";
import type { ConversationLifecycle } from "../conversation-home-types.js";

const store = useConversationHomeStore();
const railRoot = ref<HTMLElement | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let mobileQuery: MediaQueryList | null = null;

const lifecycleLabel = (value: ConversationLifecycle) =>
  ({
    INIT: "Starting",
    ACTIVE: "Active",
    PAUSED: "Paused",
    COMPLETED: "Complete",
    STOPPED: "Stopped",
    FAILED: "Failed",
    ABORTED: "Aborted",
  })[value];

function relativeTime(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.round(elapsed / 60_000);
  if (Math.abs(minutes) < 1) return "now";
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)}h`;
  const days = Math.round(hours / 24);
  return `${Math.abs(days)}d`;
}

function select(rootSessionId: string) {
  void store.selectSession(rootSessionId);
  if (window.matchMedia("(max-width: 760px)").matches) store.railCollapsed = true;
}

function startNew() {
  store.newConversation();
  if (window.matchMedia("(max-width: 760px)").matches) store.railCollapsed = true;
  requestAnimationFrame(() =>
    document.querySelector<HTMLTextAreaElement>("#home-composer")?.focus(),
  );
}

function syncRailForViewport(): void {
  if (window.matchMedia("(max-width: 760px)").matches) store.railCollapsed = true;
}

watch(
  () => store.sessionQuery,
  () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void store.refreshSessions(), 180);
  },
);

watch(
  () => store.railCollapsed,
  (collapsed) => {
    if (!collapsed) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && railRoot.value?.contains(active))
      document
        .querySelector<HTMLButtonElement>(
          '.home-topbar button[aria-label="Open conversation list"]',
        )
        ?.focus();
  },
);

onMounted(() => {
  syncRailForViewport();
  mobileQuery = window.matchMedia("(max-width: 760px)");
  mobileQuery.addEventListener("change", syncRailForViewport);
  void store.refreshSessions();
});
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  mobileQuery?.removeEventListener("change", syncRailForViewport);
});
</script>
