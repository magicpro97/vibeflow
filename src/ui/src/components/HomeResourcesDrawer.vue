<template>
  <Transition name="home-drawer">
    <aside v-if="open" class="home-resources-drawer" aria-label="Resources">
      <header>
        <span><small>Repo usage</small><strong>Resources</strong></span>
        <button ref="closeButton" type="button" aria-label="Close resources" @click="$emit('close')">×</button>
      </header>
      <p v-if="!snapshot" class="home-drawer-copy">No workflow state yet.</p>
      <template v-else>
        <p class="home-resources-totals">{{ resourceSummaryLine(snapshot) }}</p>
        <section class="home-control-section" aria-labelledby="resources-engines-title">
          <div class="home-control-section__heading"><span><small>Settled work</small><strong id="resources-engines-title">Per engine</strong></span></div>
          <ul class="home-resources-list">
            <li v-for="row in snapshot.perEngine" :key="row.engine">
              <strong>{{ row.engine }}</strong>
              <span>{{ row.units }} units · {{ formatTokens(row.tokens) }} tokens · ${{ row.cost_usd }}</span>
            </li>
          </ul>
        </section>
        <section class="home-control-section" aria-labelledby="resources-units-title">
          <div class="home-control-section__heading"><span><small>Most expensive first</small><strong id="resources-units-title">Top units</strong></span></div>
          <ul class="home-resources-list">
            <li v-for="unit in topUnits" :key="unit.name">
              <strong>{{ unit.name }}</strong>
              <span>{{ formatTokens(unit.tokens) }} tokens · ${{ unit.cost_usd }}</span>
            </li>
          </ul>
        </section>
        <section v-if="snapshot.quota.length" class="home-control-section" aria-labelledby="resources-quota-title">
          <div class="home-control-section__heading"><span><small>Engine probe</small><strong id="resources-quota-title">Quota</strong></span></div>
          <ul class="home-resources-list">
            <li v-for="state in snapshot.quota" :key="state.engine">
              <strong>{{ state.engine }}</strong>
              <span>{{ quotaDetail(state) }}</span>
            </li>
          </ul>
        </section>
        <section v-if="snapshot.warnings.length" class="home-control-section" aria-labelledby="resources-warnings-title">
          <div class="home-control-section__heading"><span><small>Needs attention</small><strong id="resources-warnings-title">Warnings</strong></span></div>
          <ul class="home-resources-warnings">
            <li v-for="warning in snapshot.warnings" :key="warning">{{ warning }}</li>
          </ul>
        </section>
      </template>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ResourceQuotaView, ResourceSnapshot } from "../../../resources.js";
import { formatTokens, resourceSummaryLine, sortUnitRows } from "../lib/resource-view.js";
import { fetchResourceSnapshot } from "../resources-api.js";

const props = defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
const POLL_MS = 10_000;
const snapshot = ref<ResourceSnapshot | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const topUnits = computed(() => sortUnitRows(snapshot.value?.units ?? []).slice(0, 8));

function quotaDetail(state: ResourceQuotaView): string {
  const pct =
    state.percentRemaining !== undefined
      ? ` · ${Math.round(state.percentRemaining)}% remaining`
      : "";
  return `${state.level}${pct}${state.error ? ` · ${state.error}` : ""}`;
}

async function load() {
  try {
    snapshot.value = await fetchResourceSnapshot();
  } catch {
    // A transient fetch failure keeps the last snapshot; a first failure reads
    // as "No workflow state yet." until the 10 s poll recovers.
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await load();
    await nextTick();
    closeButton.value?.focus();
  },
  { immediate: true },
);

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => {
    if (props.open) void load();
  }, POLL_MS);
});
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer);
});
</script>
