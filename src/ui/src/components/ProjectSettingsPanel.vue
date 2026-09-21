<template>
  <fieldset class="home-project-settings">
    <legend>Project classification</legend>
    <p class="home-project-settings__copy">
      Tier ladder: repo → @mention → index → AI (chỉ khi mơ hồ). When auto-classify is off the
      classifier never runs, no suggestion is offered, and conversations stay in Ideas.
    </p>

    <label class="home-project-settings__row">
      <span>Auto-classify new conversations</span>
      <input
        type="checkbox"
        :checked="draft.enabled"
        :disabled="saving"
        @change="draft.enabled = ($event.target as HTMLInputElement).checked"
      />
    </label>

    <div class="home-project-settings__row">
      <label :for="cliId">Classifier CLI</label>
      <select :id="cliId" v-model="draft.cli" :disabled="saving">
        <option value="">Auto (recommended)</option>
        <option v-for="engine in engineOptions" :key="engine" :value="engine">{{ engine }}</option>
      </select>
    </div>
    <div class="home-project-settings__row">
      <label :for="modelId">Classifier model</label>
      <input :id="modelId" v-model="draft.model" type="text" autocomplete="off" :disabled="saving" placeholder="engine default" />
    </div>
    <div class="home-project-settings__row">
      <label :for="thinkingId">Thinking effort</label>
      <input
        :id="thinkingId"
        v-model="draft.thinking"
        type="text"
        autocomplete="off"
        :disabled="saving"
        list="home-thinking-suggestions"
        placeholder="low"
      />
      <datalist id="home-thinking-suggestions">
        <option v-for="value in thinkingSuggestions" :key="value" :value="value" />
      </datalist>
    </div>
    <p v-if="!draft.enabled" class="home-project-settings__note">
      Không dùng khi tự động phân loại đang tắt.
    </p>

    <div class="home-project-settings__overrides">
      <button
        type="button"
        class="home-project-settings__overrides-head"
        :aria-expanded="overridesOpen"
        aria-controls="project-overrides"
        @click="overridesOpen = !overridesOpen"
      >
        <span>Per-project engine override ({{ overriddenCount }})</span>
        <span aria-hidden="true">{{ overridesOpen ? "▾" : "▸" }}</span>
      </button>
      <div v-show="overridesOpen" id="project-overrides">
        <p v-if="!overrideRows.length" class="home-project-settings__copy">
          No projects registered yet.
        </p>
        <div
          v-for="entry in editableOverrides"
          :key="entry.project.id"
          class="home-project-settings__override"
        >
          <span class="home-project-settings__override-name">
            {{ entry.project.name ?? entry.project.id }}
          </span>
          <select
            v-model="entry.row.cli"
            :disabled="saving"
            :aria-label="`${entry.project.name ?? entry.project.id} CLI override`"
          >
            <option value="">inherit</option>
            <option v-for="engine in engineOptions" :key="engine" :value="engine">{{ engine }}</option>
          </select>
          <input
            v-model="entry.row.model"
            type="text"
            autocomplete="off"
            :disabled="saving"
            :aria-label="`${entry.project.name ?? entry.project.id} model override`"
            placeholder="model…"
          />
          <input
            v-model="entry.row.thinking"
            type="text"
            autocomplete="off"
            :disabled="saving"
            list="home-thinking-suggestions"
            :aria-label="`${entry.project.name ?? entry.project.id} thinking override`"
            placeholder="inherit"
          />
        </div>
      </div>
    </div>

    <p v-if="error" class="home-project-settings__error" role="alert">{{ error }}</p>
    <p v-if="saved" class="home-project-settings__saved" role="status">Saved</p>
  </fieldset>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api } from "../api.js";
import type { HomeProjectRow } from "../conversation-home-projects.js";
import { conversationProjectApi } from "../conversation-project-api.js";
import { useProjectClassificationStore } from "../project-classification-store.js";
import {
  PROJECT_ENGINE_OPTIONS,
  PROJECT_THINKING_SUGGESTIONS,
  type ProjectClassificationDraft,
  buildProjectClassificationPatch,
  buildProjectEnginePatch,
  projectOverrideRows,
} from "../project-settings-form.js";

