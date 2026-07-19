<template>
  <div class="max-w-3xl space-y-4">

    <div>
      <h1 class="text-sm font-semibold text-neutral-100">Plan</h1>
      <p class="text-[11px] text-neutral-600 mt-0.5">{{ units.length ? 'Review tasks, choose an engine, then hit Dispatch. Logs open automatically.' : 'Choose an engine and hit Dispatch — the engine will plan and create tasks automatically.' }}</p>
    </div>

    <!-- Empty state — no init run yet -->
    <div
      v-if="!store.state"
      class="flex flex-col items-center justify-center py-16 text-neutral-600 gap-3"
    >
      <svg class="w-10 h-10 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
      <div class="text-center">
        <p class="text-sm text-neutral-500">Nothing planned yet</p>
        <p class="text-xs text-neutral-500 mt-1">Go to <button @click="store.setStage(1)" class="text-neutral-300 hover:text-white underline underline-offset-2">Describe</button> to describe your task — VibeFlow will generate the plan</p>
      </div>
    </div>

    <template v-else>

    <!-- Goal summary + replan -->
    <div class="flex items-start justify-between gap-4 pb-4 border-b border-neutral-800/40">
      <div class="min-w-0 space-y-1.5">
        <p class="text-sm text-neutral-200 leading-snug line-clamp-3" :title="store.state.goal">{{ store.state.goal }}</p>
        <div v-if="store.state.success_criteria?.length" class="flex flex-wrap gap-1">
          <span
            v-for="c in store.state.success_criteria.slice(0,3)"
            :key="c"
            class="text-[10px] text-neutral-600 px-1.5 py-0.5 rounded border border-neutral-800/40 font-mono truncate max-w-48"
            :title="c"
          >{{ c }}</span>
          <span
            v-if="store.state.success_criteria.length > 3"
            class="text-[10px] text-neutral-700"
            :title="store.state.success_criteria.slice(3).join('\n')"
          >+{{ store.state.success_criteria.length - 3 }} more</span>
        </div>
      </div>
      <button
        class="flex-shrink-0 self-start px-3 py-1.5 rounded border border-neutral-800 text-xs text-neutral-500 hover:border-neutral-600 hover:text-neutral-200 transition-colors"
        title="Go back to Describe to change goal or settings"
        @click="store.setStage(1)"
      >← Replan</button>
    </div>

    <div class="flex items-center gap-3">
      <span class="text-[11px] text-neutral-600 flex items-center gap-0.5">
        Engine
        <InfoTip tip="Claude (recommended), codex, or copilot. Claude plans and executes autonomously." />
      </span>
      <div class="flex gap-2">
        <label
          v-for="e in ENGINES"
          :key="e"
          class="flex items-center gap-1.5 cursor-pointer select-none"
        >
          <input
            type="radio"
            name="engine"
            :value="e"
            v-model="engine"
            class="accent-neutral-400"
          />
          <span
            class="text-xs font-mono transition-colors"
            :class="engine === e ? 'text-neutral-200' : 'text-neutral-500'"
          >{{ e }}</span>
        </label>
      </div>
    </div>

    <!-- Work unit table or guidance -->
    <div v-if="!units.length" class="rounded border border-neutral-800/40 px-4 py-5 space-y-1.5">
      <p class="text-sm text-neutral-400">No tasks yet</p>
      <p class="text-[11px] text-neutral-600 leading-relaxed">
        Click <span class="text-neutral-300 font-medium">Dispatch</span> below — the engine reads your goal, breaks it into tasks, and starts executing them automatically.
      </p>
    </div>
    <WorkUnitTable v-else :units="units" empty-text="Click Dispatch below — the engine will analyze your goal and create tasks." />

    <!-- Summary bar -->
    <div
      v-if="units.length"
      class="flex items-center gap-4 px-3 py-2 rounded border border-neutral-800/40 text-xs text-neutral-400"
    >
      <span>
        <span class="text-neutral-200 font-medium">{{ totals.done }}</span><span class="text-neutral-700">/</span>{{ totals.units }} done
      </span>
      <span class="text-neutral-700">·</span>
      <span>
        <span class="text-neutral-200 font-medium">{{ fmtTokens(totals.tokens) }}</span> tokens
      </span>
      <span class="text-neutral-700">·</span>
      <span>
        <span class="text-neutral-400 font-normal">$</span><span class="text-neutral-200 font-medium">{{ fmtCost(totals.cost_usd) }}</span>
      </span>
      <span v-if="anyRunning" class="ml-auto flex items-center gap-1.5 text-neutral-500">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-white/50 animate-pulse"></span>
        {{ units.filter(u=>u.status==='running').length }} running
      </span>
    </div>

    <!-- Action row -->
    <div class="flex items-center gap-2 pt-1">
      <button
        class="btn-primary transition-colors"
        :disabled="dispatching || anyRunning || dispatched"
        :title="anyRunning ? 'Agents are running — wait for completion' : units.length ? `Dispatch ${units.length} task(s) with ${engine} (⌘↵)` : `Dispatch with ${engine} — the engine will create and run tasks (⌘↵)`"
        @keydown.meta.enter.prevent="!dispatching && !anyRunning && !dispatched && dispatchAll()"
        @keydown.ctrl.enter.prevent="!dispatching && !anyRunning && !dispatched && dispatchAll()"
        @click="dispatchAll"
      >
        {{ dispatching ? "Dispatching…" : anyRunning ? "Running…" : dispatched ? "Dispatched ✓" : "Dispatch" }}
      </button>

      <!-- Auto-advance CTA: only shown after dispatch completes -->
      <!-- Note: this navigates only, does NOT dispatch — tooltip clarifies -->
      <button
        v-if="canAdvance"
        class="px-4 py-2 rounded text-sm font-medium transition-colors"
        :class="allDone ? 'border border-neutral-700 text-neutral-200 hover:border-neutral-500 hover:text-white' : 'border border-neutral-800 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300'"
        :title="allDone ? 'Agents are done — go to Run tab to monitor or re-run' : 'Some tasks are blocked — go to Run tab to see details'"
        @click="store.setStage(3)"
      >
        {{ allDone ? "Next: Run →" : "Run anyway →" }}
      </button>
    </div>

    <div v-if="err" class="flex items-start gap-2 p-3 rounded border border-red-900/60 text-red-400 text-xs" role="alert" aria-live="assertive">
      <span class="mt-0.5 shrink-0">⚠</span><span>{{ err }}</span>
    </div>
    </template><!-- end v-else -->
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api } from "../api.js";
import { usePoller } from "../composables/usePoller.js";
import { useVfStore } from "../store.js";
import type { Engine } from "../types.js";
import InfoTip from "./InfoTip.vue";
import WorkUnitTable from "./WorkUnitTable.vue";

