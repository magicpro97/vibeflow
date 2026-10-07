<template>
  <div v-if="line" class="home-update-banner">
    <span role="status">{{ line }}</span>
    <button
      v-if="status?.upgrade_available"
      type="button"
      :disabled="busy"
      @click="run(UPDATE_RUN_ACTION.UPDATE)"
    >
      {{ busy ? "Starting…" : "Update now" }}
    </button>
    <button
      v-if="status?.rollback"
      type="button"
      :disabled="busy"
      @click="run(UPDATE_RUN_ACTION.ROLLBACK)"
    >
      Rollback
    </button>
    <span v-if="started" class="home-update-banner__started" role="status">{{ started }}</span>
    <button
      type="button"
      class="home-update-banner__dismiss"
      aria-label="Dismiss update notice"
      @click="dismissed = true"
    >
      ×
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { UPDATE_RUN_ACTION, type UpdateRunAction } from "../../../update/update-status-contract.js";
import { fetchUpdateStatus, runUpdate } from "../update-api.js";
import { type UpdateStatusView, bannerLine } from "../update-banner-model.js";

const status = ref<UpdateStatusView | null>(null);
const busy = ref(false);
const started = ref("");
const dismissed = ref(false);
const line = computed(() =>
  dismissed.value || status.value === null ? null : bannerLine(status.value),
);

onMounted(async () => {
  try {
    status.value = await fetchUpdateStatus();
  } catch {
    /* banner is advisory — a failed status read renders nothing */
  }
});

async function run(action: UpdateRunAction): Promise<void> {
  busy.value = true;
  try {
    await runUpdate(action);
    // stdio:"ignore" + detached: the child prints NOWHERE — do NOT tell the
    // user to look in the terminal. The UI picks the new version up on drain
    // (PR #827); vf doctor shows the update state if it does not.
    started.value =
      action === UPDATE_RUN_ACTION.ROLLBACK
        ? "Rollback started in the background"
        : "Update started in the background";
  } catch {
    started.value = "Could not start the update — run vf update in your terminal";
  } finally {
    busy.value = false;
  }
}
</script>
