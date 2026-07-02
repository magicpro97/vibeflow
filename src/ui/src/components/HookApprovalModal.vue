<template>
  <div v-if="pending.length" class="fixed inset-0 z-50 flex flex-col items-end justify-end p-6 gap-3 pointer-events-none">
    <div
      v-for="hook in pending"
      :key="hook.id"
      class="pointer-events-auto w-96 rounded-xl border p-4 space-y-3 shadow-2xl"
      :class="borderClass(hook.result.risk)"
    >
      <div class="flex items-center justify-between">
        <span class="text-xs font-bold flex items-center gap-2">
          <span :class="riskDot(hook.result.risk)">●</span>
          Hook requires approval
          <span class="font-mono opacity-60 text-[10px]">{{ hook.result.risk }}</span>
        </span>
      </div>
      <p v-if="hook.input.tool || hook.input.command" class="text-[11px] font-mono opacity-80 break-all">
        {{ hook.input.tool }}{{ hook.input.command ? `: ${hook.input.command}` : "" }}
      </p>
      <ul class="space-y-0.5">
        <li v-for="r in hook.result.reasons" :key="r" class="text-[11px] opacity-70">· {{ r }}</li>
      </ul>
      <div class="flex gap-2 pt-1">
        <button
          class="flex-1 px-3 py-1.5 rounded text-xs bg-green-800 hover:bg-green-700 text-green-100 transition-colors"
          @click="approve(hook.id, 'allow')"
        >Allow once</button>
        <button
          class="flex-1 px-3 py-1.5 rounded text-xs bg-red-900 hover:bg-red-800 text-red-200 transition-colors"
          @click="approve(hook.id, 'block')"
        >Block</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { api } from "../api.js";
import type { HookLogPayload } from "../types.js";

interface PendingHook {
  id: string;
  input: { tool?: string; command?: string; files?: string[] };
  result: { risk: string; reasons: string[]; decision: string };
}

const pending = ref<PendingHook[]>([]);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchPending() {
  try {
    const r = await api.hook.pending();
    pending.value = r.pending as PendingHook[];
  } catch {
    /* silent — server may not have hooks pending */
  }
}

async function approve(id: string, decision: "allow" | "block") {
  try {
    await api.hook.approve(id, decision);
    pending.value = pending.value.filter((h) => h.id !== id);
  } catch {
    /* silent */
  }
}

onMounted(() => {
  fetchPending();
  pollTimer = setInterval(fetchPending, 2000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

function borderClass(risk: string): string {
  if (risk === "critical") return "border-red-700 bg-red-950/80 text-red-100";
  if (risk === "high") return "border-orange-700 bg-orange-950/80 text-orange-100";
  if (risk === "medium") return "border-yellow-700 bg-yellow-950/60 text-yellow-100";
  return "border-neutral-700 bg-neutral-900/90 text-neutral-300";
}

function riskDot(risk: string): string {
  if (risk === "critical") return "text-red-400";
  if (risk === "high") return "text-orange-400";
  if (risk === "medium") return "text-yellow-400";
  return "text-neutral-500";
}
</script>