const ENGINES: Engine[] = ["claude", "codex", "copilot", "opencode", "antigravity"];

const store = useVfStore();
// Pre-select engine from Stage1 choice (persisted in localStorage); fallback claude
const savedEngine = (() => {
  try {
    return localStorage.getItem("vf-engine");
  } catch {
    return null;
  }
})();
const engine = ref<Engine>(
  (ENGINES as string[]).includes(savedEngine ?? "") ? (savedEngine as Engine) : "claude",
);
const dispatching = ref(false);
const dispatched = ref(false);
const err = ref<string | null>(null);

// Global ⌘↵ / Ctrl+↵ shortcut — works anywhere in Stage2
function onGlobalKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (!dispatching.value && !anyRunning.value && !dispatched.value) dispatchAll();
  }
}
onMounted(() => document.addEventListener("keydown", onGlobalKey));
onUnmounted(() => document.removeEventListener("keydown", onGlobalKey));

// Derived state from store
const units = computed(() => store.state?.work_units ?? []);
const totals = computed(
  () => store.state?.totals ?? { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
);
const anyRunning = computed(() => units.value.some((u) => u.status === "running"));
const allDone = computed(
  () => units.value.length > 0 && units.value.every((u) => u.status === "done"),
);
// Allow advancing even if some units are blocked — user shouldn't be stuck
const canAdvance = computed(
  () =>
    units.value.length > 0 &&
    units.value.every((u) => u.status === "done" || u.status === "blocked"),
);

// Live polling — active only while any unit is running
const { error: pollErr } = usePoller(
  async () => {
    if (!anyRunning.value) return null;
    // Use store.loadState() — not direct assignment — to keep Pinia reactivity consistent
    await store.loadState();
    return store.state;
  },
  2000,
  { lazy: true },
);

watch(pollErr, (v) => {
  if (v) err.value = v;
});

async function dispatchAll() {
  if (dispatching.value || anyRunning.value || dispatched.value) return; // guard rapid clicks
  dispatching.value = true;
  dispatched.value = false;
  err.value = null;
  try {
    await api.dispatch({ engine: engine.value });
    // Persist engine choice so Stage2 pre-selects it on next visit
    try {
      localStorage.setItem("vf-engine", engine.value);
    } catch {}
    await store.loadState();
    dispatched.value = true;
    store.logsOpen = true; // auto-open logs so user sees agent output immediately
    // Auto-advance to Run stage after brief confirmation
    setTimeout(() => {
      dispatched.value = false;
      store.setStage(3);
    }, 1000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Make "no workflow state" actionable — tell user to go back and re-submit
    if (msg.includes("no workflow state")) {
      err.value = "Session expired — go back to Describe and re-submit your goal first.";
    } else {
      err.value = msg;
    }
  } finally {
    dispatching.value = false;
  }
}

function fmtTokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);
}
function fmtCost(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}
</script>