/**
 * Project classification settings: the global switch + classifier engine, and one override row
 * per registered project.
 *
 * Inherit is the empty state (a blank row), never a literal "none": a row with every field blank
 * persists nothing, and the row placeholder text mirrors "the default applies". Thinking stays
 * free text with suggestions because the effort vocabulary differs per CLI.
 */
const emit = defineEmits<{ saved: [] }>();

const store = useProjectClassificationStore();
const saving = ref(false);
const saved = ref(false);
const error = ref("");
const overridesOpen = ref(false);
const cliId = "project-classifier-cli";
const modelId = "project-classifier-model";
const thinkingId = "project-classifier-thinking";

const draft = reactive<{ enabled: boolean } & ProjectClassificationDraft["engine"]>({
  enabled: true,
  cli: "",
  model: "",
  thinking: "",
});

/** One editable row per project id; rebuilt whenever the registry changes. */
const rows = reactive<Record<string, { cli: string; model: string; thinking: string }>>({});
const overrideRows = computed(() => projectOverrideRows(store.projects));
const engineOptions = PROJECT_ENGINE_OPTIONS;
const thinkingSuggestions = PROJECT_THINKING_SUGGESTIONS;
const overriddenCount = computed(
  () =>
    Object.values(rows).filter(
      (row) => row.cli.trim() !== "" || row.model.trim() !== "" || row.thinking.trim() !== "",
    ).length,
);

/** The empty draft for a project: its stored engine, or blank when it has none. */
function seedRow(engine: HomeProjectRow["engine"]) {
  return { cli: engine.cli ?? "", model: engine.model ?? "", thinking: engine.thinking ?? "" };
}

/** Seed a row per project from its stored engine. Existing drafts win, so typing is not lost. */
function syncRows(): void {
  for (const project of store.projects) {
    if (!rows[project.id]) rows[project.id] = seedRow(project.engine);
  }
}

watch(() => store.projects, syncRows, { immediate: true });

/** Registry rows paired with their editable draft, so the template never indexes blind. */
const editableOverrides = computed(() =>
  overrideRows.value.map((project) => ({
    project,
    row: rows[project.id] ?? seedRow(project.engine),
  })),
);

onMounted(async () => {
  try {
    const settings = await api.settings.get();
    const stored = settings.projectClassification;
    if (stored) {
      draft.enabled = stored.enabled;
      draft.cli = stored.engine.cli ?? "";
      draft.model = stored.engine.model ?? "";
      draft.thinking = stored.engine.thinking ?? "";
    }
    store.setSettings(stored ? { enabled: stored.enabled } : null);
  } catch (cause) {
    // A failed settings read keeps the defaults on screen; the save path reports the real error.
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
  await store.refreshProjects();
  syncRows();
});

/** Persist the global block, then every override row that differs from what is stored. */
async function save(): Promise<boolean> {
  saving.value = true;
  error.value = "";
  saved.value = false;
  try {
    const global = buildProjectClassificationPatch({
      autoClassify: draft.enabled,
      engine: { cli: draft.cli, model: draft.model, thinking: draft.thinking },
    });
    if (typeof global === "string") {
      error.value = global;
      return false;
    }
    await api.settings.set(global);
    store.setSettings({ enabled: draft.enabled });
    for (const project of store.projects) {
      const row = rows[project.id];
      if (!row) continue;
      const patch = buildProjectEnginePatch({ id: project.id, ...row });
      if (typeof patch === "string") {
        error.value = patch;
        return false;
      }
      // `null` is "inherit": the row persists nothing and the stored engine is left alone.
      if (patch === null) continue;
      if (
        patch.engine.cli === project.engine.cli &&
        patch.engine.model === project.engine.model &&
        patch.engine.thinking === project.engine.thinking
      )
        continue;
      await conversationProjectApi.updateProjectEngine(project.id, patch.engine);
    }
    await store.refreshProjects();
    syncRows();
    saved.value = true;
    emit("saved");
    return true;
  } catch (cause) {
    // The form keeps its values: a failed save must never look like a silent revert.
    error.value = cause instanceof Error ? cause.message : String(cause);
    return false;
  } finally {
    saving.value = false;
  }
}

defineExpose({ save });
</script>
