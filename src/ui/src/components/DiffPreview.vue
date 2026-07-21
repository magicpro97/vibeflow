<template>
  <div v-if="error" class="flex items-start gap-2 p-3 rounded border border-red-900/60 text-red-400 text-xs" role="alert">
    <span>⚠</span><span>{{ error }}</span>
  </div>
  <div v-else-if="loading" class="text-xs text-neutral-600 py-2">Loading diff…</div>
  <div v-else-if="!response" class="text-xs text-neutral-700 italic py-2">No diff data</div>
  <div v-else class="space-y-3">
    <!-- Baseline label -->
    <div class="flex items-center gap-2 text-[11px] text-neutral-600 font-mono">
      <span class="text-neutral-500">Baseline:</span>
      <span class="text-neutral-400">{{ response.summary.baselineLabel }}</span>
    </div>

    <!-- Workflow-level summary -->
    <div class="flex flex-wrap items-center gap-3 text-xs font-mono">
      <span class="text-neutral-300">{{ response.summary.files.length }} file{{ response.summary.files.length !== 1 ? 's' : '' }} changed</span>
      <span v-if="response.summary.totalAdded > 0" class="text-emerald-400">+{{ response.summary.totalAdded }}</span>
      <span v-if="response.summary.totalDeleted > 0" class="text-red-400">-{{ response.summary.totalDeleted }}</span>
      <span v-if="response.summary.untracked.length > 0" class="text-amber-400">
        {{ response.summary.untracked.length }} untracked
      </span>
    </div>

    <!-- Summary truncated hint -->
    <div v-if="response.summary.truncated" class="text-[10px] text-amber-400 italic">
      Summary truncated — Run git diff locally for full output
    </div>

    <!-- File list -->
    <div v-if="response.summary.files.length > 0 || response.summary.untracked.length > 0" class="border border-neutral-800 rounded divide-y divide-neutral-800/50">
      <div
        v-for="f in response.summary.files" :key="f.path"
        class="flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono hover:bg-white/[0.02]"
      >
        <span class="w-6 shrink-0 text-[10px]" :class="statusClass(f.status)">{{ statusLabel(f.status) }}</span>
        <span v-if="f.isBinary" class="text-neutral-700 shrink-0 text-[10px]">[binary]</span>
        <span class="text-neutral-400 truncate flex-1" :title="f.path">{{ f.path }}</span>
        <span v-if="!f.isBinary && (f.added > 0 || f.deleted > 0)" class="text-[10px] shrink-0">
          <span v-if="f.added > 0" class="text-emerald-500">+{{ f.added }}</span>
          <span v-if="f.deleted > 0" class="text-red-500 ml-1">-{{ f.deleted }}</span>
        </span>
      </div>
      <div
        v-for="u in response.summary.untracked" :key="'u-' + u"
        class="flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono hover:bg-white/[0.02]"
      >
        <span class="w-6 shrink-0 text-[10px] text-amber-500">??</span>
        <span class="text-neutral-400 truncate flex-1" :title="u">{{ u }}</span>
        <span class="text-amber-500/60 text-[10px]">untracked</span>
      </div>
    </div>

    <!-- Work-unit diff -->
    <div v-if="response.unitDiff" class="border border-neutral-800 rounded overflow-hidden">
      <div class="flex items-center gap-2 px-3 py-2 border-b border-neutral-800/40 bg-neutral-900/50">
        <span class="text-xs font-mono text-neutral-300">{{ response.unitDiff.unit }}</span>
        <span v-if="response.unitDiff.truncated" class="text-[10px] text-amber-400 ml-auto" title="Diff capped at 200 KiB / 2000 lines. Run git diff locally for the full output.">truncated</span>
      </div>
      <div v-if="!response.unitDiff.hasDiff" class="px-3 py-2 text-xs text-neutral-700 italic">
        <span v-if="response.unitDiff.reason === 'no-diff'">No changes in this unit's scope</span>
        <span v-else-if="response.unitDiff.reason === 'binary'">All files in scope are binary — diff not shown</span>
        <span v-else-if="response.unitDiff.reason === 'no baseline'">No baseline available for comparison</span>
        <span v-else>No diff available</span>
      </div>
      <div v-else-if="response.unitDiff.files.length > 0" class="divide-y divide-neutral-800/40">
        <div
          v-for="f in response.unitDiff.files" :key="f.path"
          class="flex items-center gap-2 px-3 py-1.5 text-[11px] font-mono hover:bg-white/[0.02]"
        >
          <span class="w-6 shrink-0 text-[10px]" :class="statusClass(f.status)">{{ statusLabel(f.status) }}</span>
          <span v-if="f.isBinary" class="text-neutral-700 shrink-0 text-[10px]">[binary]</span>
          <span class="text-neutral-400 truncate flex-1" :title="f.path">{{ f.path }}</span>
          <span v-if="!f.isBinary && (f.added > 0 || f.deleted > 0)" class="text-[10px] shrink-0">
            <span v-if="f.added > 0" class="text-emerald-500">+{{ f.added }}</span>
            <span v-if="f.deleted > 0" class="text-red-500 ml-1">-{{ f.deleted }}</span>
          </span>
        </div>
      </div>
      <!-- Unified diff text -->
      <div v-if="response.unitDiff.hasDiff && response.unitDiff.diff" class="border-t border-neutral-800/40">
        <pre class="px-3 py-2 text-[10px] font-mono text-neutral-300 overflow-x-auto max-h-80 whitespace-pre-wrap leading-relaxed">{{ response.unitDiff.diff }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api.js";
import type { DashboardSelection, DiffResponse } from "../types.js";

const props = defineProps<{
  selection: DashboardSelection | null;
}>();

const loading = ref(false);
const error = ref<string | null>(null);
const response = ref<DiffResponse | null>(null);
let diffAbort: AbortController | null = null;

function statusLabel(s: string): string {
  const map: Record<string, string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    copied: "C",
    unmerged: "U",
    "type-changed": "T",
  };
  return map[s] ?? s;
}

function statusClass(s: string): string {
  if (s === "added" || s === "copied") return "text-emerald-500";
  if (s === "deleted") return "text-red-500";
  if (s === "modified" || s === "type-changed") return "text-blue-400";
  if (s === "renamed") return "text-amber-400";
  return "text-neutral-600";
}

async function fetchDiff() {
  if (!props.selection) return;
  diffAbort?.abort();
  diffAbort = new AbortController();
  const signal = diffAbort.signal;
  loading.value = true;
  error.value = null;
  try {
    response.value = await api.dashboard.diff(props.selection, signal);
  } catch (e) {
    if (signal.aborted) return;
    error.value = (e as Error).message;
    response.value = null;
  } finally {
    if (!signal.aborted) loading.value = false;
  }
}

watch(() => props.selection, fetchDiff, { deep: true });
onMounted(fetchDiff);
</script>
