/**
 * Project classification store: the registry the rail renders, the auto-classify switch, and the
 * composer's suggestion chip.
 *
 * A separate store rather than fields on `useConversationHomeStore`: the home store is at its
 * file-size ceiling and this slice has a one-way dependency on it (it reads the active session
 * and revision, never the reverse), so splitting costs nothing and keeps the rail free of
 * conversation-stream state.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "../../orchestrator/conversation/conversation-catalog-contract.js";
import { createHomeProjectRuntime } from "./conversation-home-projects.js";
import { useConversationHomeStore } from "./conversation-home-store.js";
import { conversationProjectApi } from "./conversation-project-api.js";

export const useProjectClassificationStore = defineStore("project-classification", () => {
  const home = useConversationHomeStore();
  /** Server state (`projectClassification.enabled`); ON until a settings read says otherwise. */
  const settings = ref<{ enabled: boolean } | null>(null);
  const classificationEnabled = computed(() => settings.value?.enabled ?? true);

  const runtime = createHomeProjectRuntime({
    client: conversationProjectApi,
    activeRootId: () => home.activeRootId,
    // The active revision owns the binding, so a verdict naming it is filtered as a non-move.
    activeProjectId: () => home.activeRevision?.project_id ?? CONVERSATION_DEFAULT_PROJECT_ID,
    autoClassify: () => classificationEnabled.value,
  });

  watch(classificationEnabled, (enabled) => {
    if (!enabled) runtime.reset();
  });

  return {
    projects: computed(() => runtime.projects.value),
    projectsLoaded: runtime.projectsLoaded,
    projectsError: runtime.projectsError,
    classificationEnabled,
    suggestion: runtime.suggestion,
    suggestionBusy: runtime.suggestionBusy,
    suggestionError: runtime.suggestionError,
    setSettings(value: { enabled: boolean } | null) {
      settings.value = value;
    },
    refreshProjects: runtime.loadProjects,
    classifyMessage: runtime.classifyAndPropose,
    propose: runtime.propose,
    dismissSuggestion: runtime.dismissSuggestion,
    confirmSuggestion: runtime.confirmSuggestion,
    reset: runtime.reset,
  };
});
