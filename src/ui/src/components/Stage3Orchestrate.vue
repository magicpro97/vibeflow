<template>
  <div class="max-w-3xl space-y-4">

    <div>
      <h1 class="text-sm font-semibold text-neutral-100">Run agents</h1>
      <p class="text-[11px] text-neutral-600 mt-0.5">{{ anyRunning ? 'Agents are running — wait for them to finish, then verify.' : 'Click Run agents to start tasks. When all finish, you will be moved to Verify automatically.' }}</p>
    </div>

    <!-- Preflight section -->
    <div class="rounded border border-neutral-800/40 px-3 py-2.5 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-[11px] text-neutral-600 flex items-center gap-0.5">
          Preflight
          <InfoTip tip="Checks which AI engines are installed and authenticated before dispatching. Ensures agents can actually run." />
        </span>
        <button
          class="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
          :disabled="preflightLoading"
          @click="runPreflight"
        >{{ preflightLoading ? "checking…" : "re-check" }}</button>
      </div>

      <!-- Loading skeleton -->
      <div v-if="preflightLoading && !preflightResult" class="flex gap-2">
        <span
          v-for="i in 3"
          :key="i"
          class="h-5 w-16 rounded bg-neutral-700/60 animate-pulse"
        />
      </div>

      <!-- Engine readiness badges -->
      <div v-else-if="preflightResult" class="flex flex-wrap gap-2">
        <span
          v-for="r in preflightResult.readiness"
          :key="r.engine"
          class="inline-flex items-center gap-1 text-xs font-mono"
          :class="r.level === 'ready' ? 'text-neutral-300' : 'text-neutral-600'"
          :title="r.level === 'ready' ? 'Ready' : (r.detail ? r.detail.split('\n')[0]?.slice(0,120) : 'Engine not available — install or authenticate to use')"
        >
          <span>{{ r.level === "ready" ? "✓" : "✗" }}</span>
          <span>{{ r.engine }}</span>
        </span>
        <span
          v-if="!preflightResult.anyReady"
          class="text-xs text-neutral-500 flex items-center gap-1"
        >
          ⚠ No engine ready — agents cannot run. Install claude, codex, or copilot CLI.
        </span>
      </div>

      <div v-if="preflightErr" class="flex items-start gap-1.5 text-xs text-red-300 mt-1" role="alert" aria-live="assertive">
        <span class="shrink-0">⚠</span><span>{{ preflightErr }}</span>
      </div>
    </div>

    <!-- Engine indicator — label changes based on run state -->
    <div v-if="units.length" class="flex items-center gap-2">
      <span class="text-[11px] text-neutral-600">{{ anyRunning ? 'running with' : 'dispatched to' }}</span>
      <span class="text-[11px] font-mono text-neutral-400">{{ engine }}</span>
    </div>

    <!-- Hook approval modal: surfaces require_approval hooks during dispatch -->
    <HookApprovalModal />

    <!-- Work unit table -->
    <WorkUnitTable :units="units" empty-text="No tasks yet — click Run agents to start." />

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
        <span class="text-neutral-200 font-medium">${{ fmtCost(totals.cost_usd) }}</span>
      </span>
      <span v-if="anyRunning" class="ml-auto flex items-center gap-1.5 text-neutral-500">
        <span class="inline-block w-1.5 h-1.5 rounded-full bg-white/50 animate-pulse"></span>
        {{ units.filter(u=>u.status==='running').length }} running
      </span>
    </div>

    <!-- Action row -->
    <div class="flex items-center gap-2 pt-1">
      <button
        class="btn-primary"
        :disabled="orchestrating || anyRunning"
        :title="orchestrating ? 'Agents are being assigned — please wait' : anyRunning ? 'Agents are running — wait for completion' : 'Assign pending units to agents and start them running'"
        @click="orchestrate"
      >
        {{ orchestrating ? "Running…" : orchestrated ? "✓ Agents assigned" : "Run agents" }}
      </button>

      <!-- Hint: how to stop a running agent -->
      <span v-if="anyRunning" class="text-[10px] text-neutral-700 ml-1">
        To stop: <kbd class="font-mono">Ctrl+C</kbd> in the terminal
      </span>

      <!-- CTA when all done or blocked -->
      <button
        v-if="canAdvance"
        class="px-4 py-2 rounded text-sm font-medium transition-colors"
        :class="[allDone ? 'border border-neutral-700 text-neutral-200 hover:border-neutral-500 hover:text-white' : 'border border-neutral-800 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300', pulsingNext ? 'ring-2 ring-green-500 ring-offset-1 ring-offset-neutral-950' : '']"
        @click="store.setStage(4)"
      >
        {{ allDone ? "Next: Verify →" : "Verify anyway →" }}
      </button>
    </div>

    <div v-if="err" class="flex items-start gap-2 p-3 rounded border border-red-900/60 text-red-400 text-xs" role="alert" aria-live="assertive">
      <span class="mt-0.5 shrink-0">⚠</span><span>{{ err }}</span>
    </div>

    <Transition name="toast">
      <div
        v-if="toastVisible"
        class="fixed bottom-6 right-6 z-50 px-4 py-2 rounded-lg bg-green-900/90 text-green-200 text-sm font-medium shadow-lg border border-green-700 cursor-pointer"
        @click="toastVisible = false"
      >{{ toastMsg }}</div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { api } from "../api.js";
