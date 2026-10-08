<template>
  <span v-if="elapsed === null && !complete" class="home-thinking"><i /><i /><i /><span class="sr-only">Thinking</span></span>
  <span v-else-if="elapsed !== null" class="home-turn-status" role="status">
    {{ complete ? `Worked for ${formatted}` : `Working · ${formatted}` }}
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { formatTurnElapsed, turnElapsedMs } from "../lib/turn-timing.js";

const props = defineProps<{
  startedAt: string | null;
  finishedAt: string | null;
  complete: boolean;
}>();

const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

function stop(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
function start(): void {
  stop();
  timer = setInterval(() => {
    nowMs.value = Date.now();
  }, 1000);
}

// The SAME component instance can flip complete false→true (Vue reuses it because
// the item key is stable), so the interval must react to the prop, not just run
// once at setup — otherwise a finished turn keeps ticking forever.
watch(
  () => [props.complete, props.startedAt] as const,
  () => {
    if (props.complete || !props.startedAt) stop();
    else start();
  },
  { immediate: true },
);
onBeforeUnmount(stop);

const elapsed = computed(() =>
  turnElapsedMs(
    { startedAt: props.startedAt, finishedAt: props.complete ? props.finishedAt : null },
    nowMs.value,
  ),
);
const formatted = computed(() => (elapsed.value === null ? "" : formatTurnElapsed(elapsed.value)));
</script>
