<template>
  <aside class="w-64 flex-shrink-0 border-r border-neutral-800/40 bg-neutral-950/50 flex flex-col overflow-y-auto" role="complementary" aria-label="Plan revisions">
    <div class="px-3 py-2 border-b border-neutral-800/40">
      <h2 class="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">Revisions</h2>
    </div>

    <div v-if="revisions.length" class="flex-1 space-y-0.5 p-2">
      <button
        v-for="rev in revisions" :key="rev.id"
        type="button"
        class="w-full text-left px-2 py-1.5 rounded text-[11px] font-mono transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
        :class="rev.id === activeId
          ? 'bg-white/10 text-neutral-200'
          : 'text-neutral-500 hover:text-neutral-300 hover:bg-white/[0.03]'"
        :aria-label="`Revision ${rev.id.slice(0,8)} by ${rev.createdBy.name}`"
        :aria-current="rev.id === activeId ? 'true' : undefined"
        @click="emit('select', rev.id)"
      >
        <span class="block truncate">{{ rev.createdBy.name }}</span>
        <span class="block text-[10px] text-neutral-700 mt-px">{{ fmtTime(rev.createdAt) }}</span>
      </button>
    </div>

    <div v-if="!revisions.length" class="flex-1 flex flex-col gap-3 p-4">
      <p class="text-[11px] text-neutral-600">No plan revision yet. Paste or write the plan content below.</p>
      <textarea
        v-model="planText"
        rows="8"
        placeholder="Plan content…"
        class="input-base w-full resize-y text-[11px] font-mono"
      />
      <button
        type="button"
        class="btn-secondary text-xs self-start"
        :disabled="!planText.trim() || creating"
        @click="create"
      >
        {{ creating ? 'Creating…' : 'Create plan revision' }}
      </button>
    </div>

    <div v-if="activeId && anchor" class="px-3 py-2 border-t border-neutral-800/40">
      <p class="text-[10px] text-neutral-600">Comment anchor ready</p>
      <p class="text-[10px] font-mono text-neutral-500 truncate mt-0.5">{{ anchor.blockId }}: "{{ anchor.quote.slice(0,40) }}"</p>
      <p class="text-[10px] text-neutral-700 mt-1 italic">Comment storage not implemented</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { BlockAnchor } from "../lib/plan-anchor.js";
import type { PlanRevision } from "../types.js";

defineProps<{
  revisions: PlanRevision[];
  activeId: string | null;
  anchor: BlockAnchor | null;
  creating: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  create: [plan: string];
}>();

const planText = ref("");

function create() {
  if (!planText.value.trim()) return;
  emit("create", planText.value);
}

function fmtTime(ts: number | string): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
</script>
