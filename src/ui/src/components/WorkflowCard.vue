<template>
  <button
    class="text-left px-2.5 py-1.5 rounded border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 max-w-72"
    :class="selected ? 'border-neutral-600 bg-neutral-800/50' : 'border-neutral-800 bg-neutral-900/30 hover:border-neutral-700'"
    role="tab"
    :aria-current="selected ? 'true' : undefined"
    :aria-label="`${item.repoName} — ${item.taskId} — ${item.status}`"
    @click="$emit('select')"
  >
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="shrink-0 w-2 h-2 rounded-full" :class="statusDot" />
        <span class="text-[11px] font-mono text-neutral-200 truncate">{{ item.repoName }}</span>
      </div>
      <span class="text-[10px] font-mono text-neutral-600 shrink-0">{{ item.taskId }}</span>
    </div>
    <div class="flex items-center gap-2 mt-1 text-[10px] text-neutral-600 font-mono">
      <span>{{ item.totals.done }}/{{ item.totals.units }}</span>
      <span v-if="runningCount > 0" class="text-blue-400">{{ runningCount }} running</span>
      <span v-if="blockedCount > 0" class="text-red-400">{{ blockedCount }} blocked</span>
    </div>
    <div class="text-[10px] text-neutral-700 truncate mt-0.5 max-w-64" :title="item.goal">{{ item.goal }}</div>
    <div v-if="item.latestEvent" class="text-[9px] text-neutral-700 font-mono mt-0.5 truncate">
      {{ fmtTime(item.latestEvent.ts) }}
    </div>
  </button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { WORKFLOW_DASHBOARD_STATUS, WORK_UNIT_STATUS } from "../../../core/workflow-contract.js";
import type { WorkflowDashboardItem } from "../types.js";

const props = defineProps<{
  item: WorkflowDashboardItem;
  selected?: boolean;
}>();

defineEmits<{ select: [] }>();

const runningCount = computed(
  () =>
    props.item.workUnits.filter(
      (u) => u.status === WORK_UNIT_STATUS.RUNNING || u.status === WORK_UNIT_STATUS.VERIFYING,
    ).length,
);
const blockedCount = computed(
  () => props.item.workUnits.filter((u) => u.status === WORK_UNIT_STATUS.BLOCKED).length,
);

function fmtTime(ts: number) {
  return new Date(ts).toTimeString().slice(0, 8);
}

const statusDot = computed(() => {
  const s = props.item.status;
  if (s === WORKFLOW_DASHBOARD_STATUS.RUNNING) return "bg-blue-400 animate-pulse";
  if (s === WORKFLOW_DASHBOARD_STATUS.BLOCKED) return "bg-red-500";
  if (s === WORKFLOW_DASHBOARD_STATUS.DONE) return "bg-emerald-500";
  return "bg-neutral-600";
});
</script>
