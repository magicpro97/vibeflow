<template>
  <header class="flex items-center gap-3 px-4 h-12 border-b border-neutral-800/40 bg-neutral-950 shrink-0">
    <!-- Brand -->
    <div class="flex items-center gap-2 flex-shrink-0">
      <!-- Logo mark — two overlapping squares like a "vf" monogram -->
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="8" height="8" rx="1.5" fill="white" opacity="0.9"/>
        <rect x="7" y="7" width="8" height="8" rx="1.5" fill="white" opacity="0.4"/>
      </svg>
      <span
        class="text-sm font-medium text-white tracking-tight leading-none"
        :title="store.version ? `VibeFlow v${store.version}` : 'VibeFlow — AI coding agent orchestrator'"
      >VibeFlow</span>
      <span v-if="repoName" class="text-neutral-700">/</span>
      <span v-if="repoName" class="text-[11px] text-neutral-500 truncate max-w-32">{{ repoName }}</span>
      <span v-if="repoTaskId" class="text-[10px] text-neutral-700 font-mono truncate max-w-24">{{ repoTaskId }}</span>
      <!-- Tagline when no repo is active -->
      <span v-if="!repoName && !store.state" class="text-[10px] text-neutral-800 hidden sm:inline">AI coding agents</span>
    </div>

    <!-- Stepper: full labels ≥1024px, dots-only 768-1023px, hidden+badge <768px -->
    <div class="flex-1 flex justify-center min-w-0 overflow-hidden hidden md:flex">
      <Stepper :stage="(store.stage < 1 ? 1 : store.stage) as 1|2|3|4" @select="store.setStage" />
    </div>
    <!-- Badge shown below md (768px) when stepper is hidden -->
    <span class="md:hidden text-[11px] text-neutral-500 flex-shrink-0">{{ ['Home','Describe','Plan','Run','Verify'][store.stage] }}</span>

    <!-- Server health indicator -->
    <div
      v-if="!serverOnline"
      class="flex items-center gap-1.5 text-[11px] text-neutral-500 flex-shrink-0"
      title="Cannot reach VibeFlow server"
    >
      <span class="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" />
      offline
    </div>

    <!-- Right actions — flex-shrink-0 ensures these never get squeezed by Stepper -->
    <div class="flex items-center gap-0.5 flex-shrink-0 ml-2">
      <button
        v-if="store.stage !== 0"
        class="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-neutral-500 hover:text-white transition-colors duration-150 rounded"
        title="Project history"
        @click="store.setStage(0)"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 6.5 8 2l6 4.5V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5Z"/>
        </svg>
        <span>Home</span>
      </button>
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-neutral-500 hover:text-white transition-colors duration-150 rounded"
        :title="logsOpen ? 'Hide logs' : 'Show logs'"
        :aria-expanded="logsOpen"
        aria-controls="log-pane"
        @click="$emit('toggle-logs')"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
          <path d="M2 4h12M2 8h8M2 12h5" />
        </svg>
        <span>Logs</span>
      </button>
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-neutral-500 hover:text-white transition-colors duration-150 rounded"
        title="Ask about code"
        aria-label="Open ask"
        @click="$emit('open-ask')"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 6a2 2 0 1 1 2.6 1.9c-.4.15-.6.5-.6.9v.7" />
          <circle cx="8" cy="12" r="0.5" fill="currentColor" />
        </svg>
        <span>Ask</span>
      </button>
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-neutral-500 hover:text-white transition-colors duration-150 rounded"
        title="Skills catalog"
        aria-label="Open skills catalog"
        @click="$emit('open-skills')"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 2v12M12 2v12M2 4h12M2 12h12" />
          <path d="M6 2v12M10 2v12M2 6h12M2 10h12" />
        </svg>
        <span>Skills</span>
      </button>
      <button
        class="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-neutral-500 hover:text-white transition-colors duration-150 rounded"
        title="Settings"
        aria-label="Open settings"
        @click="$emit('open-settings')"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
        </svg>
        <span>Settings</span>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { useVfStore } from "../store.js";
import Stepper from "./Stepper.vue";

defineEmits<{ "toggle-logs": []; "open-settings": []; "open-ask": []; "open-skills": [] }>();
const props = defineProps<{ logsOpen?: boolean }>();
const logsOpen = computed(() => props.logsOpen ?? false);

const store = useVfStore();
const repoName = computed(() => {
  // repo_path is deprecated and no longer written by server.
  // Fall back to localStorage history (written by Stage1 on successful detect).
  const path =
    store.state?.repo_path ??
    (() => {
      try {
        const h = JSON.parse(localStorage.getItem("vf-repo-history") || "[]");
        return h[0] ?? null;
      } catch {
        return null;
      }
    })();
  if (path && store.state)
    return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
  return null;
});

const repoTaskId = computed(() => {
  if (store.stage === 0) {
    const sel = store.selectedWorkflowKey;
    if (sel) {
      const parts = sel.split("\u0000");
      return parts[1];
    }
    return null;
  }
  return store.state?.task_id ?? null;
});

const serverOnline = ref(true);
async function checkHealth() {
  if (document.visibilityState === "hidden") return;
  try {
    const res = await fetch("/state", { method: "GET" });
    serverOnline.value = res.ok || res.status === 404;
  } catch {
    serverOnline.value = false;
  }
}
function onVisibilityChange() {
  if (document.visibilityState === "visible") checkHealth();
}
checkHealth();
const healthTimer = setInterval(checkHealth, 10_000);
document.addEventListener("visibilitychange", onVisibilityChange);
onUnmounted(() => {
  clearInterval(healthTimer);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>
