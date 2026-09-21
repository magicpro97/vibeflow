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
      <template v-if="isCreate">Tạo project mới "{{ suggestedName }}"?</template>
      <template v-else>Move to <span class="home-project-chip__project">{{ suggestedName }}</span>?</template>
    </span>
    <span v-if="confidenceLabel" class="home-project-chip__confidence">{{ confidenceLabel }}</span>
    <button
      type="button"
      class="home-project-chip__confirm"
      :disabled="busy"
      @click="confirm"
    >{{ confirmLabel }}</button>
    <button type="button" class="home-project-chip__dismiss" :disabled="busy" @click="dismiss">
      {{ isCreate ? "Bỏ qua" : "Not now" }}
    </button>
  </div>
  <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
    {{ announcement }}
  </div>
  <p v-if="error" class="home-project-chip__error" role="alert">
    Không chuyển được: {{ error }}
  </p>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useProjectClassificationStore } from "../project-classification-store.js";
import { projectSuggestionConfidenceLabel } from "../project-rail-group.js";

/**
 * The composer's suggestion chip. It renders only what the classifier proposed: the visibility
 * gate already ran server-side and again in the runtime, so this component never decides whether
 * a move is warranted — it only offers the confirm the user must press.
 */
const store = useProjectClassificationStore();
const suggestion = computed(() => store.suggestion);

/** A proposal naming an unregistered project is a create offer, not a move. */
const isCreate = computed(
  () => !store.projects.some((project) => project.id === store.suggestion?.project_id),
);
const suggestedName = computed(() => {
  const id = store.suggestion?.project_id ?? "";
  return store.projects.find((project) => project.id === id)?.name ?? id;
});
const confidenceLabel = computed(() =>
  store.suggestion ? projectSuggestionConfidenceLabel(store.suggestion) : "",
);
const busy = computed(() => store.suggestionBusy);
const error = computed(() => store.suggestionError);
const confirmLabel = computed(() => (busy.value ? "Moving…" : isCreate.value ? "Tạo" : "Move"));
const announcement = computed(() => {
  const current = store.suggestion;
  if (!current) return "";
  return `Đề xuất project: ${suggestedName.value}. Nhấn Tab để chuyển.`;
});

function dismiss(): void {
  store.dismissSuggestion();
}

async function confirm(): Promise<void> {
  // Never auto-moves: the click is the whole authorization, and a failed move keeps the chip
  // on screen with the server's own reason instead of pretending it landed.
  await store.confirmSuggestion();
}
</script>
