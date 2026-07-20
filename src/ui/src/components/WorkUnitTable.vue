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
              <div class="grid gap-3" style="font-size: 11px;">
                <!-- Failed checks summary for blocked/failed units -->
                <div v-if="u.status === 'blocked' || (u.status !== 'done' && Object.values(u.gates).some(g=>g==='fail'))">
                  <span class="text-[10px] text-neutral-600 font-medium">failed checks</span>
                  <div class="flex flex-wrap gap-1 mt-1.5">
                    <span
                      v-for="gate in GATE_KEYS.filter(g=>u.gates[g]==='fail')"
                      :key="gate"
                      class="px-1.5 py-0.5 bg-red-950/40 border border-red-900/40 rounded text-red-400 font-mono text-[10px]"
                    >✗ {{ gate }}</span>
                    <span v-if="!GATE_KEYS.some(g=>u.gates[g]==='fail')" class="text-neutral-700 italic text-[11px]">
                      Blocked — waiting on another unit to finish first
                    </span>
                  </div>
                </div>

                <!-- Scope -->
                <div v-if="u.scope && u.scope.length">
                  <span class="text-[10px] text-neutral-600 font-medium">files changed</span>
                  <div class="flex flex-wrap gap-1 mt-1.5">
                    <span
                      v-for="s in u.scope" :key="s"
                      class="px-1.5 py-0.5 bg-neutral-800/50 rounded text-neutral-400 font-mono text-[11px]"
                    >
                      {{ s }}
                    </span>
                  </div>
                </div>

                <!-- Evidence -->
                <div v-if="u.evidence && u.evidence.length">
                  <span class="text-[10px] text-neutral-600 font-medium">evidence</span>
                  <ul class="mt-1.5 space-y-0.5">
                    <li
                      v-for="(c, i) in u.evidence.map(classifyEvidence)" :key="i"
                      class="flex items-start gap-2 text-neutral-500"
                    >
                      <span class="text-neutral-600 mt-px flex-shrink-0 text-[10px]">+</span>
                      <!-- file → click-to-open link (button, not <a>, to avoid navigation) -->
                      <button
                        v-if="c.kind === 'file'"
                        type="button"
                        class="font-mono text-[11px] text-blue-400 hover:text-blue-300 hover:underline text-left"
                        @click="openFile(u.name, c)"
                      >📄 {{ c.path }}<span v-if="c.line">:{{ c.line }}</span></button>
                      <!-- command → $ badge + mono raw in a distinct color -->
                      <span v-else-if="c.kind === 'command'" class="font-mono text-[11px]">
                        <span class="text-neutral-600">$</span>
                        <span class="text-emerald-400 ml-1">{{ cmdText(c.raw) }}</span>
                      </span>
                      <!-- test → ✓/✗ badge colored by pass/fail + label -->
                      <span
                        v-else-if="c.kind === 'test'"
                        class="font-mono text-[11px]"
                        :class="/fail/i.test(c.label ?? '') ? 'text-red-400' : 'text-emerald-400'"
                      >{{ /fail/i.test(c.label ?? '') ? '✗' : '✓' }} {{ c.label }}</span>
                      <!-- text → plain mono fallback (no regression) -->
                      <span v-else class="font-mono text-[11px]">{{ c.raw }}</span>
                    </li>
                  </ul>
                  <!-- #558: opened file content (XSS-safe {{ }}, never v-html) -->
                  <div v-if="openedFile && openedFile.unit === u.name" class="mt-2 border border-neutral-800 rounded bg-neutral-950/60">
                    <div class="flex items-center justify-between px-2 py-1 border-b border-neutral-800">
                      <span class="font-mono text-[10px] text-neutral-400">
                        {{ openedFile.path }}<span v-if="openedFile.line">:{{ openedFile.line }}</span>
                      </span>
                      <button
                        type="button"
                        class="text-[10px] text-neutral-500 hover:text-neutral-300"
                        @click="openedFile = null"
                      >✕ close</button>
                      <button
                        v-if="openedFile?.path"
                        type="button"
                        class="text-[10px] text-neutral-400 hover:text-neutral-200"
                        @click="askAboutOpenedFile()"
                      >Ask about this</button>
                    </div>
                    <p v-if="openedFile.loading" class="px-2 py-1.5 text-[10px] text-neutral-600 italic">loading…</p>
                    <p v-else-if="openedFile.error" class="px-2 py-1.5 text-[10px] text-red-400 font-mono">{{ openedFile.error }}</p>
                    <pre v-else class="px-2 py-1.5 text-[10px] text-neutral-400 font-mono overflow-x-auto max-h-80 whitespace-pre-wrap">{{ openedFile.content }}</pre>
                  </div>
                </div>

                <!-- #557: status timeline — append-only transition ledger, oldest first -->
                <div v-if="timelines[u.name]?.length">
                  <span class="text-[10px] text-neutral-600 font-medium">timeline</span>
                  <ol class="mt-1.5 space-y-0.5">
                    <li
                      v-for="(t, i) in timelines[u.name]" :key="i"
                      class="flex items-center gap-2 text-neutral-500"
                    >
                      <span
                        class="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        :class="statusClass(t.status as WorkUnit['status'])"
                      />
                      <span class="font-mono text-[11px] text-neutral-400">{{ t.status }}</span>
                      <span class="text-neutral-600 text-[10px]">{{ relativeTime(t.at) }}</span>
                    </li>
                  </ol>
                </div>

                <div v-if="u.depends_on && u.depends_on.length">
                  <span class="text-[10px] text-neutral-600 font-medium">Depends on</span>
                  <div class="flex flex-wrap gap-1 mt-1.5">
                    <span
                      v-for="d in u.depends_on" :key="d"
                      class="px-1.5 py-0.5 bg-neutral-800/50 rounded text-neutral-400 font-mono text-[11px]"
                    >{{ d }}</span>
                  </div>
                </div>
                <div v-if="downstream(u.name).length > 0">
                  <span class="text-[10px] text-neutral-600 font-medium">Downstream</span>
                  <div class="flex flex-wrap gap-1 mt-1.5">
                    <span
                      v-for="d in downstream(u.name)" :key="d"
                      class="px-1.5 py-0.5 bg-neutral-800/50 rounded text-neutral-400 font-mono text-[11px]"
                    >{{ d }}</span>
                  </div>
                </div>
                <div v-if="u.upstreamHandoffs?.length" class="border-t border-neutral-800/40 pt-2 mt-1">
                  <span class="text-[10px] text-neutral-600 font-medium">Handoffs</span>
                  <div v-for="h in u.upstreamHandoffs" :key="h.unit" class="mt-1 text-[11px] text-neutral-500 font-mono">
                    <span class="text-neutral-400">{{ h.unit }}:</span> {{ h.summary }}
                  </div>
                </div>
                <div class="border-t border-neutral-800/40 pt-2 mt-1">
                  <button
                    class="text-[10px] text-neutral-600 hover:text-neutral-300 transition-colors underline underline-offset-2"
                    @click="viewPipeline(u.name)"
                  >View pipeline{{ u.name ? ` (${u.name})` : '' }}</button>
                </div>
                <!-- Spec preview -->
                <div v-if="u.spec">
                  <span class="text-[10px] text-neutral-600 font-medium">spec</span>
                  <p class="mt-1.5 text-neutral-600 font-mono leading-relaxed text-[11px]">
                    {{ u.spec.slice(0, 300) }}<span v-if="u.spec.length > 300" class="text-neutral-800">…</span>
                  </p>
                </div>

                <!-- Resources summary -->
                <div v-if="u.resources.wall_seconds > 0 || u.resources.tokens > 0" class="flex items-center gap-3 text-[10px] text-neutral-700 font-mono">
                  <span v-if="u.resources.wall_seconds > 0">{{ (() => { const s = u.resources.wall_seconds; if (s >= 3600) { const h = Math.floor(s/3600); const m = Math.floor((s%3600)/60); const r = s%60; return `${h}h${m ? m+'m' : ''}${r ? r+'s' : ''}`; } if (s >= 60) { const m = Math.floor(s/60); const r = s%60; return `${m}m${r ? r+'s' : ''}`; } return `${s}s`; })() }}</span>
                  <span v-if="u.resources.tokens > 0">{{ u.resources.tokens >= 1000 ? `${(u.resources.tokens/1000).toFixed(1)}k` : u.resources.tokens }} tokens</span>
                  <span v-if="u.resources.cost_usd > 0">${{ fmtCost(u.resources.cost_usd) }}</span>
                </div>

                <!-- #526: pre-dispatch guidance — steer a unit still QUEUED
                     (fire-and-forget POST; not a running unit). -->
                <div v-if="u.status === 'pending'" class="border-t border-neutral-800/40 pt-3">
                  <label :for="`guidance-${u.name}`" class="text-[10px] text-neutral-600 font-medium">
                    steer this queued unit
                  </label>
                  <textarea
                    :id="`guidance-${u.name}`"
                    v-model="guidanceNote[u.name]"
                    rows="2"
                    placeholder="e.g. focus on the auth edge cases"
                    class="mt-1.5 w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-neutral-300 font-mono text-[11px] resize-y focus:outline-none focus:border-neutral-600"
                  />
                  <div class="flex items-center gap-2 mt-1.5">
                    <button
                      type="button"
                      class="px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[10px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                      :disabled="!guidanceNote[u.name]?.trim() || guidanceSent.has(u.name)"
                      @click="submitGuidance(u.name)"
                    >
                      {{ guidanceSent.has(u.name) ? 'sent ✓' : 'Submit guidance' }}
                    </button>
                  </div>
                </div>

                <!-- No detail fallback -->
                <p
                  v-if="!u.scope?.length && !u.evidence?.length && !u.spec"
                  class="text-neutral-700 italic"
                >
                  {{ u.status === 'pending' ? 'Waiting to run.' : u.status === 'running' ? 'Agent working — details appear as it completes steps.' : 'No spec or evidence recorded.' }}
                </p>
              </div>
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
import { prefillFromOpenedFile } from "../lib/ask-prefill.js";
import { type ClassifiedEvidence, classifyEvidence } from "../lib/evidence.js";
import { unitColor } from "../lib/unit-color.js";
import { useVfStore } from "../store.js";
import type { GateState, TimelineEntry, WorkUnit } from "../types.js";
import InfoTip from "./InfoTip.vue";

