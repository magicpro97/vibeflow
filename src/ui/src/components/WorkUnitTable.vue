<template>
  <div class="overflow-x-auto">
    <!-- Empty state -->
    <div
      v-if="!props.units.length"
      class="flex flex-col items-center justify-center py-16 text-neutral-600 gap-3"
    >
      <svg class="w-7 h-7 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
      <span class="text-[11px] text-neutral-600">{{ props.emptyText ?? 'No tasks yet — go to Describe and submit a goal first' }}</span>
    </div>

    <table v-else class="w-full border-collapse">
      <thead>
        <tr class="border-b border-neutral-800/40">
          <th class="text-left py-2 pr-3 pl-3 text-[11px] text-neutral-600 font-medium"><span>Task</span><span class="text-neutral-600 font-normal ml-1">· click to expand</span></th>
          <th class="text-left py-2 pr-3 text-[11px] text-neutral-600 font-medium">Status</th>
          <th class="text-left py-2 pr-3 text-[11px] text-neutral-600 font-medium">
            <span class="flex items-center gap-0.5">Checks<InfoTip tip="build · lint · test · review results. White = passed, red = failed, dim = not run. Hover a dot for details." /></span>
          </th>
          <th class="text-right py-2 pr-2 text-[11px] text-neutral-600 font-medium">
            <span class="flex items-center justify-end gap-0.5">Conf<InfoTip tip="Confidence (0–100%). Computed from gate results (build · lint · test · review) — the agent's self-report can only CAP it, never raise it. Below the unit's risk threshold BLOCKS close." /></span>
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="u in props.units" :key="u.name">
          <!-- Main row -->
          <tr
            class="border-b border-neutral-800/40 cursor-pointer transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-inset"
            :class="[
              u.status === 'running' ? 'running-row' : 'hover:bg-white/[0.02]',
              expanded.has(u.name) ? 'bg-white/[0.02]' : '',
            ]"
            tabindex="0"
            role="button"
            :aria-expanded="expanded.has(u.name)"
            :aria-label="`${u.name} — click to ${expanded.has(u.name) ? 'collapse' : 'expand'} details`"
            @click="toggleExpand(u.name)"
            @keydown.enter.prevent="toggleExpand(u.name)"
            @keydown.space.prevent="toggleExpand(u.name)"
          >
            <!-- Unit name + confidence bar -->
            <td class="py-2.5 pr-3 pl-0">
              <div class="flex items-start gap-0">
                <!-- Running accent bar -->
                <div
                  class="w-0.5 self-stretch rounded-r mr-2 flex-shrink-0 transition-all"
                  :class="u.status === 'running' ? 'bg-white/20 running-border' : 'bg-transparent'"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-[12px] text-neutral-200 truncate max-w-48" :title="u.name">
                      {{ u.name }}
                    </span>
                    <!-- Owner agent tag -->
                    <span
                      v-if="u.owner_agent"
                      class="px-1.5 py-px rounded text-[10px] font-sans flex-shrink-0"
                      :class="unitColor(u.name)"
                    >
                      {{ u.owner_agent }}
                    </span>
                    <!-- Expand chevron -->
                    <svg
                      class="w-3 h-3 text-neutral-600 flex-shrink-0 transition-transform ml-auto mr-1"
                      :class="expanded.has(u.name) ? 'rotate-90' : ''"
                      fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"
                    >
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                    </svg>
                  </div>
                  <!-- Confidence bar — shows agent's self-reported quality score -->
                  <div
                    class="w-full h-0.5 bg-neutral-800 rounded-full overflow-hidden mt-1.5"
                    :title="u.confidence ? `Confidence: ${(u.confidence*100).toFixed(0)}%` : 'No confidence score yet'"
                  >
                    <!-- #524: transition-all animates BOTH width and bg-color on status change -->
                    <div
                      class="h-full transition-all duration-700"
                      :class="u.status === 'running' ? 'bg-white/40' : 'bg-neutral-600'"
                      :style="{ width: u.confidence ? `${Math.min(100, u.confidence * 100)}%` : '0%' }"
                    />
                  </div>
                </div>
              </div>
            </td>

            <!-- Status badge -->
            <td class="py-2.5 pr-3 align-top">
              <span
                class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
                :class="statusClass(u.status)"
              >
                <!-- Pulse dot for running -->
                <span
                  v-if="u.status === 'running'"
                  class="w-1.5 h-1.5 rounded-full bg-white/50 pulse-dot flex-shrink-0"
                />
                {{ u.status }}
              </span>
            </td>

            <!-- Gates: compact icon grid -->
            <td class="py-2.5 pr-3 align-top">
              <div class="flex items-center gap-1">
                <span
                  v-for="gate in GATE_KEYS"
                  :key="gate"
                  :title="`${gate}: ${u.gates[gate]}`"
                  class="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  :class="gateClass(u.gates[gate])"
                />
                <!-- Canary badge (ADR-005): knowledge-heavy units need a human canary to close -->
                <span
                  v-if="u.knowledge_heavy"
                  :title="u.canary
                    ? `canary: ${u.canary.file} (by ${u.canary.author})`
                    : 'knowledge-heavy — needs a human-authored *.canary.test.ts to close (ADR-005)'"
                  class="ml-1 px-1 py-0.5 rounded text-[9px] font-mono leading-none"
                  :class="u.canary
                    ? 'bg-emerald-950/40 border border-emerald-900/40 text-emerald-400'
                    : 'bg-amber-950/40 border border-amber-900/40 text-amber-400'"
                >{{ u.canary ? '🛡 canary' : '⚠ needs canary' }}</span>
                <!-- #545: calibrated judge score (0..1) when the reviewer-LLM scored this unit -->
                <span
                  v-if="typeof u.goal_score === 'number'"
                  :title="`judge score: ${u.goal_score.toFixed(2)} (calibrated P(goal met))`"
                  class="ml-1 px-1 py-0.5 rounded text-[9px] font-mono leading-none border"
                  :class="u.goal_score >= 0.85
                    ? 'bg-emerald-950/40 border-emerald-900/40 text-emerald-400'
                    : u.goal_score >= 0.5
                      ? 'bg-amber-950/40 border-amber-900/40 text-amber-400'
                      : 'bg-red-950/40 border-red-900/40 text-red-400'"
                >⚖ {{ u.goal_score.toFixed(2) }}</span>
              </div>
            </td>

            <!-- Confidence % -->
            <td class="py-2.5 align-top text-right pr-2">
              <span
                class="font-mono tabular-nums text-[11px]"
                :class="!u.confidence ? 'text-neutral-700'
                  : u.confidence >= 0.85 ? 'text-neutral-300'
                  : u.confidence >= 0.5 ? 'text-neutral-500' : 'text-red-400'"
              >
                {{ u.confidence ? `${(u.confidence * 100).toFixed(0)}%` : '—' }}
              </span>
            </td>
          </tr>

          <!-- Expanded detail row -->
          <tr
            v-if="expanded.has(u.name)"
            class="border-b border-neutral-800/40"
          >
            <td colspan="4" class="px-5 py-4 bg-neutral-900/30">
              <WorkUnitExpandedDetails :unit="u" :units="props.units" :timeline="timelines[u.name]" />
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../api.js";
import { unitColor } from "../lib/unit-color.js";
import type { GateState, TimelineEntry, WorkUnit } from "../types.js";
import InfoTip from "./InfoTip.vue";
import WorkUnitExpandedDetails from "./WorkUnitExpandedDetails.vue";

