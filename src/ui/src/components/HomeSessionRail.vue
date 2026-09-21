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
      <button
        class="home-rail__collapse"
        type="button"
        aria-label="Collapse conversation history"
        title="Collapse conversation history"
        @click="store.railCollapsed = true"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m13 4-6 6 6 6" /></svg>
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
        <span
          v-if="store.catalogLoading"
          class="home-search__busy"
          :aria-label="catalogLoading.searchLabel"
          role="status"
        >
          <span class="home-busy-signal" aria-hidden="true"><i /><i /><i /></span>
          <small>{{ catalogLoading.searchLabel }}</small>
        </span>
      </label>
    </div>

    <div v-if="store.catalogError" class="home-rail-state" role="status">
      <strong>Conversations unavailable</strong>
      <span>{{ store.catalogError }}</span>
      <button type="button" @click="store.refreshSessions()">Try again</button>
    </div>
    <div
      v-else-if="store.catalogLoading && !store.sessions.length"
      class="home-loading-panel home-loading-panel--rail"
      aria-label="Loading conversations"
      role="status"
      aria-live="polite"
    >
      <header class="home-loading-panel__header">
        <span>{{ catalogLoading.eyebrow }}</span>
        <strong>{{ catalogLoading.title }}</strong>
      </header>
      <p class="home-loading-panel__copy">{{ catalogLoading.detail }}</p>
      <ul class="home-loading-panel__checkpoints" aria-label="Loading progress">
        <li v-for="checkpoint in catalogLoading.checkpoints" :key="checkpoint">{{ checkpoint }}</li>
      </ul>
      <div class="home-loading-rail" aria-hidden="true">
        <article v-for="index in 4" :key="index">
          <span class="home-loading-rail__dot" />
          <div class="home-loading-rail__copy">
            <strong />
            <small />
          </div>
        </article>
      </div>
    </div>
    <div v-else-if="!store.sessions.length" class="home-rail-state">
      <strong>{{ store.sessionQuery ? "No matches" : "No conversations yet" }}</strong>
      <span>{{ store.sessionQuery ? "Try a shorter search." : "Your first conversation starts in the composer." }}</span>
    </div>
    <nav
      v-else
      class="home-session-list"
      aria-label="Conversations grouped by project"
      @keydown="onRailKeydown"
    >
      <section
        v-for="folder in railFolders"
        :key="folder.project_id"
        class="home-session-group"
        :class="{ 'home-session-group--ideas': folder.ideas }"
        role="group"
        :aria-labelledby="groupNameId(folder.project_id)"
      >
        <div class="home-session-group__header">
          <h3 :id="groupNameId(folder.project_id)" class="home-session-group__name">
            {{ folder.name }}
            <span class="sr-only">, {{ folder.sessions.length }} conversations</span>
          </h3>
          <button
            type="button"
            class="home-session-group__divider"
            :aria-expanded="!collapsedGroups.has(folder.project_id)"
            :aria-controls="groupEntriesId(folder.project_id)"
            :aria-labelledby="groupNameId(folder.project_id)"
            :title="folder.name"
            @click="toggleGroup(folder.project_id)"
          >
            <span v-if="folder.goal" class="home-session-group__goal">{{ folder.goal }}</span>
            <span class="home-session-group__count">{{ folder.sessions.length }}</span>
            <span class="home-session-group__chevron" aria-hidden="true">
              {{ collapsedGroups.has(folder.project_id) ? "▸" : "▾" }}
            </span>
          </button>
        </div>
        <hr class="home-session-group__rule" />
        <div
          v-show="!collapsedGroups.has(folder.project_id)"
          :id="groupEntriesId(folder.project_id)"
          class="home-session-group__entries"
        >
          <button
            v-for="session in folder.sessions"
            :key="session.root_session_id"
            type="button"
            class="home-session"
            :data-root-session="session.root_session_id"
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
        </div>
      </section>
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { describeHomeCatalogLoading } from "../conversation-home-loading.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import type { HomeSessionSummary } from "../conversation-home-types.js";
import { homeConversationLifecycleLabel } from "../conversation-lifecycle-presentation.js";
import { useProjectClassificationStore } from "../project-classification-store.js";
import {
  type ProjectRailFolder,
  groupConversationsByProject,
  projectRailEntryOrder,
} from "../project-rail-group.js";

