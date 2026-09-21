<template>
  <div
    v-if="suggestion"
    class="home-project-chip"
    role="group"
    aria-label="Project suggestion"
    @keydown.esc.stop="dismiss"
  >
    <span class="home-project-chip__arrow" aria-hidden="true">→</span>
    <span class="home-project-chip__copy">
      Move to <span class="home-project-chip__project">{{ suggestedName }}</span>?
    </span>
    <span v-if="confidenceLabel" class="home-project-chip__confidence">{{ confidenceLabel }}</span>
    <button
      type="button"
      class="home-project-chip__confirm"
      :disabled="busy"
      @click="confirm"
    >{{ busy ? "Moving…" : "Move" }}</button>
    <button type="button" class="home-project-chip__dismiss" :disabled="busy" @click="dismiss">
      Keep in Ideas
    </button>
  </div>
  <p v-if="error" class="home-project-chip__error" role="alert">Không chuyển được: {{ error }}</p>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useProjectClassificationStore } from "../project-classification-store.js";
import { projectSuggestionConfidenceLabel } from "../project-rail-group.js";

/**
 * The composer's suggestion chip. It renders only what the classifier proposed: the visibility
 * gate already ran server-side and again in the runtime, so this component never decides whether
 * a move is warranted — it only offers the confirm the user must press.
 *
 * There is no create variant. The classifier's acceptance path (`project-classifier-authority`)
 * only ever returns a *registered* project id, so an unregistered id cannot reach this chip; the
 * "Tạo project mới" branch the mockup sketched had no backend and read as a dead control. It is
 * cut, and a proposal can only ever offer a move into a project the registry holds.
 *
 * The announcement is published through the store, which the composer's existing polite status
 * region renders — the chip adds no second live region.
 */
const store = useProjectClassificationStore();
const suggestion = computed(() => store.suggestion);

const suggestedName = computed(() => {
  const id = store.suggestion?.project_id ?? "";
  return store.projects.find((project) => project.id === id)?.name ?? id;
});
const confidenceLabel = computed(() =>
  store.suggestion ? projectSuggestionConfidenceLabel(store.suggestion) : "",
);
const busy = computed(() => store.suggestionBusy);
const error = computed(() => store.suggestionError);

function dismiss(): void {
  store.dismissSuggestion();
}

async function confirm(): Promise<void> {
  // Never auto-moves: the click is the whole authorization, and a failed move keeps the chip
  // on screen with the server's own reason instead of pretending it landed.
  await store.confirmSuggestion();
}
</script>
