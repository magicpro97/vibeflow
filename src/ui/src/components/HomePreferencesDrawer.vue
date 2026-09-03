<template>
  <Transition name="home-drawer">
    <aside v-if="open" class="home-preferences-drawer" aria-label="Conversation settings">
      <header>
        <span><small>Reviewed in chat</small><strong>Conversation settings</strong></span>
        <button ref="closeButton" type="button" aria-label="Close settings" @click="$emit('close')">×</button>
      </header>
      <p class="home-drawer-copy">
        These changes create a reviewed `conversation.update_settings` proposal. Nothing mutates directly from the browser.
      </p>

      <div v-if="!store.activeRevision" class="home-drawer-state">
        <strong>No active conversation</strong>
        <span>Open a conversation before preparing a settings change.</span>
      </div>
      <form v-else class="home-preferences-form" @submit.prevent="save">
        <fieldset>
          <legend>Conversation policy</legend>
          <label>
            <span><strong>Policy</strong><small>Current: {{ store.activeRevision.policy }}</small></span>
            <input v-model="form.policy" type="text" autocomplete="off" placeholder="direct" />
          </label>
        </fieldset>
        <fieldset>
          <legend>Execution controls</legend>
          <label class="home-timeout-setting">
            <span><strong>Max rounds</strong><small>Leave blank to keep the current value.</small></span>
            <input v-model="form.maxRounds" type="number" min="1" step="1" inputmode="numeric" />
          </label>
          <label>
            <span>
              <strong>Baseline context</strong>
              <small>Current value is not exposed in the public revision summary yet.</small>
            </span>
            <select v-model="form.baseline">
              <option value="unchanged">No change</option>
              <option value="enabled">Enable baseline</option>
              <option value="disabled">Disable baseline</option>
            </select>
          </label>
        </fieldset>
        <p class="home-settings-note">
          The browser can propose `max_rounds` and `baseline_enabled`, but today it can only display the current policy value from the public DTO.
        </p>
        <p v-if="error" class="home-settings-error" role="alert">{{ error }}</p>
        <p v-if="saved" class="home-settings-saved" role="status">Settings proposal added to the review queue.</p>
        <footer>
          <button type="button" class="home-button" @click="$emit('close')">Cancel</button>
          <button type="submit" class="home-button home-button--primary" :disabled="saving">
            {{ saving ? "Preparing…" : "Prepare reviewed change" }}
          </button>
        </footer>
      </form>
    </aside>
  </Transition>
</template>

<script setup lang="ts">
import { nextTick, reactive, ref, watch } from "vue";
import { buildConversationSettingsChanges } from "../conversation-home-settings.js";
import { useConversationHomeStore } from "../conversation-home-store.js";

const props = defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
const store = useConversationHomeStore();
const closeButton = ref<HTMLButtonElement | null>(null);
const saving = ref(false);
const saved = ref(false);
const error = ref("");
const form = reactive({
  policy: "",
  maxRounds: "",
  baseline: "unchanged" as "unchanged" | "enabled" | "disabled",
});

function primeForm() {
  form.policy = store.activeRevision?.policy ?? "";
  form.maxRounds = "";
  form.baseline = "unchanged";
  error.value = "";
  saved.value = false;
}

async function save() {
  const changes = buildConversationSettingsChanges(form, store.activeRevision?.policy ?? null);
  if (typeof changes === "string") {
    error.value = changes;
    saved.value = false;
    return;
  }
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    saved.value = await store.proposeSettings(changes);
  } finally {
    saving.value = false;
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    primeForm();
    await nextTick();
    closeButton.value?.focus();
  },
);
</script>
