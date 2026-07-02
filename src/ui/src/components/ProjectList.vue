<template>
  <div class="w-full max-w-2xl mx-auto space-y-4 px-4 py-6">
    <div class="flex items-baseline justify-between">
      <h1 id="projects-title" class="text-sm font-semibold text-neutral-100">Recent projects</h1>
      <button class="text-xs text-neutral-500 hover:text-white transition-colors" @click="store.setStage(1)">
        + New project
      </button>
    </div>

    <p v-if="loading" class="text-xs text-neutral-600">Loading…</p>

    <div v-else-if="store.projects.length === 0" class="space-y-3 pt-4 text-center">
      <p class="text-xs text-neutral-600">No previous projects found.</p>
      <button
        class="px-3 py-1.5 rounded bg-neutral-800 text-xs text-neutral-200 hover:bg-neutral-700 transition-colors"
        @click="store.setStage(1)"
      >
        Start a new project
      </button>
    </div>

    <ul v-else class="space-y-2">
      <li
        v-for="p in store.projects"
        :key="p.path"
        class="group border border-neutral-800 rounded-lg p-3 hover:border-neutral-700 transition-colors"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span class="font-mono text-sm text-neutral-200 truncate">{{ p.name }}</span>
          <span class="text-[10px] text-neutral-700 flex-shrink-0">{{ relativeDate(p.lastUsed) }}</span>
        </div>
        <p class="text-xs text-neutral-500 truncate mt-0.5">{{ p.goal || "(no goal)" }}</p>
        <div class="flex items-center justify-between mt-2">
          <span class="text-[10px] text-neutral-700">
            {{ p.totals.done }}/{{ p.totals.units }} tasks · ${{ p.totals.cost_usd.toFixed(2) }}
            <span :class="badgeClass(projectStatus(p))">{{ badgeLabel(p) }}</span>
          </span>
          <div class="flex gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
            <button
              class="px-2 py-0.5 rounded text-[11px] text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors disabled:opacity-40"
              :disabled="actionInFlight === p.path"
              @click="resume(p)"
            >Resume</button>
            <button
              class="px-2 py-0.5 rounded text-[11px] text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors disabled:opacity-40"
              :disabled="actionInFlight === p.path"
              @click="reuse(p)"
            >Reuse</button>
            <button
              class="px-2 py-0.5 rounded text-[11px] text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              @click="toggleLogs(p)"
            >Logs</button>
            <button
              class="px-2 py-0.5 rounded text-[11px] text-neutral-400 hover:text-red-400 hover:bg-neutral-800 transition-colors disabled:opacity-40"
              :disabled="actionInFlight === p.path"
              @click="remove(p)"
            >Delete</button>
          </div>
        </div>
        <p v-if="errorFor === p.path" class="text-[11px] text-red-400 mt-1">{{ actionErr }}</p>
        <ProjectLogDrawer
          v-if="logsProject?.path === p.path"
          :project="p"
          @close="logsProject = null"
        />
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api.js";
import { useVfStore } from "../store.js";
import type { ProjectEntry } from "../types.js";
import ProjectLogDrawer from "./ProjectLogDrawer.vue";

const store = useVfStore();
const loading = ref(false);
const actionInFlight = ref<string | null>(null);
const errorFor = ref<string | null>(null);
const actionErr = ref<string | null>(null);
const logsProject = ref<ProjectEntry | null>(null);

onMounted(async () => {
  if (store.projects.length === 0) {
    loading.value = true;
    await store.loadProjects();
    loading.value = false;
  }
});

async function resume(p: ProjectEntry) {
  actionInFlight.value = p.path;
  errorFor.value = null;
  try {
    await store.loadProject(p.path, "resume");
  } catch {
    errorFor.value = p.path;
    actionErr.value = "Failed to load project state.";
  } finally {
    actionInFlight.value = null;
  }
}

async function reuse(p: ProjectEntry) {
  actionInFlight.value = p.path;
  errorFor.value = null;
  try {
    await store.loadProject(p.path, "reuse");
    store.setStage(1);
  } catch {
    errorFor.value = p.path;
    actionErr.value = "Failed to load project.";
  } finally {
    actionInFlight.value = null;
  }
}

function toggleLogs(p: ProjectEntry) {
  logsProject.value = logsProject.value?.path === p.path ? null : p;
}

async function remove(p: ProjectEntry) {
  actionInFlight.value = p.path;
  errorFor.value = null;
  try {
    await api.projects.delete(p.path);
    await store.loadProjects();
  } catch {
    errorFor.value = p.path;
    actionErr.value = "Failed to delete project.";
  } finally {
    actionInFlight.value = null;
  }
}

function projectStatus(p: ProjectEntry): "done" | "partial" | "empty" | "stale" {
  if (p.totals.units === 0) return "empty";
  if (p.totals.done === p.totals.units) return "done";
  if (Date.now() - p.lastUsed > 30 * 24 * 60 * 60 * 1000) return "stale";
  return "partial";
}

function badgeClass(status: string): string {
  const map: Record<string, string> = {
    done: "text-[10px] px-1.5 py-0.5 rounded bg-green-900 text-green-300",
    partial: "text-[10px] px-1.5 py-0.5 rounded bg-blue-900 text-blue-300",
    empty: "text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-500",
    stale: "text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-600",
  };
  return map[status] ?? "";
}

function badgeLabel(p: ProjectEntry): string {
  if (p.totals.units === 0) return "no tasks";
  if (p.totals.done === p.totals.units) return "✓ done";
  return `${p.totals.done}/${p.totals.units} done`;
}

function relativeDate(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 2) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}
</script>