const props = defineProps<{ units: WorkUnit[]; emptyText?: string }>();
const GATE_KEYS = ["build", "lint", "test", "review"] as const;

const expanded = ref(new Set<string>());

// Prune stale names from expanded set when units change (prevents ghost expansion)
watch(
  () => props.units.map((u) => u.name),
  (names) => {
    const nameSet = new Set(names);
    const pruned = new Set([...expanded.value].filter((n) => nameSet.has(n)));
    if (pruned.size !== expanded.value.size) expanded.value = pruned;
  },
);

function toggleExpand(name: string) {
  if (expanded.value.has(name)) {
    expanded.value.delete(name);
  } else {
    expanded.value.add(name);
    fetchTimeline(name);
  }
  // trigger reactivity
  expanded.value = new Set(expanded.value);
}

// #557: per-unit status-transition ledger, fetched once when a row expands.
const timelines = ref<Record<string, TimelineEntry[]>>({});
async function fetchTimeline(name: string) {
  if (timelines.value[name]) return; // cached
  try {
    const res = await api.unitTimeline(name);
    if (res.ok) timelines.value = { ...timelines.value, [name]: res.timeline };
  } catch {
    /* a failed timeline fetch is non-fatal — the rest of the row still renders */
  }
}

function gateClass(g: GateState | undefined) {
  if (!g) return "bg-neutral-800/40 text-neutral-700";
  return (
    {
      pass: "bg-white/70",
      fail: "bg-red-500/60",
      running: "bg-white/30 animate-pulse",
      pending: "bg-neutral-700",
    }[g] ?? "bg-neutral-700"
  );
}

function statusClass(status: string) {
  return (
    {
      pending: "bg-neutral-800/60 text-neutral-500",
      running: "bg-neutral-800/60 text-neutral-300",
      verifying: "bg-neutral-800/60 text-neutral-400",
      done: "bg-neutral-800/40 text-neutral-300",
      blocked: "bg-neutral-800/40 text-neutral-600",
    }[status] ?? "bg-neutral-800/60 text-neutral-500"
  );
}
</script>

<style scoped>
/* Pulse animation for running status dot */
@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(0.75); }
}
.pulse-dot {
  animation: pulse-dot 1.4s ease-in-out infinite;
}

/* Left border glow pulse for running rows */
@keyframes border-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.3; }
}
.running-border {
  animation: border-pulse 1.4s ease-in-out infinite;
}

/* Subtle background shimmer on running rows */
.running-row {
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(59, 130, 246, 0.03) 50%,
    transparent 100%
  );
}
.running-row:hover {
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.04) 50%,
    transparent 100%
  );
}
</style>
