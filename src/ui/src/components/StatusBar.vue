<template>
  <footer class="flex items-center gap-0 px-4 h-8 border-t border-neutral-800/40 bg-neutral-950 shrink-0 overflow-hidden">
    <!-- Stats — only show when there's actual state -->
    <div v-if="store.state" class="flex items-center gap-4 text-[11px] font-mono text-neutral-500">
      <span class="flex items-center gap-1.5">
        <span>units</span>
        <span class="tabular-nums text-neutral-400">
          {{ store.state.totals.done }}<span class="text-neutral-700">/</span>{{ store.state.totals.units }}
        </span>
      </span>
      <template v-if="store.state.totals.tokens > 0">
        <span class="w-px h-3 bg-neutral-800/80" />
        <span class="flex items-center gap-1.5">
          <span>tokens</span>
          <span class="tabular-nums text-neutral-400">{{ fmtNum(store.state.totals.tokens) }}</span>
        </span>
        <span class="w-px h-3 bg-neutral-800/80" />
        <span class="flex items-center gap-1.5">
          <span>cost</span>
          <span class="tabular-nums text-neutral-400">${{ fmtCost(store.state.totals.cost_usd) }}</span>
        </span>
      </template>
      <!-- Confidence — only when meaningful -->
      <template v-if="confidence !== null">
        <span class="w-px h-3 bg-neutral-800/80" />
        <span
          class="tabular-nums flex items-center gap-1"
          :class="confidence >= 0.5 ? 'text-neutral-500' : 'text-red-400'"
          title="Average agent confidence score"
        >
          <span class="text-neutral-700">confidence</span>
          {{ Math.round(confidence * 100) }}%
        </span>
      </template>
    </div>
    <div v-else class="text-[11px] font-mono text-neutral-700">
      No active task
    </div>

    <div class="flex-1" />

    <!-- Running indicator with elapsed time -->
    <div v-if="anyRunning" class="flex items-center gap-1.5 text-[11px] font-mono text-neutral-600">
      <span class="w-1.5 h-1.5 rounded-full bg-white/50 animate-pulse" />
      <span>running{{ elapsed ? ` ${elapsed}` : '' }}</span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { WORK_UNIT_STATUS } from "../../../core/workflow-contract.js";
import { useVfStore } from "../store.js";

const store = useVfStore();

function fmtNum(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function fmtCost(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

/** Average confidence from work units — type-safe, no `as any` */
const confidence = computed<number | null>(() => {
  const units = store.state?.work_units;
  if (!units?.length) return null;
  const withConf = units.filter(
    (u) => u.confidence !== null && u.confidence !== undefined && u.confidence > 0,
  );
  if (!withConf.length) return null;
  return withConf.reduce((sum, u) => sum + (u.confidence ?? 0), 0) / withConf.length;
});

const anyRunning = computed(
  () => store.state?.work_units?.some((u) => u.status === WORK_UNIT_STATUS.RUNNING) ?? false,
);

// Elapsed time counter while running
const elapsedSecs = ref(0);
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

watch(anyRunning, (running) => {
  if (running) {
    elapsedSecs.value = 0;
    elapsedTimer = setInterval(() => {
      elapsedSecs.value++;
    }, 1000);
  } else {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }
});

onUnmounted(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
});

const elapsed = computed(() => {
  if (!elapsedSecs.value) return "";
  const m = Math.floor(elapsedSecs.value / 60);
  const s = elapsedSecs.value % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
});
</script>
