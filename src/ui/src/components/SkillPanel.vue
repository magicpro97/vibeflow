<template>
  <div
    class="fixed inset-0 bg-black/60 flex items-start justify-center pt-12 z-50"
    tabindex="-1"
    @click.self="emit('close')"
    @keydown.esc="emit('close')"
    @keydown.tab.capture="trapFocus"
  >
    <div
      ref="dialogEl"
      class="bg-neutral-950 border border-neutral-800 rounded w-full max-w-xl p-5 max-h-[calc(100vh-6rem)] overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-panel-title"
    >
      <div class="flex items-center justify-between mb-4">
        <h2 id="skill-panel-title" class="font-semibold text-neutral-100">Skills Catalog</h2>
        <button
          class="text-neutral-500 hover:text-neutral-200 text-xl leading-none"
          aria-label="Close skills panel"
          @click="emit('close')"
        >×</button>
      </div>

      <div class="flex gap-1 mb-4 border-b border-neutral-800" role="tablist" aria-label="Skills panel sections">
        <button
          id="tab-skills"
          role="tab"
          :aria-selected="tab === 'skills'"
          :aria-controls="'panel-skills'"
          :tabindex="tab === 'skills' ? 0 : -1"
          class="px-3 py-1.5 text-xs rounded-t transition-colors"
          :class="tab === 'skills' ? 'text-neutral-100 border-b-2 border-neutral-200' : 'text-neutral-500 hover:text-neutral-300'"
          @click="selectTab('skills')"
          @keydown="onTabKeydown"
        >Skills</button>
        <button
          id="tab-registries"
          role="tab"
          :aria-selected="tab === 'registries'"
          :aria-controls="'panel-registries'"
          :tabindex="tab === 'registries' ? 0 : -1"
          class="px-3 py-1.5 text-xs rounded-t transition-colors"
          :class="tab === 'registries' ? 'text-neutral-100 border-b-2 border-neutral-200' : 'text-neutral-500 hover:text-neutral-300'"
          @click="selectTab('registries')"
          @keydown="onTabKeydown"
        >Registries</button>
        <button
          id="tab-domains"
          role="tab"
          :aria-selected="tab === 'domains'"
          :aria-controls="'panel-domains'"
          :tabindex="tab === 'domains' ? 0 : -1"
          class="px-3 py-1.5 text-xs rounded-t transition-colors"
          :class="tab === 'domains' ? 'text-neutral-100 border-b-2 border-neutral-200' : 'text-neutral-500 hover:text-neutral-300'"
          @click="selectTab('domains')"
          @keydown="onTabKeydown"
        >Domain</button>
      </div>

      <div
        id="panel-skills"
        role="tabpanel"
        aria-labelledby="tab-skills"
        tabindex="0"
        :hidden="tab !== 'skills'"
      >
        <div v-if="store.skillError" class="py-4 text-center text-red-400 text-xs">
          {{ store.skillError }}
        </div>

        <div v-else-if="store.skillLoading" class="py-4 space-y-3">
          <div v-for="i in 3" :key="i" class="h-4 rounded bg-neutral-800/60 animate-pulse" :style="{width: ['70%','85%','60%'][i-1]}" />
        </div>

        <div v-else-if="store.skills.length === 0" class="py-8 text-center text-neutral-600 text-sm">
          No skills found.
        </div>

        <div v-else class="space-y-3">
          <div
            v-for="skill in store.skills"
            :key="skill.name"
            class="rounded border border-neutral-800 p-3"
            :class="skill.status === 'deprecated' ? 'opacity-50' : ''"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3
                  class="text-sm font-medium text-neutral-100 truncate"
                  :class="skill.status === 'deprecated' ? 'line-through' : ''"
                >{{ skill.name }}</h3>
                <p
                  class="text-xs text-neutral-400 mt-0.5 line-clamp-2"
                  :class="skill.status === 'deprecated' ? 'line-through' : ''"
                >{{ skill.description }}</p>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <span
                  class="w-1.5 h-1.5 rounded-full"
                  :class="scanDisplay(skill.securityScan).dot"
                />
                <span class="text-[10px]" :class="scanDisplay(skill.securityScan).color">
                  {{ scanDisplay(skill.securityScan).label }}
                </span>
              </div>
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] text-neutral-500">
              <span>Status: {{ skill.status }}</span>
              <span>Origin: {{ skill.origin }}</span>
              <span v-if="skill.version">v{{ skill.version }}</span>
              <span v-if="skill.registry" class="text-neutral-400">
                Registry: {{ skill.registry.id }} · v{{ skill.registry.version }} · pinned
              </span>
              <span v-if="skill.scope" class="inline-flex items-center gap-1 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300">
                {{ skill.scope }}
              </span>
              <span v-if="skill.owners?.length" class="text-neutral-500">
                Owner: {{ skill.owners[0] }}<span v-if="skill.owners.length > 1"> +{{ skill.owners.length - 1 }}</span>
              </span>
              <span v-if="skill.stale" class="text-yellow-500" :title="skill.staleReason || 'Source anchors are stale'">
                ⚠ stale
              </span>
            </div>
          </div>
        </div>
      </div>

      <div
        id="panel-registries"
        role="tabpanel"
        aria-labelledby="tab-registries"
        tabindex="0"
        :hidden="tab !== 'registries'"
      >
        <RegistryView />
        <ReleaseProposalsView />
      </div>

      <div
        id="panel-domains"
        role="tabpanel"
        aria-labelledby="tab-domains"
        tabindex="0"
        :hidden="tab !== 'domains'"
      >
        <DomainFactsView />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { scanDisplay } from "../lib/scan-helper.js";