import { usePoller } from "../composables/usePoller.js";
import { useVfStore } from "../store.js";
import type { Engine } from "../types.js";
import HookApprovalModal from "./HookApprovalModal.vue";
import InfoTip from "./InfoTip.vue";
import WorkUnitTable from "./WorkUnitTable.vue";

// ── Types ──────────────────────────────────────────────────────────────────
interface EngineReadiness {
  engine: string;
  level: string;
  detail: string;
  checkedAt: string;
}
interface PreflightResult {
  ok: boolean;
  readiness: EngineReadiness[];
  anyReady: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────
// ponytail: ENGINES listed here for reference; engine is auto-derived from dispatched units

// ── Store & state ──────────────────────────────────────────────────────────
const store = useVfStore();

const engine = computed<Engine>(() => {
  const agents = store.state?.work_units?.map((u) => u.owner_agent).filter(Boolean) ?? [];
  const first = agents[0];
  if (first === "codex" || first === "copilot") return first;
  return "claude";
});
const orchestrating = ref(false);
const orchestrated = ref(false); // brief confirmation flash
const err = ref<string | null>(null);
const toastVisible = ref(false);
const toastMsg = ref("");
const pulsingNext = ref(false);

// ── Preflight ──────────────────────────────────────────────────────────────
const preflightLoading = ref(false);
const preflightResult = ref<PreflightResult | null>(null);
const preflightErr = ref<string | null>(null);

async function runPreflight() {
  preflightLoading.value = true;
  preflightErr.value = null;
  try {
    preflightResult.value = (await api.preflight()) as PreflightResult;
  } catch (e) {
    preflightErr.value = String(e);
  } finally {
    preflightLoading.value = false;
  }
}

onMounted(runPreflight);

// ── Derived state from store ───────────────────────────────────────────────
const units = computed(() => store.state?.work_units ?? []);
const totals = computed(
  () => store.state?.totals ?? { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
);
const anyRunning = computed(() => units.value.some((u) => u.status === "running"));
const allDone = computed(
  () => units.value.length > 0 && units.value.every((u) => u.status === "done"),
);
const canAdvance = computed(
  () =>
    units.value.length > 0 &&
    units.value.every((u) => u.status === "done" || u.status === "blocked"),
);

// ── Live polling while any unit is running ─────────────────────────────────
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

// Auto-advance to Verify when all units are done
watch(allDone, (v) => {
  if (v) store.setStage(4);
});

watch(allDone, (val, old) => {
  if (val && !old && units.value.length > 0) {
    const secs = totals.value.wall_seconds;
    toastMsg.value = `✓ All agents complete${secs > 0 ? ` (${secs}s)` : ""}`;
    toastVisible.value = true;
    pulsingNext.value = true;
    setTimeout(() => {
      toastVisible.value = false;
    }, 5000);
    setTimeout(() => {
      pulsingNext.value = false;
    }, 3000);
  }
});

// ── Orchestrate ────────────────────────────────────────────────────────────
async function orchestrate() {
  orchestrating.value = true;
  err.value = null;
  try {
    await api.orchestrate({ engine: engine.value, dry: false });
    await store.loadState();
    orchestrated.value = true;
    setTimeout(() => {
      orchestrated.value = false;
    }, 2000);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    orchestrating.value = false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
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

<style scoped>
.toast-enter-active, .toast-leave-active { transition: all 0.3s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(0.5rem); }
</style>
