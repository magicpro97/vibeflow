<template>
  <aside class="flex flex-col h-full bg-neutral-950" @keydown.esc="store.logsOpen = false">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 h-9 border-b border-neutral-800/40 shrink-0">
      <span class="text-[11px] text-neutral-500 font-medium">Logs</span>
      <button
        class="text-[10px] font-mono text-neutral-700 hover:text-neutral-300 transition-colors duration-150 px-1.5 py-0.5 rounded"
        aria-label="Clear all logs"
        @click="clearLogs()"
      >
        clear
      </button>
    </div>

    <!-- SSE reconnecting banner -->
    <div
      v-if="sseError"
      class="flex items-center gap-1.5 px-3 py-1.5 border-b border-yellow-800/30 text-yellow-500/70 text-[10px] font-mono shrink-0"
      role="status"
    >
      <span class="animate-pulse select-none">~</span>
      <span>{{ sseError }}</span>
    </div>

    <!-- Scroll area -->
    <div ref="scrollEl" class="flex-1 overflow-y-auto py-1 relative" @scroll="onScroll">
      <ul>
        <template v-for="item in eventsWithDividers" :key="item.type === 'divider' ? `div-${item.ts}` : item.event.seq">
          <li v-if="item.type === 'divider'" class="text-[10px] text-neutral-700 text-center py-1 border-t border-neutral-800/50 select-none">
            ── {{ formatDividerTime(item.ts) }} ──
          </li>
          <li
            v-else
            class="flex items-baseline gap-1.5 px-3 py-0.5 font-mono text-[11px] leading-[1.6] hover:bg-white/[0.02]"
          >
            <!-- Timestamp -->
            <span class="text-neutral-700 select-none tabular-nums shrink-0">{{ fmtTime(item.event.ts) }}</span>
            <!-- Channel badge — friendly names -->
            <span
              class="shrink-0 text-[10px]"
              :class="channelTextClass(item.event.channel)"
            >{{ channelLabel(item.event.channel) }}</span>
            <!-- Message -->
            <span class="min-w-0 break-all" :class="levelClass(item.event.level)">{{ item.event.text }}</span>
          </li>
        </template>
      </ul>
      <div v-if="eventsWithDividers.length === 0" class="px-3 py-3 text-[11px] text-neutral-700 italic font-mono space-y-1">
        <p>No logs yet</p>
        <p class="not-italic text-neutral-800">Go to Run and click "Run agents" — logs appear as the engine executes.</p>
      </div>
      <!-- Scroll to bottom button — appears when user has scrolled up -->
      <button
        v-if="isScrolledUp && eventsWithDividers.length > 0"
        class="sticky bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2.5 py-1 rounded border border-neutral-700 bg-neutral-900 text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors shadow-lg"
        aria-label="Scroll to latest logs"
        @click="scrollToBottom"
      >↓ latest</button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useSSE } from "../composables/useSSE.js";
import { useVfStore } from "../store.js";
import type { LogEvent, LogLevel } from "../types.js";

const store = useVfStore();
const { logs, error: sseError, clearLogs } = useSSE("/api/logs/stream");

type LogItem = { type: "event"; event: LogEvent } | { type: "divider"; ts: number };
const eventsWithDividers = computed((): LogItem[] => {
  const result: LogItem[] = [];
  for (let i = 0; i < logs.value.length; i++) {
    const ev = logs.value[i];
    if (!ev) continue;
    const prev = logs.value[i - 1];
    if (prev && ev.ts - prev.ts > 60_000) {
      result.push({ type: "divider", ts: ev.ts });
    }
    result.push({ type: "event", event: ev });
  }
  return result;
});
function formatDividerTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
const scrollEl = ref<HTMLElement | null>(null);
const isScrolledUp = ref(false);

function onScroll() {
  const el = scrollEl.value;
  if (!el) return;
  // Consider "at bottom" if within 60px of bottom
  isScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight > 60;
}

function scrollToBottom() {
  scrollEl.value?.scrollTo(0, scrollEl.value.scrollHeight);
  isScrolledUp.value = false;
}

// Debounced scroll — batches rapid log bursts into a single scroll operation.
// Without this, 100 SSE events/sec = 100 DOM reflows + 100 scrollTo calls.
let scrollTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleScroll() {
  if (isScrolledUp.value) return; // user scrolled up — don't yank them down
  if (scrollTimer) return; // already pending — skip
  scrollTimer = setTimeout(() => {
    scrollTimer = null;
    nextTick(() => scrollEl.value?.scrollTo(0, scrollEl.value.scrollHeight));
  }, 80); // 80ms — invisible to user, catches bursts up to ~12 events
}
watch(() => logs.value.length, scheduleScroll);
onUnmounted(() => {
  if (scrollTimer) clearTimeout(scrollTimer);
});

function fmtTime(ts: number) {
  return new Date(ts).toTimeString().slice(0, 8);
}

function levelClass(level: LogLevel) {
  return (
    {
      info: "text-neutral-400",
      warn: "text-amber-400/70",
      error: "text-red-400/80",
      debug: "text-neutral-600",
    }[level] ?? "text-neutral-500"
  );
}

function channelLabel(channel: string) {
  const labels: Record<string, string> = {
    vf: "vf",
    "engine-stdout": "agent",
    "engine-stderr": "agent:err",
    hook: "hook",
    user: "user",
  };
  return labels[channel] ?? channel;
}

function channelTextClass(channel: string) {
  const map: Record<string, string> = {
    vf: "text-neutral-300",
    "engine-stdout": "text-neutral-500",
    "engine-stderr": "text-red-400/70",
    hook: "text-amber-400/70",
  };
  return map[channel] ?? "text-neutral-600";
}
</script>
