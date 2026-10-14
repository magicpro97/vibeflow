<template>
  <section class="home-resources-panel" aria-label="Resources">
    <!-- The sidebar keeps this panel mounted across tab switches (v-show), so the
         repo-scoped snapshot needs a manual refetch — mirror the Files/Changes
         Refresh. ponytail: share one toolbar component if a fourth panel appears. -->
    <header class="home-changes__toolbar">
      <button
        class="home-changes__refresh"
        type="button"
        aria-label="Refresh resources"
        :disabled="loading"
        @click="void load()"
      >
        Refresh
      </button>
    </header>
    <p v-if="error" class="home-files-error" role="alert">Cannot read resources: {{ error }}</p>
    <p v-else-if="loading && !snapshot" class="home-drawer-copy" role="status">
      Loading resources…
    </p>
    <p v-else-if="!snapshot" class="home-drawer-copy">No workflow state yet.</p>
    <template v-if="snapshot">
      <p class="home-resources-totals">{{ resourceSummaryLine(snapshot) }}</p>
      <section class="home-control-section" aria-labelledby="resources-engines-title">
        <div class="home-control-section__heading">
          <span><small>Settled work</small><strong id="resources-engines-title">Per engine</strong></span>
        </div>
        <ul class="home-resources-list">
          <li v-for="row in snapshot.perEngine" :key="row.engine">
            <strong>{{ row.engine }}</strong>
            <span>{{ row.units }} units · {{ formatTokens(row.tokens) }} tokens · ${{ row.cost_usd }}</span>
          </li>
        </ul>
      </section>
      <section class="home-control-section" aria-labelledby="resources-units-title">
        <div class="home-control-section__heading">
          <span><small>Most expensive first</small><strong id="resources-units-title">Top units</strong></span>
        </div>
        <ul class="home-resources-list">
          <li v-for="unit in topUnits" :key="unit.name">
            <strong>{{ unit.name }}</strong>
            <span>{{ formatTokens(unit.tokens) }} tokens · ${{ unit.cost_usd }}</span>
          </li>
        </ul>
      </section>
      <section
        v-if="snapshot.quota.length"
        class="home-control-section"
        aria-labelledby="resources-quota-title"
      >
        <div class="home-control-section__heading">
          <span><small>Engine probe</small><strong id="resources-quota-title">Quota</strong></span>
        </div>
        <ul class="home-resources-list">
          <li v-for="state in snapshot.quota" :key="state.engine">
            <strong>{{ state.engine }}</strong>
            <span>{{ quotaDetail(state) }}</span>
          </li>
        </ul>
      </section>
      <section
        v-if="snapshot.warnings.length"
        class="home-control-section"
        aria-labelledby="resources-warnings-title"
      >
        <div class="home-control-section__heading">
          <span><small>Needs attention</small><strong id="resources-warnings-title">Warnings</strong></span>
        </div>
        <ul class="home-resources-warnings">
          <li v-for="warning in snapshot.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ResourceQuotaView, ResourceSnapshot } from "../../../resources.js";
import { formatTokens, resourceSummaryLine, sortUnitRows } from "../lib/resource-view.js";
import { fetchResourceSnapshot } from "../resources-api.js";

const snapshot = ref<ResourceSnapshot | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const topUnits = computed(() => sortUnitRows(snapshot.value?.units ?? []).slice(0, 8));

function quotaDetail(state: ResourceQuotaView): string {
  const pct =
    state.percentRemaining !== undefined
      ? ` · ${Math.round(state.percentRemaining)}% remaining`
      : "";
  return `${state.level}${pct}${state.error ? ` · ${state.error}` : ""}`;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    snapshot.value = await fetchResourceSnapshot();
    error.value = null;
  } catch (cause) {
    // Keep the last snapshot (a transient failure must not blank the board) but
    // surface the failure instead of letting it read as "No workflow state yet.".
    error.value = cause instanceof Error ? cause.message : "Unknown error";
  } finally {
    loading.value = false;
  }
}

// Load once at mount; the sidebar keeps the instance alive across tab switches.
onMounted(() => void load());
</script>
