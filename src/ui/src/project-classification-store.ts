/**
 * Project classification store: the registry the rail renders, the auto-classify switch, and the
 * composer's suggestion chip.
 *
 * A separate store rather than fields on `useConversationHomeStore`: the home store is at its
 * file-size ceiling and this slice has a one-way dependency on it (it reads the active session
 * and revision, never the reverse), so splitting costs nothing and keeps the rail free of
 * conversation-stream state.
 *
 * The switch is read from the settings document at first use, not when a panel happens to mount:
 * OFF is a *durable gate* ("the classifier never runs"), so a reload must not resurrect the chip
 * merely because the preferences drawer stayed closed. It is likewise persisted on change, so the
 * value the user set is the value the next send obeys.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "../../orchestrator/conversation/conversation-catalog-contract.js";
import {
  type HomeProjectClassification,
  createBrowserProjectDismissalStore,
  createHomeProjectRuntime,
} from "./conversation-home-projects.js";
import { useConversationHomeStore } from "./conversation-home-store.js";
import { conversationProjectApi } from "./conversation-project-api.js";
import { projectSuggestionAnnouncement } from "./project-rail-group.js";
import type { VibeSettings } from "./types.js";

/** The settings block this store owns; the engine fields ride along untouched. */
type ProjectClassificationSlice = NonNullable<VibeSettings["projectClassification"]>;

export const useProjectClassificationStore = defineStore("project-classification", () => {
  const home = useConversationHomeStore();
  /** Server state (`projectClassification.enabled`); ON until a settings read says otherwise. */
  const settings = ref<ProjectClassificationSlice | null>(null);
  const settingsError = ref("");
  const settingsLoaded = ref(false);
  let loading: Promise<void> | null = null;
  const classificationEnabled = computed(() => settings.value?.enabled ?? true);

  const runtime = createHomeProjectRuntime({
    client: conversationProjectApi,
    activeRootId: () => home.activeRootId,
    // The active revision owns the binding, so a verdict naming it is filtered as a non-move.
    activeProjectId: () => home.activeRevision?.project_id ?? CONVERSATION_DEFAULT_PROJECT_ID,
    autoClassify: () => classificationEnabled.value,
    // The rail groups the sessions list, so a landed move must re-read it — a chip confirm that
    // refreshed only the registry would leave the conversation under Ideas.
    refreshSessions: () => home.refreshSessions(),
    // Survives a reload: the mockup's dismissal contract is "one ignore is final for that
    // proposal", which an in-process Set cannot keep across a visit.
    ...(typeof localStorage === "undefined"
      ? {}
      : { dismissals: createBrowserProjectDismissalStore(localStorage) }),
  });

  watch(classificationEnabled, (enabled) => {
    if (!enabled) runtime.reset();
  });

  /** Registry display name for a project id, falling back to the slug the rail already shows. */
  function displayName(projectId: string): string {
    return runtime.projects.value.find((project) => project.id === projectId)?.name ?? projectId;
  }

  async function loadSettings(): Promise<void> {
    // One read per process: the value only changes through this store's own writes.
    if (settingsLoaded.value) return;
    loading ??= (async () => {
      try {
        settings.value = await conversationProjectApi.readProjectSettings();
        settingsError.value = "";
      } catch (error) {
        // A failed read keeps the last known value on screen; the write path reports the reason.
        settingsError.value = error instanceof Error ? error.message : String(error);
      } finally {
        settingsLoaded.value = true;
        loading = null;
      }
    })();
    await loading;
  }

  /** Persist the complete global block (the panel's Save); replace-on-write, like the document. */
  async function saveSettings(value: ProjectClassificationSlice): Promise<boolean> {
    const prior = settings.value;
    settings.value = value;
    try {
      settings.value = await conversationProjectApi.writeProjectSettings(value);
      settingsError.value = "";
      settingsLoaded.value = true;
      return true;
    } catch (error) {
      // Never leave the UI claiming a value the server refused.
      settings.value = prior;
      settingsError.value = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** Persist the whole block (replace-on-write), so a toggle never wipes the stored engine. */
  async function setEnabled(enabled: boolean): Promise<boolean> {
    const prior = settings.value;
    return saveSettings({
      ...(prior ?? { engine: { cli: null, model: null, thinking: null } }),
      enabled,
    });
  }

  /**
   * Read once at store construction: the store is created by the rail (always mounted while the
   * conversation surface exists), and the switch must gate classification before the first send —
   * waiting for the preferences drawer to mount would leave OFF non-durable across a reload.
   */
  void loadSettings();

  return {
    projects: computed(() => runtime.projects.value),
    projectsLoaded: runtime.projectsLoaded,
    projectsError: runtime.projectsError,
    classificationEnabled,
    settings,
    settingsError,
    settingsLoaded,
    suggestion: runtime.suggestion,
    suggestionBusy: runtime.suggestionBusy,
    suggestionError: runtime.suggestionError,
    loadSettings,
    saveSettings,
    setEnabled,
    refreshProjects: runtime.loadProjects,
    classifyMessage: runtime.classifyAndPropose,
    /**
     * The chip publishes into the composer's existing polite region rather than adding a second
     * live region: transport is the home store's announcement channel, which HomeComposerStatus
     * renders. Announcements are written at each transition (not watched) so the *confirmed*
     * text can never be clobbered by a queued watcher firing on a later microtask.
     */
    propose(classification: HomeProjectClassification) {
      runtime.propose(classification);
      const current = runtime.suggestion.value;
      if (current)
        home.queueAnnouncement = projectSuggestionAnnouncement(displayName(current.project_id));
    },
    dismissSuggestion() {
      runtime.dismissSuggestion();
      home.queueAnnouncement = "";
    },
    /**
     * Confirm, then announce what the server actually did through the composer's existing polite
     * region. There is no Undo: the mockup's reversal affordance was cut because the server has
     * no durable "move back" either — a second confirmed move is the reversal, and pretending
     * otherwise would be a control that cannot keep its promise.
     */
    async confirmSuggestion(): Promise<boolean> {
      const target = runtime.suggestion.value?.project_id ?? "";
      const moved = await runtime.confirmSuggestion();
      // A failed move keeps the chip, so its announcement stays too; only a landed move replaces it.
      if (moved) home.queueAnnouncement = `Đã chuyển sang ${displayName(target)}`;
      return moved;
    },
    reset: runtime.reset,
  };
});
