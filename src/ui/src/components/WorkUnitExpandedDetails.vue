<template>
  <div class="grid gap-3" style="font-size: 11px;">
    <div v-if="unit.status === 'blocked' || (unit.status !== 'done' && Object.values(unit.gates).some((gate)=>gate==='fail'))">
      <span class="text-[10px] text-neutral-600 font-medium">failed checks</span>
      <div class="flex flex-wrap gap-1 mt-1.5">
        <span
          v-for="gate in GATE_KEYS.filter((name)=>unit.gates[name]==='fail')"
          :key="gate"
          class="px-1.5 py-0.5 bg-red-950/40 border border-red-900/40 rounded text-red-400 font-mono text-[10px]"
        >✗ {{ gate }}</span>
        <span v-if="!GATE_KEYS.some((name)=>unit.gates[name]==='fail')" class="text-neutral-700 italic text-[11px]">
          Blocked — waiting on another unit to finish first
        </span>
      </div>
    </div>

    <div v-if="unit.scope?.length">
      <span class="text-[10px] text-neutral-600 font-medium">files changed</span>
      <div class="flex flex-wrap gap-1 mt-1.5">
        <span
          v-for="scope in unit.scope"
          :key="scope"
          class="px-1.5 py-0.5 bg-neutral-800/50 rounded text-neutral-400 font-mono text-[11px]"
        >{{ scope }}</span>
      </div>
    </div>

    <div v-if="unit.evidence?.length">
      <span class="text-[10px] text-neutral-600 font-medium">evidence</span>
      <ul class="mt-1.5 space-y-0.5">
        <li
          v-for="(entry, index) in unit.evidence.map(classifyEvidence)"
          :key="index"
          class="flex items-start gap-2 text-neutral-500"
        >
          <span class="text-neutral-600 mt-px flex-shrink-0 text-[10px]">+</span>
          <button
            v-if="entry.kind === 'file'"
            type="button"
            class="font-mono text-[11px] text-blue-400 hover:text-blue-300 hover:underline text-left"
            @click="openFile(entry)"
          >📄 {{ entry.path }}<span v-if="entry.line">:{{ entry.line }}</span></button>
          <button
            v-if="entry.kind === 'file'"
            type="button"
            class="text-[10px] text-neutral-600 hover:text-neutral-300 underline underline-offset-2"
            :disabled="handoffBusyKey === evidenceKey(entry)"
            @click="useInConversation(entry)"
          >
            {{ handoffBusyKey === evidenceKey(entry) ? "Adding…" : "Use in conversation" }}
          </button>
          <span v-else-if="entry.kind === 'command'" class="font-mono text-[11px]">
            <span class="text-neutral-600">$</span><span class="text-emerald-400 ml-1">{{ cmdText(entry.raw) }}</span>
          </span>
          <span
            v-else-if="entry.kind === 'test'"
            class="font-mono text-[11px]"
            :class="/fail/i.test(entry.label ?? '') ? 'text-red-400' : 'text-emerald-400'"
          >{{ /fail/i.test(entry.label ?? '') ? '✗' : '✓' }} {{ entry.label }}</span>
          <span v-else class="font-mono text-[11px]">{{ entry.raw }}</span>
        </li>
      </ul>
      <p v-if="handoffStatus" class="mt-1.5 text-[10px] text-neutral-600" :role="handoffError ? 'alert' : 'status'">
        {{ handoffStatus }}
      </p>
      <div v-if="openedFile" class="mt-2 border border-neutral-800 rounded bg-neutral-950/60">
        <div class="flex items-center justify-between px-2 py-1 border-b border-neutral-800">
          <span class="font-mono text-[10px] text-neutral-400">
            {{ openedFile.path }}<span v-if="openedFile.line">:{{ openedFile.line }}</span>
          </span>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="text-[10px] text-neutral-500 hover:text-neutral-300"
              @click="openedFile = null"
            >✕ close</button>
          </div>
        </div>
        <p v-if="openedFile.loading" class="px-2 py-1.5 text-[10px] text-neutral-600 italic">loading…</p>
        <p v-else-if="openedFile.error" class="px-2 py-1.5 text-[10px] text-red-400 font-mono">{{ openedFile.error }}</p>
        <pre v-else class="px-2 py-1.5 text-[10px] text-neutral-400 font-mono overflow-x-auto max-h-80 whitespace-pre-wrap">{{ openedFile.content }}</pre>
      </div>
    </div>

    <div v-if="timeline?.length">
      <span class="text-[10px] text-neutral-600 font-medium">timeline</span>
      <ol class="mt-1.5 space-y-0.5">
        <li v-for="(entry, index) in timeline" :key="index" class="flex items-center gap-2 text-neutral-500">
          <span class="w-1.5 h-1.5 rounded-full flex-shrink-0" :class="statusClass(entry.status as WorkUnit['status'])" />
          <span class="font-mono text-[11px] text-neutral-400">{{ entry.status }}</span>
          <span class="text-neutral-600 text-[10px]">{{ relativeTime(entry.at) }}</span>
        </li>
      </ol>
    </div>

    <div v-if="unit.depends_on?.length">
      <span class="text-[10px] text-neutral-600 font-medium">Depends on</span>
      <div class="flex flex-wrap gap-1 mt-1.5">
        <span
          v-for="dependency in unit.depends_on"
          :key="dependency"
          class="px-1.5 py-0.5 bg-neutral-800/50 rounded text-neutral-400 font-mono text-[11px]"
        >{{ dependency }}</span>
      </div>
    </div>
    <div v-if="downstream.length">
      <span class="text-[10px] text-neutral-600 font-medium">Downstream</span>
      <div class="flex flex-wrap gap-1 mt-1.5">
        <span
          v-for="dependency in downstream"
          :key="dependency"
          class="px-1.5 py-0.5 bg-neutral-800/50 rounded text-neutral-400 font-mono text-[11px]"
        >{{ dependency }}</span>
      </div>
    </div>
    <div v-if="unit.upstreamHandoffs?.length" class="border-t border-neutral-800/40 pt-2 mt-1">
      <span class="text-[10px] text-neutral-600 font-medium">Handoffs</span>
      <div v-for="handoff in unit.upstreamHandoffs" :key="handoff.unit" class="mt-1 text-[11px] text-neutral-500 font-mono">
        <span class="text-neutral-400">{{ handoff.unit }}:</span> {{ handoff.summary }}
      </div>
    </div>
    <div class="border-t border-neutral-800/40 pt-2 mt-1">
      <button
        class="text-[10px] text-neutral-600 hover:text-neutral-300 transition-colors underline underline-offset-2"
        @click="viewPipeline"
      >View pipeline{{ unit.name ? ` (${unit.name})` : '' }}</button>
    </div>

    <div v-if="unit.spec">
      <span class="text-[10px] text-neutral-600 font-medium">spec</span>
      <p class="mt-1.5 text-neutral-600 font-mono leading-relaxed text-[11px]">
        {{ unit.spec.slice(0, 300) }}<span v-if="unit.spec.length > 300" class="text-neutral-800">…</span>
      </p>
    </div>

    <div v-if="unit.resources.wall_seconds > 0 || unit.resources.tokens > 0" class="flex items-center gap-3 text-[10px] text-neutral-700 font-mono">
      <span v-if="unit.resources.wall_seconds > 0">{{ durationLabel(unit.resources.wall_seconds) }}</span>
      <span v-if="unit.resources.tokens > 0">{{ unit.resources.tokens >= 1000 ? `${(unit.resources.tokens/1000).toFixed(1)}k` : unit.resources.tokens }} tokens</span>
      <span v-if="unit.resources.cost_usd > 0">${{ fmtCost(unit.resources.cost_usd) }}</span>
    </div>

    <div v-if="unit.status === 'pending'" class="border-t border-neutral-800/40 pt-3">
      <label :for="`guidance-${unit.name}`" class="text-[10px] text-neutral-600 font-medium">steer this queued unit</label>
      <textarea
        :id="`guidance-${unit.name}`"
        v-model="guidance"
        rows="2"
        placeholder="e.g. focus on the auth edge cases"
        class="mt-1.5 w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-neutral-300 font-mono text-[11px] resize-y focus:outline-none focus:border-neutral-600"
      />
      <div class="flex items-center gap-2 mt-1.5">
        <button
          type="button"
          class="px-2 py-0.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[10px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!guidance.trim() || guidanceSent"
          @click="submitGuidance"
        >{{ guidanceSent ? 'sent ✓' : 'Submit guidance' }}</button>
      </div>
    </div>

    <p v-if="!unit.scope?.length && !unit.evidence?.length && !unit.spec" class="text-neutral-700 italic">
      {{ unit.status === 'pending' ? 'Waiting to run.' : unit.status === 'running' ? 'Agent working — details appear as it completes steps.' : 'No spec or evidence recorded.' }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { api } from "../api.js";
import { useConversationHomeStore } from "../conversation-home-store.js";
import { type ClassifiedEvidence, classifyEvidence } from "../lib/evidence.js";
import { useVfStore } from "../store.js";
import type { TimelineEntry, WorkUnit } from "../types.js";

const props = defineProps<{ unit: WorkUnit; units: WorkUnit[]; timeline?: TimelineEntry[] }>();
const GATE_KEYS = ["build", "lint", "test", "review"] as const;
const store = useVfStore();
const homeStore = useConversationHomeStore();
const guidance = ref("");
const guidanceSent = ref(false);
const handoffBusyKey = ref<string | null>(null);
const handoffError = ref("");
const handoffSuccess = ref("");
const openedFile = ref<{
  path: string;
  line?: number;
  content?: string;
  loading: boolean;
  error?: string;
} | null>(null);

const downstream = computed(() =>
  props.units
    .filter((unit) => (unit.depends_on ?? []).includes(props.unit.name))
    .map((unit) => unit.name),
);

function cmdText(raw: string): string {
  return raw.replace(/^acceptance\s+\S+:\s*/i, "").replace(/^\$ /, "");
}

function evidenceKey(entry: ClassifiedEvidence): string {
  return entry.kind === "file" ? `${entry.path ?? ""}:${entry.line ?? 1}` : entry.raw;
}

function fmtCost(n: number): string {
  return n >= 1 ? n.toFixed(2) : n.toFixed(4);
}

function durationLabel(seconds: number): string {
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return `${hours}h${minutes ? `${minutes}m` : ""}${rest ? `${rest}s` : ""}`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}m${rest ? `${rest}s` : ""}`;
  }
  return `${seconds}s`;
}

async function openFile(entry: ClassifiedEvidence) {
  if (!entry.path) return;
  const request = { path: entry.path, line: entry.line };
  openedFile.value = { ...request, loading: true };
  try {
    const response = await api.readFile(entry.path, entry.line);
    if (
      !openedFile.value ||
      openedFile.value.path !== request.path ||
      openedFile.value.line !== request.line
    )
      return;
    openedFile.value = response.ok
      ? { ...request, content: response.content, loading: false }
      : { ...request, loading: false, error: response.reason ?? "could not read file" };
  } catch (error) {
    if (openedFile.value?.path === request.path && openedFile.value?.line === request.line)
      openedFile.value = { ...request, loading: false, error: (error as Error).message };
  }
}

function handoffRange(entry: ClassifiedEvidence) {
  if (!entry.path) return null;
  const anchor = entry.line ?? 1;
  return {
    path: entry.path,
    startLine: Math.max(1, anchor - (entry.line ? 20 : 0)),
    endLine: entry.line ? anchor + 20 : 80,
  };
}

async function useInConversation(entry: ClassifiedEvidence) {
  const range = handoffRange(entry);
  if (!range) return;
  const key = evidenceKey(entry);
  handoffBusyKey.value = key;
  handoffError.value = "";
  handoffSuccess.value = "";
  try {
    const selected = await homeStore.stagePrivateContext({
      repo_relative_path: range.path,
      start_line: range.startLine,
      end_line: range.endLine,
    });
    if (!selected) return;
    handoffSuccess.value = "Private file range ready in Conversation Home.";
    await nextTick();
    document.querySelector<HTMLTextAreaElement>("#home-composer")?.focus();
  } catch (error) {
    handoffError.value = (error as Error).message;
  } finally {
    handoffBusyKey.value = null;
  }
}

async function submitGuidance() {
  if (!guidance.value.trim() || guidanceSent.value) return;
  try {
    await api.guidance(props.unit.name, guidance.value.trim());
    guidanceSent.value = true;
  } catch {
    /* non-fatal */
  }
}

function viewPipeline() {
  const repoPath = (() => {
    try {
      const history = JSON.parse(localStorage.getItem("vf-repo-history") || "[]");
      return history[0] ?? null;
    } catch {
      return null;
    }
  })();
  if (!repoPath || !store.state) return;
  store.selectWorkflow(`${repoPath}\u0000${store.state.task_id}`);
  store.selectUnit(props.unit.name);
  store.setStage(0);
}

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

const handoffStatus = computed(() => handoffError.value || handoffSuccess.value);

function statusClass(status: WorkUnit["status"]) {
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