const store = useConversationHomeStore();
const projectStore = useProjectClassificationStore();
const railRoot = ref<HTMLElement | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let mobileQuery: MediaQueryList | null = null;

/**
 * Collapse state lives with the rail, not the store: it is pure presentation, is not shared with
 * any other surface, and resetting it on reload is the intended behaviour.
 */
const collapsedGroups = ref<Set<string>>(new Set());
/** Collapse state as it stood before a query auto-expanded the matching groups. */
let collapsedBeforeQuery: Set<string> | null = null;
const catalogLoading = computed(() =>
  describeHomeCatalogLoading({
    query: store.sessionQuery,
    health: store.catalogHealth,
  }),
);

/** Folders come from the pure helper so the ordering rules stay testable without a DOM. */
const railFolders = computed<ProjectRailFolder<HomeSessionSummary>[]>(() =>
  groupConversationsByProject(store.sessions, projectStore.projects),
);

const visibleEntryOrder = computed(() =>
  projectRailEntryOrder(railFolders.value, collapsedGroups.value),
);

const groupNameId = (projectId: string) => `rail-group-${projectId}`;
const groupEntriesId = (projectId: string) => `rail-entries-${projectId}`;

function toggleGroup(projectId: string): void {
  const next = new Set(collapsedGroups.value);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  collapsedGroups.value = next;
}

/**
 * Arrow traversal walks the visible entries, crossing group boundaries and skipping collapsed
 * groups — the same session order the flat rail had, so muscle memory survives the grouping.
 */
function focusEntry(rootSessionId: string | undefined): void {
  if (!rootSessionId) return;
  railRoot.value
    ?.querySelector<HTMLButtonElement>(`[data-root-session="${CSS.escape(rootSessionId)}"]`)
    ?.focus();
}

function onRailKeydown(event: KeyboardEvent): void {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const current = target.closest<HTMLElement>("[data-root-session]")?.dataset.rootSession;
  if (!current) return;
  const order = visibleEntryOrder.value;
  const index = order.indexOf(current);
  if (index < 0) return;
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (step !== 0) {
    event.preventDefault();
    // Wrap is deliberate: ArrowDown on the last entry returns to the search field's list start.
    const next = order[(index + step + order.length) % order.length];
    focusEntry(next);
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const folder = railFolders.value.find((candidate) =>
    candidate.sessions.some((session) => session.root_session_id === current),
  );
  if (!folder) return;
  event.preventDefault();
  const collapsed = collapsedGroups.value.has(folder.project_id);
  if (event.key === "ArrowRight" && collapsed) toggleGroup(folder.project_id);
  if (event.key === "ArrowLeft" && !collapsed) {
    // Collapsing around a focused entry would hide it; the divider takes focus instead.
    toggleGroup(folder.project_id);
    railRoot.value
      ?.querySelector<HTMLButtonElement>(`[aria-controls="${groupEntriesId(folder.project_id)}"]`)
      ?.focus();
  }
}

const lifecycleLabel = homeConversationLifecycleLabel;

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
  (query) => {
    // A query must not hide its own matches: expand what is collapsed while it is active, and
    // hand the user's prior collapse state back the moment it clears.
    const active = query.trim() !== "";
    if (active && collapsedBeforeQuery === null) {
      collapsedBeforeQuery = collapsedGroups.value;
      collapsedGroups.value = new Set();
    } else if (!active && collapsedBeforeQuery !== null) {
      collapsedGroups.value = collapsedBeforeQuery;
      collapsedBeforeQuery = null;
    }
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
  // Divider labels come from the registry; the rail renders slug labels until it lands.
  void projectStore.refreshProjects();
});
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  mobileQuery?.removeEventListener("change", syncRailForViewport);
});
</script>
