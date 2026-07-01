<template>
  <div class="flex flex-col h-screen overflow-hidden bg-neutral-950 text-neutral-100 text-sm antialiased">
    <TopBar :logs-open="store.logsOpen" @toggle-logs="store.logsOpen = !store.logsOpen" @open-settings="showSettings = true" />
    <div class="flex flex-1 overflow-hidden">
      <!-- No Rail — Stepper in TopBar handles navigation -->
      <main class="flex-1 overflow-y-auto p-8 min-w-0">
        <div class="max-w-4xl">
          <ProjectList v-if="store.stage === 0" />
          <Stage1Describe v-else-if="store.stage === 1" />
          <Stage2Generate v-else-if="store.stage === 2" />
          <Stage3Orchestrate v-else-if="store.stage === 3" />
          <Stage4Verify v-else-if="store.stage === 4" />
        </div>
      </main>
      <!-- Log pane with smooth slide-in/out transition -->
      <Transition name="log-pane">
        <LogPane v-if="store.logsOpen" id="log-pane" class="log-pane border-l border-neutral-800/40" />
      </Transition>
    </div>
    <StatusBar />
    <SettingsPanel v-if="showSettings" @close="closeSettings" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import LogPane from "./components/LogPane.vue";
import ProjectList from "./components/ProjectList.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import Stage1Describe from "./components/Stage1Describe.vue";
import Stage2Generate from "./components/Stage2Generate.vue";
import Stage3Orchestrate from "./components/Stage3Orchestrate.vue";
import Stage4Verify from "./components/Stage4Verify.vue";
import StatusBar from "./components/StatusBar.vue";
import TopBar from "./components/TopBar.vue";
import { useVfStore } from "./store.js";

const store = useVfStore();
const showSettings = ref(false);
const STAGE_TITLES = ["Home", "Describe", "Plan", "Run", "Verify"] as const;

// Update page title per stage — helps users with multiple tabs
watch(
  () => store.stage,
  (s) => {
    const label = STAGE_TITLES[s];
    const goal = store.state?.goal?.slice(0, 30);
    document.title = goal ? `${label} — ${goal} · VibeFlow` : `${label} · VibeFlow`;
  },
  { immediate: true },
);

function closeSettings() {
  showSettings.value = false;
  // Return focus to settings button after Vue finishes unmounting the panel
  nextTick(() => {
    document.querySelector<HTMLElement>('button[aria-label="Open settings"]')?.focus();
  });
}

onMounted(() => {
  // Load state and auto-advance stage based on what's already in progress
  store
    .loadState()
    .then(async () => {
      const units = store.state?.work_units ?? [];
      const goal = store.state?.goal ?? "";
      // If we have a state (goal was set), advance to at least Plan stage
      // Guard: ignore stale test/empty goals that shouldn't hijack the UI
      if (!store.state || !goal.trim() || goal === "__CLEAR__") {
        // No active workflow — show home screen if there are previous projects
        await store.loadProjects();
        if (store.projects.length > 0) store.setStage(0);
        return;
      }
      if (units.length === 0) {
        store.setStage(2);
        return;
      } // goal set, no units yet → Plan review
      const anyRunning = units.some((u) => u.status === "running");
      // Auto-open log pane when agents are running so user sees live output
      if (anyRunning) store.logsOpen = true;
      const allSettled = units.every((u) => u.status === "done" || u.status === "blocked");
      const hasDone = units.some((u) => u.status === "done");
      if (allSettled && hasDone) {
        store.setStage(4); // resume at verify — only when some units are done
      } else if (allSettled && !hasDone) {
        store.setStage(3); // all blocked, no done → resume at run to re-orchestrate
      } else if (anyRunning) {
        store.setStage(3); // resume at run
      } else {
        store.setStage(2); // resume at work units
      }
    })
    .catch((e) => {
      // Log unexpected loadState failures — swallowing silently hides 500s
      console.warn("[vibeflow] loadState failed on mount:", e);
    });
  // loadSettings swallows all errors internally — explicit catch for hygiene
  store.loadSettings().catch(() => {});
});
</script>

<style scoped>
.log-pane {
  width: clamp(14rem, 22vw, 22rem);
  flex-shrink: 0;
}

.log-pane-enter-active,
.log-pane-leave-active {
  transition: width 0.2s ease, opacity 0.2s ease;
  overflow: hidden;
}

.log-pane-enter-from,
.log-pane-leave-to {
  width: 0;
  opacity: 0;
}
</style>
