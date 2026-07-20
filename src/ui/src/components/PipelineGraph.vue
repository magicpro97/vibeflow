<template>
  <div ref="containerRef" class="relative" aria-label="Dependency pipeline" role="group">
    <svg
      v-if="edges.length"
      class="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
      aria-hidden="true"
    >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" class="text-neutral-700" fill="currentColor" />
        </marker>
      </defs>
      <path
        v-for="edge in edgePaths"
        :key="`${edge.from}-${edge.to}`"
        :d="edge.path"
        fill="none"
        stroke="currentColor"
        class="text-neutral-700"
        stroke-width="1.5"
        marker-end="url(#arrow)"
      />
    </svg>
    <div
      class="grid gap-4 min-h-0"
      :style="{ gridTemplateColumns: `repeat(${Math.max(waves.length, 1)}, minmax(0, 1fr))` }"
    >
      <div v-for="(wave, wi) in waves" :key="wi" class="flex flex-col gap-2 min-w-0">
        <div class="text-[10px] text-neutral-600 font-mono mb-1 uppercase tracking-wider select-none">
          Wave {{ wi + 1 }}
        </div>
        <button
          v-for="name in wave"
          :key="name"
          :ref="(el) => { if (el) nodeRefs[name] = el as HTMLElement }"
          class="text-left px-3 py-2 rounded border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          :class="nodeClass(name)"
          :aria-current="selectedUnit === name ? 'true' : undefined"
          :aria-label="nodeAriaLabel(name)"
          @click="$emit('select', name)"
          @keydown.enter="$emit('select', name)"
          @keydown.space.prevent="$emit('select', name)"
        >
          <div class="flex items-center gap-1.5">
            <span class="shrink-0 w-2 h-2 rounded-full" :class="dotClass(name)" />
            <span class="font-mono text-[11px] truncate">{{ name }}</span>
          </div>
          <div v-if="nodeAgent(name)" class="text-[10px] text-neutral-600 mt-0.5 truncate">{{ nodeAgent(name) }}</div>
          <div v-if="nodeDetail(name)" class="text-[10px] text-neutral-700 mt-0.5 truncate">{{ nodeDetail(name) }}</div>
        </button>
      </div>
    </div>
    <div v-if="waves.length" class="sr-only">
      <div aria-label="Execution order">
        <p v-for="(wave, wi) in waves" :key="wi">Wave {{ wi + 1 }}: {{ wave.join(", ") }}</p>
      </div>
      <div v-if="edges.length" aria-label="Dependencies">
        <p v-for="edge in edges" :key="`${edge.from}-${edge.to}`">{{ edge.to }} depends on {{ edge.from }}</p>
      </div>
    </div>
    <div v-if="waves.length === 0" class="text-[11px] text-neutral-700 italic py-4 text-center">No units to display</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { pipelineEdges, pipelineWaves, waitingOn } from "../lib/pipeline.js";
import type { WorkUnit } from "../types.js";

const props = defineProps<{
  units: WorkUnit[];
  selectedUnit?: string | null;
  workflowKey?: string;
}>();

defineEmits<{ select: [unit: string] }>();

const containerRef = ref<HTMLElement | null>(null);
const nodeRefs = ref<Record<string, HTMLElement>>({});

const byName = computed(() => new Map(props.units.map((u) => [u.name, u])));
const waves = computed(() => pipelineWaves(props.units));
const edges = computed(() => pipelineEdges(props.units));
const edgePaths = ref<Array<{ from: string; to: string; path: string }>>([]);

function updateEdgePaths() {
  const container = containerRef.value;
  if (!container) return;
  const bounds = container.getBoundingClientRect();
  edgePaths.value = edges.value.flatMap(({ from, to }) => {
    const source = nodeRefs.value[from];
    const target = nodeRefs.value[to];
    if (!source || !target) return [];
    const a = source.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const x1 = a.right - bounds.left;
    const y1 = a.top + a.height / 2 - bounds.top;
    const x2 = b.left - bounds.left;
    const y2 = b.top + b.height / 2 - bounds.top;
    const bend = Math.max(24, (x2 - x1) / 2);
    return [
      { from, to, path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` },
    ];
  });
}

let observer: ResizeObserver | undefined;
function scheduleEdges() {
  void nextTick(updateEdgePaths);
}

watch([edges, waves], scheduleEdges, { deep: true });
onMounted(() => {
  observer = new ResizeObserver(scheduleEdges);
  if (containerRef.value) observer.observe(containerRef.value);
  window.addEventListener("resize", scheduleEdges);
  scheduleEdges();
});
onUnmounted(() => {
  observer?.disconnect();
  window.removeEventListener("resize", scheduleEdges);
});

function nodeStatus(name: string): string {
  return byName.value.get(name)?.status ?? "pending";
}

function nodeClass(name: string): string {
  const s = nodeStatus(name);
  if (s === "running") return "border-blue-500/50 bg-blue-950/20 hover:border-blue-400";
  if (s === "verifying") return "border-amber-500/50 bg-amber-950/20 hover:border-amber-400";
  if (s === "done") return "border-emerald-700/50 bg-emerald-950/10 hover:border-emerald-500";
  if (s === "blocked") return "border-red-700/50 bg-red-950/10 hover:border-red-500";
  return "border-neutral-800 bg-neutral-900 hover:border-neutral-600";
}

function dotClass(name: string): string {
  const s = nodeStatus(name);
  if (s === "running") return "bg-blue-400 animate-pulse";
  if (s === "verifying") return "bg-amber-400 animate-pulse";
  if (s === "done") return "bg-emerald-500";
  if (s === "blocked") return "bg-red-500";
  return "bg-neutral-600";
}

function nodeAgent(name: string): string | undefined {
  return byName.value.get(name)?.owner_agent;
}

function nodeDetail(name: string): string {
  const u = byName.value.get(name);
  if (!u) return "";
  const wait = waitingOn(u, byName.value);
  if (wait.length > 0) return `Waiting for: ${wait.join(", ")}`;
  if (u.status === "blocked") {
    const failed = Object.entries(u.gates)
      .filter(([, v]) => v === "fail")
      .map(([k]) => k);
    if (failed.length > 0) return `Failed: ${failed.join(", ")}`;
    return "Blocked";
  }
  return "";
}

function nodeAriaLabel(name: string): string {
  const u = byName.value.get(name);
  if (!u) return name;
  const detail = nodeDetail(name);
  return `${name} — ${u.status}${detail ? ` — ${detail}` : ""}`;
}
</script>
