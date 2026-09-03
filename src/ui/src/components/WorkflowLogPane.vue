<template>
  <aside class="flex flex-col h-full bg-neutral-950">
    <div class="flex items-center justify-between px-3 h-9 border-b border-neutral-800/40 shrink-0">
      <span class="text-[11px] text-neutral-500 font-medium">Workflow Logs</span>
      <div class="flex items-center gap-2">
        <button
          class="text-[10px] font-mono transition-colors px-1.5 py-0.5 rounded"
          :class="filter === 'all' ? 'text-neutral-300' : 'text-neutral-700 hover:text-neutral-300'"
          @click="filter = 'all'"
        >All</button>
        <button
          v-if="selectedUnit"
          class="text-[10px] font-mono transition-colors px-1.5 py-0.5 rounded"
          :class="filter === 'unit' ? 'text-neutral-300' : 'text-neutral-700 hover:text-neutral-300'"
          @click="filter = 'unit'"
        >Unit</button>
      </div>
    </div>
    <div class="flex-1 overflow-y-auto py-1">
      <ul>
        <li
          v-for="ev in filtered"
          :key="ev.seq"
          class="flex items-baseline gap-1.5 px-3 py-0.5 font-mono text-[11px] leading-[1.6] hover:bg-white/[0.02]"
        >
          <span class="text-neutral-700 select-none tabular-nums shrink-0">{{ fmtTime(ev.ts) }}</span>
          <span class="text-[10px] text-neutral-600 shrink-0 font-mono">{{ ev.workflowId ?? '' }}</span>
          <span v-if="ev.unit" class="text-[10px] text-amber-400/60 shrink-0">/{{ ev.unit }}</span>
          <span class="text-[10px] shrink-0" :class="channelClass(ev.channel)">{{ channelLabel(ev.channel) }}</span>
          <span class="min-w-0 break-all" :class="levelClass(ev.level)">{{ ev.text }}</span>
        </li>
      </ul>
      <div v-if="filtered.length === 0" class="px-3 py-3 text-[11px] text-neutral-700 italic font-mono">No matching logs</div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { logChannelClass, logChannelLabel, logLevelClass } from "../lib/log-presentation.js";
import type { LogEvent } from "../types.js";

const props = defineProps<{
  events: LogEvent[];
  selectedUnit?: string | null;
}>();

const filter = ref<"all" | "unit">("all");

const filtered = computed(() => {
  if (filter.value === "all" || !props.selectedUnit) return props.events;
  return props.events.filter((ev) => !ev.unit || ev.unit === props.selectedUnit);
});

function fmtTime(ts: number) {
  return new Date(ts).toTimeString().slice(0, 8);
}

const channelLabel = logChannelLabel;
const channelClass = logChannelClass;
const levelClass = logLevelClass;
</script>
