<template>
  <div class="mt-3 border border-neutral-800 rounded p-3 space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-xs text-neutral-400">Logs — {{ project.name }}</span>
      <button class="text-[11px] text-neutral-600 hover:text-neutral-300 transition-colors" @click="$emit('close')">✕</button>
    </div>
    <p v-if="loading" class="text-xs text-neutral-600">Loading…</p>
    <p v-else-if="!events.length" class="text-xs text-neutral-700">No logs found.</p>
    <ul v-else class="space-y-0.5 max-h-48 overflow-y-auto">
      <li v-for="ev in events" :key="ev.seq" class="text-[11px] font-mono text-neutral-500 flex gap-1.5">
        <span class="text-neutral-700 flex-shrink-0">{{ ev.unit ?? "—" }}</span>
        <span class="break-all">{{ ev.text }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api.js";
import type { LogEvent, ProjectEntry } from "../types.js";

const props = defineProps<{ project: ProjectEntry }>();
defineEmits<{ close: [] }>();

const loading = ref(true);
const events = ref<LogEvent[]>([]);

onMounted(async () => {
  try {
    events.value = await api.projects.logs(props.project.path);
  } catch {
    /* no logs available */
  } finally {
    loading.value = false;
  }
});
</script>
