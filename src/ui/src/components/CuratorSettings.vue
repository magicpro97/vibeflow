<template>
  <fieldset class="space-y-3">
    <legend class="text-xs text-neutral-500 mb-1.5 flex items-center gap-1.5">
      Curator
      <InfoTip tip="Background skill auditing. Observe mode reports findings without changing anything." />
    </legend>

    <label class="flex items-start gap-2 cursor-pointer group">
      <input v-model="model.enabled" type="checkbox" class="mt-0.5 accent-neutral-400" />
      <span>
        <span class="text-neutral-200 group-hover:text-white transition-colors">Enable curator</span>
        <span class="block text-[11px] text-neutral-500 mt-0.5">Run scheduled skill audits and surface findings</span>
      </span>
    </label>

    <label class="flex items-start gap-2 cursor-pointer group">
      <input v-model="model.observeMode" type="checkbox" class="mt-0.5 accent-neutral-400" />
      <span>
        <span class="text-neutral-200 group-hover:text-white transition-colors">Observe mode</span>
        <span class="block text-[11px] text-neutral-500 mt-0.5">Report only — never mutate skills or settings</span>
      </span>
    </label>

    <div class="flex items-center gap-2">
      <span class="w-28 text-neutral-300 text-xs flex items-center gap-0.5">
        Schedule
        <InfoTip tip="Five-field cron (minute hour day-of-month month day-of-week). Default: Mondays 9am." />
      </span>
      <input
        v-model="model.schedule"
        type="text"
        spellcheck="false"
        :aria-invalid="scheduleValid ? 'false' : 'true'"
        aria-describedby="curator-schedule-error"
        :class="['w-32 bg-transparent border rounded px-2 py-0.5 text-sm font-mono transition-colors focus:outline-none', scheduleValid ? 'border-neutral-800 text-neutral-200 focus:border-neutral-600' : 'border-red-500 text-red-400']"
        aria-label="Curator cron schedule"
      />
    </div>
    <p v-if="!scheduleValid" id="curator-schedule-error" class="text-[11px] text-red-400">
      Invalid cron schedule — five fields, standard numeric values only.
    </p>

    <div class="flex items-center gap-2">
      <span class="w-28 text-neutral-300 text-xs">Severity threshold</span>
      <select
        v-model="model.severityThreshold"
        class="bg-neutral-900 border border-neutral-800 rounded px-2 py-0.5 text-sm text-neutral-200 focus:outline-none focus:border-neutral-600 transition-colors"
        aria-label="Curator severity threshold"
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </div>

    <div class="text-[11px] text-neutral-600">
      {{ enabledLabel }}
    </div>

    <div v-if="findings.length" class="space-y-1.5 pt-1">
      <div class="text-[11px] text-neutral-500 uppercase tracking-wider">Recent findings</div>
      <div
        v-for="f in findings"
        :key="f.id"
        class="flex items-start gap-2 px-2 py-1.5 rounded border border-neutral-800"
      >
        <span
          class="shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide font-medium"
          :class="severityBadge(f.severity)"
        >{{ f.severity }}</span>
        <span class="text-xs text-neutral-300">{{ f.summary }}</span>
      </div>
    </div>
    <div v-else-if="loaded && !error" class="text-[11px] text-neutral-600 italic">No curator findings</div>

    <div v-if="error" class="text-[11px] text-red-400">{{ error }}</div>
  </fieldset>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api.js";
import { isValidSchedule } from "../lib/curator-schedule.js";
import type { CuratorFindingView, CuratorSettings } from "../types.js";
import InfoTip from "./InfoTip.vue";

const props = defineProps<{ modelValue: CuratorSettings }>();
const emit = defineEmits<{
  "update:modelValue": [CuratorSettings];
  validity: [valid: boolean];
}>();

const model = computed<CuratorSettings>({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});

const findings = ref<CuratorFindingView[]>([]);
const loaded = ref(false);
const error = ref("");

const scheduleValid = computed(() => isValidSchedule(props.modelValue.schedule));

watch(scheduleValid, (v) => emit("validity", v), { immediate: true });

const enabledLabel = computed(() => {
  const state = props.modelValue.enabled ? "on" : "off";
  const mode = props.modelValue.observeMode ? "observe-only" : "active";
  return `Curator ${state} · ${mode}`;
});

function severityBadge(sev: string): string {
  switch (sev) {
    case "high":
      return "bg-red-500/15 text-red-400 border border-red-500/30";
    case "medium":
      return "bg-yellow-500/15 text-yellow-400 border border-yellow-500/30";
    default:
      return "bg-neutral-500/15 text-neutral-400 border border-neutral-500/30";
  }
}

onMounted(async () => {
  try {
    const view = await api.curator();
    findings.value = view.findings;
    loaded.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    loaded.value = true;
  }
});
</script>