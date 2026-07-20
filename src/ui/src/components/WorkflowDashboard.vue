<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-sm font-semibold text-neutral-100">Active workflows</h2>
      <button class="text-xs text-neutral-500 hover:text-white transition-colors" @click="store.setStage(1)">
        + New project
      </button>
    </div>

    <p v-if="loading" class="text-xs text-neutral-600">Loading…</p>

    <div v-else-if="error" class="flex items-start gap-2 p-3 rounded border border-red-900/60 text-red-400 text-xs" role="alert">
      <span>⚠</span><span>{{ error }}</span>
      <button class="ml-auto text-neutral-500 hover:text-white text-[10px]" @click="refresh">retry</button>
    </div>

    <template v-else-if="workflows.length > 0">
      <div class="flex flex-wrap gap-1.5" role="tablist" aria-label="Workflows">
        <WorkflowCard
          v-for="w in workflows" :key="w.key"
          :item="w" :selected="store.selectedWorkflowKey === w.key"
          @select="store.selectWorkflow(w.key)"
        />
      </div>

      <div v-if="selectedItem" class="border border-neutral-800 rounded-lg overflow-hidden">
        <div class="px-3 py-2 border-b border-neutral-800/40 bg-neutral-900/50">
          <div class="flex items-center gap-2">
            <span class="text-sm font-mono text-neutral-200">{{ selectedItem.repoName }}</span>
            <span class="text-[11px] font-mono text-neutral-600">/</span>
            <span class="text-[11px] font-mono text-neutral-400">{{ selectedItem.taskId }}</span>
          </div>
          <p class="text-[11px] text-neutral-500 truncate mt-0.5" :title="selectedItem.goal">{{ selectedItem.goal }}</p>
        </div>

        <div class="flex flex-col lg:flex-row gap-0">
          <div class="flex-1 p-4 min-w-0">
            <PipelineGraph
              :units="selectedItem.workUnits"
              :selected-unit="store.selectedUnit"
              :workflow-key="store.selectedWorkflowKey ?? undefined"
              @select="handleNodeSelect"
            />
          </div>
          <div
            v-if="dashboardLogEvents.length > 0"
            class="lg:w-80 border-t lg:border-t-0 lg:border-l border-neutral-800/40 max-h-96 overflow-y-auto"
          >
            <WorkflowLogPane :events="dashboardLogEvents" :selected-unit="store.selectedUnit" />
          </div>
        </div>
      </div>

      <div v-else-if="workflows.length > 0" class="border border-neutral-800 rounded-lg p-6 text-center">
        <p class="text-xs text-neutral-600">Select a workflow to view its pipeline</p>
      </div>
    </template>

    <div v-else class="space-y-3 pt-4 text-center">
      <p class="text-xs text-neutral-600">No active workflows found.</p>
      <p v-if="store.projects.length > 0" class="text-[11px] text-neutral-700">
        Registered projects without workflow state will appear when they have running workflows.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api } from "../api.js";
import { useWorkflowDashboard } from "../composables/useWorkflowDashboard.js";
import { useVfStore } from "../store.js";
import type { LogEvent, WorkflowDashboardItem } from "../types.js";
import PipelineGraph from "./PipelineGraph.vue";
import WorkflowCard from "./WorkflowCard.vue";
import WorkflowLogPane from "./WorkflowLogPane.vue";

const store = useVfStore();
const { workflows, error, loading, refresh } = useWorkflowDashboard();

const dashboardLogEvents = ref<LogEvent[]>([]);
let dashboardStream: EventSource | null = null;
let dashboardLogCursor = 0;
let dashboardLogRunId = "";

const selectedItem = computed<WorkflowDashboardItem | undefined>(() =>
  workflows.value.find((w) => w.key === store.selectedWorkflowKey),
);

function handleNodeSelect(unit: string) {
  store.selectUnit(unit);
}

async function fetchDashboardLogs() {
  dashboardStream?.close();
  dashboardStream = null;
  dashboardLogEvents.value = [];
  dashboardLogCursor = 0;
  dashboardLogRunId = "";
  const item = selectedItem.value;
  if (!item) return;
  try {
    const res = await api.dashboard.logs(
      { repoPath: item.repoPath, workflowId: item.taskId, unit: store.selectedUnit ?? undefined },
      0,
      500,
      true,
    );
    for (const ev of res.events) {
      if (
        dashboardLogEvents.value.some(
          (existing) => existing.runId === ev.runId && existing.seq === ev.seq,
        )
      )
        continue;
      dashboardLogEvents.value.push(ev);
      if (ev.runId !== dashboardLogRunId || ev.seq > dashboardLogCursor) {
        dashboardLogCursor = ev.seq;
        dashboardLogRunId = ev.runId;
      }
    }
    dashboardLogEvents.value = dashboardLogEvents.value
      .sort((a, b) => a.seq - b.seq || a.runId.localeCompare(b.runId))
      .slice(-500);
    const url = api.dashboard.streamUrl({
      repoPath: item.repoPath,
      workflowId: item.taskId,
      unit: store.selectedUnit ?? undefined,
      since: dashboardLogCursor,
      runId: dashboardLogRunId,
    });
    dashboardStream = new EventSource(url);
    dashboardStream.addEventListener("log", (event) => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as LogEvent;
        if (
          dashboardLogEvents.value.some(
            (existing) => existing.runId === next.runId && existing.seq === next.seq,
          )
        )
          return;
        if (next.runId !== dashboardLogRunId || next.seq > dashboardLogCursor) {
          dashboardLogCursor = next.seq;
          dashboardLogRunId = next.runId;
        }
        dashboardLogEvents.value = [...dashboardLogEvents.value, next].slice(-500);
      } catch {
        /* malformed stream frame */
      }
    });
  } catch {
    /* best-effort */
  }
}

watch([() => store.selectedWorkflowKey, () => store.selectedUnit], fetchDashboardLogs);

onMounted(() => {
  store.loadProjects();
});

onUnmounted(() => dashboardStream?.close());
</script>
