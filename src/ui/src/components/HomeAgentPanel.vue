<template>
  <section v-if="rows.length" class="home-agent-panel" aria-label="Agents in this conversation">
    <p class="home-agent-panel__head">
      <span>Agents</span>
      <span class="home-agent-panel__count" role="status">{{ countSummary }}</span>
    </p>
    <ul>
      <li v-for="row in rows" :key="row.participantId">
        <button type="button" class="home-agent-row" :class="`home-agent-row--${row.status}`"
                :aria-label="rowAria(row)" @click="$emit('select', row.participantId)">
          <span class="home-agent-row__icon" aria-hidden="true">
            <span v-if="row.status === 'working'" class="home-busy-signal"><i /><i /><i /></span>
            <template v-else-if="row.status === 'complete'">✓</template>
            <template v-else-if="row.status === 'failed'">✕</template>
            <template v-else>·</template>
          </span>
          <span class="home-agent-row__label">{{ row.label }}</span>
          <span class="home-agent-row__action">{{ row.latestAction ?? "" }}</span>
          <span class="home-agent-row__clock" aria-hidden="true">{{ clock(row) }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { type AgentPresenceRow, liveElapsedMs } from "../lib/agent-presence.js";
import { formatTurnElapsed } from "../lib/turn-timing.js";

const props = defineProps<{ rows: readonly AgentPresenceRow[] }>();
defineEmits<{ select: [participantId: string] }>();

const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
const stop = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
watch(
  () => props.rows.some((row) => row.status === "working"),
  (working) => {
    stop();
    if (working)
      timer = setInterval(() => {
        nowMs.value = Date.now();
      }, 1000);
  },
  { immediate: true },
);
onUnmounted(stop);

const clock = (row: AgentPresenceRow) => {
  const ms = liveElapsedMs(row, nowMs.value);
  return ms == null ? "" : formatTurnElapsed(ms);
};
const countSummary = computed(() => {
  const working = props.rows.filter((row) => row.status === "working").length;
  const done = props.rows.filter((row) => row.status === "complete").length;
  return [working ? `${working} running` : "", done ? `${done} done` : ""]
    .filter(Boolean)
    .join(" · ");
});
const rowAria = (row: AgentPresenceRow) =>
  `${row.label}: ${row.status}${row.latestAction ? ` — ${row.latestAction}` : ""}`;
</script>