import { useVfStore } from "../store.js";
import DomainFactsView from "./DomainFactsView.vue";
import RegistryView from "./RegistryView.vue";
import ReleaseProposalsView from "./ReleaseProposalsView.vue";

const emit = defineEmits<{ close: [] }>();
const store = useVfStore();
const dialogEl = ref<HTMLElement | null>(null);
const tab = ref<"skills" | "registries" | "domains">("skills");

function selectTab(next: "skills" | "registries" | "domains") {
  if (tab.value === "registries" && next !== "registries") {
    store.closeRegistryPreview();
  }
  tab.value = next;
  const id =
    next === "skills" ? "tab-skills" : next === "registries" ? "tab-registries" : "tab-domains";
  document.getElementById(id)?.focus();
}

const TABS: ("skills" | "registries" | "domains")[] = ["skills", "registries", "domains"];

function moveTab(dir: -1 | 1) {
  const idx = TABS.indexOf(tab.value);
  const next = TABS[(idx + dir + TABS.length) % TABS.length] ?? "skills";
  selectTab(next);
}

function onTabKeydown(e: KeyboardEvent) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    moveTab(-1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    moveTab(1);
  } else if (e.key === "Home") {
    e.preventDefault();
    selectTab("skills");
  } else if (e.key === "End") {
    e.preventDefault();
    selectTab("domains");
  }
}

onMounted(() => {
  dialogEl.value?.focus();
  if (store.skills.length === 0) store.loadSkills();
  document.addEventListener("focusin", onFocusIn, true);
});
onUnmounted(() => {
  document.removeEventListener("focusin", onFocusIn, true);
});

function onFocusIn(e: FocusEvent) {
  if (!dialogEl.value) return;
  if (!dialogEl.value.contains(e.target as Node)) {
    e.stopPropagation();
    const first = dialogEl.value.querySelector<HTMLElement>(
      'button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
  }
}

function trapFocus(e: KeyboardEvent) {
  const el = dialogEl.value;
  if (!el) return;
  const focusable = Array.from(
    el.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((n) => !n.closest("[hidden]"));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!first || !last) return;
  if (e.shiftKey) {
    if (document.activeElement === first || !el.contains(document.activeElement)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last || !el.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }
}
</script>
