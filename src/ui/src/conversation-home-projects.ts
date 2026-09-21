/**
 * Browser-side project runtime: the registry the rail renders, and the suggestion the composer
 * chip offers.
 *
 * Two separate authorities, deliberately:
 * - the registry (names/goals/engine overrides) is server state, fetched once and refreshed
 *   after a write;
 * - a suggestion is *client* state derived from a classifier verdict the server returned for a
 *   specific message. It is never inferred locally, because the tier ladder (repo/mention/fts/ai)
 *   and its acceptance floors live on the server and the UI must not re-implement them.
 */
import { ref, shallowRef } from "vue";
import {
  type ProjectClassificationReason,
  type ProjectRailProject,
  isProjectSuggestionVisible,
} from "./project-rail-group.js";
import type { ProjectClassificationSlice } from "./project-settings-form.js";

/** Registry row as the rail and the settings panel consume it. */
export interface HomeProjectRow extends ProjectRailProject {
  id: string;
  name: string;
  goal: string;
  engine: { cli: string; model: string | null; thinking: string };
}

/** The classifier verdict for one message, exactly as the server reported it. */
export interface HomeProjectClassification {
  project_id: string;
  confidence: number;
  reason: ProjectClassificationReason;
}

/** A live proposal for the composer chip: the verdict plus the message it belongs to. */
export interface HomeProjectSuggestion {
  root_session_id: string;
  current_project_id: string;
  project_id: string;
  confidence: number;
  reason: ProjectClassificationReason;
}

export interface HomeProjectClient {
  listProjects(signal?: AbortSignal): Promise<HomeProjectRow[]>;
  classifyMessage(
    input: { message: string; project_id: string },
    signal?: AbortSignal,
  ): Promise<HomeProjectClassification>;
  updateProjectEngine(
    projectId: string,
    engine: HomeProjectRow["engine"],
    signal?: AbortSignal,
  ): Promise<void>;
  moveConversation(
    input: { root_session_id: string; project_id: string },
    signal?: AbortSignal,
  ): Promise<void>;
  /** The stored `projectClassification` block, or null when the document has none yet. */
  readProjectSettings(signal?: AbortSignal): Promise<ProjectClassificationSlice | null>;
  /** Replace-on-write, mirroring the settings document: the block handed in is the block stored. */
  writeProjectSettings(
    value: ProjectClassificationSlice,
    signal?: AbortSignal,
  ): Promise<ProjectClassificationSlice | null>;
}

/** Dismissal is remembered per (session, project) so one ignore is final for that proposal. */
const suggestionKey = (suggestion: HomeProjectSuggestion): string =>
  `${suggestion.root_session_id}\u0000${suggestion.project_id}`;

/**
 * Where dismissal memory lives. Injectable so the runtime stays testable without a DOM, and
 * optional so a runtime without a store (tests, non-browser hosts) keeps working in-memory.
 * The mockup requires the memory to outlive a reload: an ignored proposal must not return on the
 * next visit, which is exactly what an in-process `Set` cannot promise.
 */
export interface HomeProjectDismissalStoreV1 {
  read(): string[];
  write(keys: readonly string[]): void;
}

