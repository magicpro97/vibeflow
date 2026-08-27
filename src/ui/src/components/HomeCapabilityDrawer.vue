<template>
  <Transition name="home-drawer">
    <aside v-if="open" class="home-capability-drawer" aria-label="CLI capabilities">
      <header>
        <span>
          <small>Extend your AI CLIs</small>
          <strong>Capabilities</strong>
        </span>
        <button ref="closeButton" type="button" aria-label="Close capabilities" @click="$emit('close')">×</button>
      </header>
      <p class="home-drawer-copy">Skills, tools, MCP servers, hooks, roles, and settings are installed through one reviewed Fabric.</p>

      <div class="home-scope-switch" aria-label="Capability scope">
        <button type="button" :aria-pressed="store.capabilityScope === CAPABILITY_SCOPE.PROJECT" @click="setScope(CAPABILITY_SCOPE.PROJECT)">This project</button>
        <button type="button" :aria-pressed="store.capabilityScope === CAPABILITY_SCOPE.USER" @click="setScope(CAPABILITY_SCOPE.USER)">All projects</button>
      </div>
      <form class="home-capability-search" @submit.prevent="store.searchCapabilities()">
        <label>
          <span class="sr-only">Search capabilities</span>
          <input ref="searchInput" v-model="store.capabilityQuery" type="search" placeholder="Search skills, tools, MCP…" autocomplete="off" />
        </label>
        <button type="submit" :disabled="store.capabilityLoading">Search</button>
      </form>

      <div v-if="store.capabilityError" class="home-drawer-state" role="alert">
        <strong>Capability index unavailable</strong>
        <span>{{ store.capabilityError }}</span>
        <button type="button" @click="store.searchCapabilities()">Try again</button>
      </div>
      <div
        v-else-if="store.capabilityLoading"
        class="home-loading-panel home-loading-panel--drawer"
        aria-label="Loading capabilities"
        role="status"
        aria-live="polite"
      >
        <header class="home-loading-panel__header">
          <span>{{ capabilityLoading.eyebrow }}</span>
          <strong>{{ capabilityLoading.title }}</strong>
        </header>
        <p class="home-loading-panel__copy">{{ capabilityLoading.detail }}</p>
        <ul class="home-loading-panel__checkpoints" aria-label="Capability search progress">
          <li v-for="checkpoint in capabilityLoading.checkpoints" :key="checkpoint">{{ checkpoint }}</li>
        </ul>
        <div class="home-loading-capabilities" aria-hidden="true">
          <article v-for="index in 3" :key="index">
            <span class="home-loading-capabilities__icon" />
            <div class="home-loading-capabilities__copy">
              <strong />
              <small />
            </div>
            <i />
          </article>
        </div>
      </div>
      <div v-else-if="!store.capabilities.length" class="home-drawer-state">
        <span class="home-drawer-state__glyph" aria-hidden="true">⌁</span>
        <strong>No capabilities found</strong>
        <span>Try another search or switch scope.</span>
      </div>
      <div v-else class="home-capability-list" role="list">
        <article v-for="item in store.capabilities" :key="`${item.package_id}:${item.version}`" role="listitem">
          <header>
            <span class="home-capability-icon" aria-hidden="true">{{ item.display_name.slice(0, 1).toUpperCase() }}</span>
            <span><strong>{{ item.display_name }}</strong><small>{{ item.package_id }}</small></span>
            <i :data-status="item.status">{{ statusLabel(item.status) }}</i>
          </header>
          <p>{{ item.summary }}</p>
          <div class="home-capability-meta">
            <span v-if="item.version">v{{ item.version }}</span>
            <span v-if="item.source_trust">{{ item.source_trust }}</span>
            <span>{{ item.cache_status }}</span>
          </div>
          <div v-if="item.status === CAPABILITY_STATUS.MANUAL || item.status === CAPABILITY_STATUS.UNSUPPORTED || item.status === CAPABILITY_STATUS.NEEDS_RECOVERY" class="home-capability-warning">
            {{ stateHelp(item.status) }}
          </div>
          <footer>
            <button type="button" @click="useCapability(item)">
              {{ item.status === CAPABILITY_STATUS.READY ? 'Manage in chat' : item.status === CAPABILITY_STATUS.NEEDS_RECOVERY ? 'Prepare repair' : 'Prepare install' }}
              <span aria-hidden="true">→</span>
            </button>
          </footer>
        </article>
        <button
          v-if="store.paging.capability.nextCursor"
          type="button"
          class="home-button"
          :disabled="store.paging.capability.loadingMore"
          @click="store.loadMoreCapabilities()"
        >{{ store.paging.capability.loadingMore ? "Loading…" : "Load more capabilities" }}</button>
      </div>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  CAPABILITY_SCOPE,
  CAPABILITY_STATUS,
  type CapabilityScope,
} from "../../../core/capability-contract.js";
import { describeHomeCapabilityLoading } from "../conversation-home-loading.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import type { CapabilityStatus, HomeCapabilityItem } from "../conversation-home-types.js";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const store = useConversationHomeStore();
const searchInput = ref<HTMLInputElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const capabilityLoading = computed(() =>
  describeHomeCapabilityLoading({
    query: store.capabilityQuery,
    scope: store.capabilityScope,
  }),
);

const statusLabel = (status: CapabilityStatus) => status.replaceAll("-", " ");
const stateHelp = (status: CapabilityStatus) =>
  status === CAPABILITY_STATUS.MANUAL
    ? "This target needs a documented manual step. VibeFlow will keep it visible."
    : status === CAPABILITY_STATUS.UNSUPPORTED
      ? "No honest adapter exists for this target yet. Nothing will be simulated."
      : "The current scope needs durable recovery before another mutation.";

function setScope(scope: CapabilityScope) {
  store.capabilityScope = scope;
  void store.searchCapabilities();
}

async function useCapability(item: HomeCapabilityItem) {
  if (item.status === CAPABILITY_STATUS.NEEDS_RECOVERY) {
    if (await store.proposeCapabilityRepair(item)) emit("close");
    return;
  }
  if (item.status === CAPABILITY_STATUS.READY)
    store.draft = `Review the current ${item.package_id} capability and help me change it.`;
  else
    store.draft = `/install ${item.package_id}${store.capabilityScope === CAPABILITY_SCOPE.USER ? " --user" : ""}`;
  emit("close");
  nextTick(() => document.querySelector<HTMLTextAreaElement>("#home-composer")?.focus());
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    searchInput.value?.focus();
    void store.searchCapabilities();
  },
);
</script>
