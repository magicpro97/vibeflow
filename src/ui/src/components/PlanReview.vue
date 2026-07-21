<template>
  <div class="rounded border border-neutral-800/40 overflow-hidden" role="region" aria-label="Plan review">
    <div v-if="!store.repoPath" class="flex items-center justify-center h-96 text-neutral-500">
      <p class="text-[11px]">No repository context — choose a workflow from the dashboard or describe a new task.</p>
    </div>
    <div v-else class="flex h-96">
      <PlanRevisionRail
        :revisions="store.revisions"
        :active-id="store.activeRevisionId"
        :anchor="lastAnchor"
        :creating="creating"
        @select="store.activeRevisionId = $event"
        @create="handleCreate"
      />
      <PlanCanvas :blocks="store.activeBlocks" @anchor="onAnchor" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import type { BlockAnchor } from "../lib/plan-anchor.js";
import { useVfStore } from "../store.js";
import PlanCanvas from "./PlanCanvas.vue";
import PlanRevisionRail from "./PlanRevisionRail.vue";

const store = useVfStore();
const creating = ref(false);
const lastAnchor = ref<BlockAnchor | null>(null);

function onAnchor(a: BlockAnchor) {
  lastAnchor.value = a;
}

async function handleCreate(plan: string) {
  creating.value = true;
  try {
    await store.createRevision(plan);
  } finally {
    creating.value = false;
  }
}

watch(
  () => store.repoPath,
  (rp) => {
    if (rp) store.loadRevisions();
  },
  { immediate: true },
);
</script>