const props = defineProps<{ units: WorkUnit[]; emptyText?: string }>();
const GATE_KEYS = ["build", "lint", "test", "review"] as const;
const store = useVfStore();

const expanded = ref(new Set<string>());

// #526: pre-dispatch guidance — per-unit draft note + sent markers.
const guidanceNote = ref<Record<string, string>>({});
const guidanceSent = ref(new Set<string>());
async function submitGuidance(name: string) {
  const note = guidanceNote.value[name]?.trim();
  if (!note) return;
  try {
    await api.guidance(name, note);
    guidanceSent.value = new Set(guidanceSent.value).add(name);
  } catch {
    /* fire-and-forget: a failed steer is non-fatal, the unit still runs */
  }
}

// Prune stale names from expanded set when units change (prevents ghost expansion)
watch(
  () => props.units.map((u) => u.name),
  (names) => {
    const nameSet = new Set(names);
    const pruned = new Set([...expanded.value].filter((n) => nameSet.has(n)));
    if (pruned.size !== expanded.value.size) expanded.value = pruned;
  },
);

function fmtCost(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

// #558: strip an optional `acceptance <id>: ` prefix + leading `$ ` so the
// command badge shows just the runnable text.
function cmdText(raw: string): string {
  return raw.replace(/^acceptance\s+\S+:\s*/i, "").replace(/^\$ /, "");
}

// #558: inline viewer for a clicked `file:line` evidence item. One open at a
// time; content is rendered via {{ }} (XSS-safe), never v-html.
const openedFile = ref<{
  unit: string;
  path: string;
  line?: number;
  content?: string;
  loading: boolean;
  error?: string;
} | null>(null);

async function openFile(unit: string, c: ClassifiedEvidence) {
  if (!c.path) return;
  const req = { unit, path: c.path, line: c.line };
  openedFile.value = { ...req, loading: true };
  // Race guard: a second click before this resolves must win. Only mutate if the
  // still-open viewer is THIS request (same unit/path/line), else drop the stale response.
  const current = () => {
    const o = openedFile.value;
    return !!o && o.unit === req.unit && o.path === req.path && o.line === req.line;
  };
  try {
    const res = await api.readFile(c.path, c.line);
    if (!current()) return; // closed or superseded while loading
    if (res.ok) openedFile.value = { ...req, content: res.content, loading: false };
    else openedFile.value = { ...req, loading: false, error: res.reason ?? "could not read file" };
  } catch (e) {
    if (current()) openedFile.value = { ...req, loading: false, error: (e as Error).message };
  }
}

function askAboutOpenedFile() {
  const prefill = prefillFromOpenedFile(openedFile.value);
  if (prefill) store.openAsk(prefill);
}

function downstream(name: string): string[] {
  return (props.units ?? []).filter((u) => (u.depends_on ?? []).includes(name)).map((u) => u.name);
}

function viewPipeline(unit: string) {
  const repoPath = (() => {
    try {
      const h = JSON.parse(localStorage.getItem("vf-repo-history") || "[]");
      return h[0] ?? null;
    } catch {
      return null;
    }
  })();
  if (!repoPath || !store.state) return;
  store.selectWorkflow(`${repoPath}\u0000${store.state.task_id}`);
  if (unit) store.selectUnit(unit);
  store.setStage(0);
}

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

// #557: "2m ago"-style relative time. Inline (6 lines) — not reused elsewhere.
function relativeTime(at: number): string {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function statusClass(s: WorkUnit["status"]) {
  return (
    {
      pending: "bg-neutral-800/60 text-neutral-500",
      running: "bg-neutral-800/60 text-neutral-300",
      verifying: "bg-neutral-800/60 text-neutral-400",
      done: "bg-neutral-800/40 text-neutral-300",
      blocked: "bg-neutral-800/40 text-neutral-600",
    }[s] ?? "bg-neutral-800/60 text-neutral-500"
  );
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
