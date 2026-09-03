<template>
  <section
    v-if="privateRangeOpen"
    id="home-private-range-panel"
    class="home-private-range-panel"
    aria-labelledby="home-private-range-title"
  >
    <div class="home-private-range-panel__copy">
      <strong id="home-private-range-title">
        {{ store.privateContextPresent ? "Replace private file range" : "Attach a private file range" }}
      </strong>
      <p>
        Stage an exact repo-relative excerpt for this message or new conversation. Home keeps only a
        generic presence indicator after the server accepts it.
      </p>
    </div>
    <div class="home-private-range-grid">
      <label>
        <span>Path</span>
        <input
          ref="privatePathInput"
          v-model="privateRangeDraft.path"
          type="text"
          name="private-range-path"
          autocomplete="off"
          spellcheck="false"
          placeholder="src/server.ts"
        />
      </label>
      <label>
        <span>Start line</span>
        <input
          v-model="privateRangeDraft.startLine"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          name="private-range-start"
        />
      </label>
      <label>
        <span>End line</span>
        <input
          v-model="privateRangeDraft.endLine"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          name="private-range-end"
        />
      </label>
    </div>
    <div class="home-private-range-panel__actions">
      <button
        type="button"
        class="home-button home-button--primary"
        :disabled="privateRangeBusy"
        @click="stagePrivateRange"
      >
        {{ privateRangeBusy ? "Selecting…" : "Select range" }}
      </button>
      <button
        type="button"
        class="home-button"
        :disabled="privateRangeBusy"
        @click="resetPrivateRangeForm"
      >
        Reset
      </button>
      <button
        type="button"
        class="home-button"
        :disabled="privateRangeBusy"
        @click="closePrivateRangePanel"
      >
        Close
      </button>
    </div>
    <p v-if="privateRangeError" class="home-private-range-panel__error" role="alert">
      {{ privateRangeError }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { watch } from "vue";
import { useHomePrivateRangeComposer } from "../composables/useHomePrivateRangeComposer.js";
import { useConversationHomeStore } from "../conversation-home-store.js";

const emit = defineEmits<{ "open-change": [open: boolean] }>();
const store = useConversationHomeStore();
const {
  privatePathInput,
  privateRangeOpen,
  privateRangeBusy,
  privateRangeError,
  privateRangeDraft,
  resetPrivateRangeForm,
  closePrivateRangePanel,
  openPrivateRangePanel,
  stagePrivateRange,
} = useHomePrivateRangeComposer({
  stagePrivateContext: store.stagePrivateContext,
});

watch(privateRangeOpen, (open) => emit("open-change", open), { immediate: true });
defineExpose({ open: openPrivateRangePanel });
</script>