/** `localStorage`-backed memory, keyed per repo-agnostic conversation surface. */
export function createBrowserProjectDismissalStore(
  storage: Pick<Storage, "getItem" | "setItem">,
  key = "vf-project-dismissals",
): HomeProjectDismissalStoreV1 {
  const parse = (): string[] => {
    try {
      const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  };
  return {
    read: parse,
    write(keys) {
      // Bounded so a long-lived surface cannot grow the entry without limit; the oldest go first.
      storage.setItem(key, JSON.stringify(keys.slice(-256)));
    },
  };
}

export function createHomeProjectRuntime(options: {
  client: HomeProjectClient;
  /** The conversation a proposal would move; absent means no conversation is open. */
  activeRootId: () => string | null;
  /** The project the active conversation is already in; a verdict naming it is not a move. */
  activeProjectId: () => string;
  /** Persisted switch: OFF means the classifier never runs and nothing is proposed. */
  autoClassify: () => boolean;
  /** Cross-reload dismissal memory; omitted = in-process only. */
  dismissals?: HomeProjectDismissalStoreV1;
}) {
  const projects = ref<HomeProjectRow[]>([]);
  /** True once a registry read completed; distinguishes "none" from "not loaded yet". */
  const projectsLoaded = ref(false);
  const projectsError = ref("");
  const suggestion = shallowRef<HomeProjectSuggestion | null>(null);
  const suggestionBusy = ref(false);
  const suggestionError = ref("");
  const dismissed = new Set<string>(options.dismissals?.read() ?? []);

  async function loadProjects(): Promise<void> {
    try {
      projects.value = await options.client.listProjects();
      projectsError.value = "";
    } catch (error) {
      // A failed read is not fatal: the rail falls back to slug labels and the catch-all group.
      projectsError.value = error instanceof Error ? error.message : String(error);
    } finally {
      projectsLoaded.value = true;
    }
  }

  /** The single gate: the server decided the tier, the UI only applies the visibility rule. */
  function propose(
    classification: HomeProjectClassification,
    forRootSessionId: string | null = options.activeRootId(),
  ): void {
    if (!forRootSessionId || !options.autoClassify()) {
      suggestion.value = null;
      return;
    }
    const currentProjectId = options.activeProjectId();
    const candidate: HomeProjectSuggestion = {
      root_session_id: forRootSessionId,
      current_project_id: currentProjectId,
      project_id: classification.project_id,
      confidence: classification.confidence,
      reason: classification.reason,
    };
    // A deterministic tier (repo/mention) bound the conversation at creation and a fallback
    // proposes nothing; both are filtered here, so no control ever offers a move the tier ladder
    // did not ask for. Dismissal is checked last: a new proposal for the same (session, project)
    // pair must not resurrect an ignored one.
    if (!isProjectSuggestionVisible(candidate)) {
      suggestion.value = null;
      return;
    }
    if (dismissed.has(suggestionKey(candidate))) {
      suggestion.value = null;
      return;
    }
    suggestion.value = candidate;
  }

  /**
   * Classify one sent message and propose. The session is captured *before* the round trip and
   * passed into `propose`, because re-reading the active session after the await would file a
   * verdict inferred from the old message against whichever conversation the user has since
   * switched to — and confirming that chip would then move the wrong conversation.
   */
  async function classifyAndPropose(message: string): Promise<void> {
    if (!options.autoClassify()) return;
    const rootSessionId = options.activeRootId();
    if (!rootSessionId || message.trim() === "") return;
    try {
      const verdict = await options.client.classifyMessage({
        message,
        project_id: options.activeProjectId(),
      });
      if (options.activeRootId() !== rootSessionId) return;
      propose(verdict, rootSessionId);
    } catch {
      // Classification is advisory: a failure proposes nothing rather than surfacing an error.
      suggestion.value = null;
    }
  }

  function dismissSuggestion(): void {
    const current = suggestion.value;
    if (current) {
      dismissed.add(suggestionKey(current));
      // Best-effort: a storage refusal must not undo a dismissal the user already made.
      try {
        options.dismissals?.write([...dismissed]);
      } catch {
        /* in-memory memory remains authoritative for this session */
      }
    }
    suggestion.value = null;
    suggestionError.value = "";
  }

  /**
   * Confirm is the ONLY path that moves a conversation. It reports what the server actually
   * did: a runtime with no durable re-bind answers 503, and that message is surfaced verbatim
   * with the chip still on screen — never a silent success.
   */
  async function confirmSuggestion(): Promise<boolean> {
    const current = suggestion.value;
    if (!current) return false;
    suggestionBusy.value = true;
    suggestionError.value = "";
    try {
      await options.client.moveConversation({
        root_session_id: current.root_session_id,
        project_id: current.project_id,
      });
      suggestion.value = null;
      await loadProjects();
      return true;
    } catch (error) {
      suggestionError.value = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      suggestionBusy.value = false;
    }
  }

  function reset(): void {
    suggestion.value = null;
    suggestionError.value = "";
  }

  return {
    projects,
    projectsLoaded,
    projectsError,
    suggestion,
    suggestionBusy,
    suggestionError,
    loadProjects,
    classifyAndPropose,
    propose,
    dismissSuggestion,
    confirmSuggestion,
    reset,
  };
}
