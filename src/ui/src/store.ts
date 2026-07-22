import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "./api.js";
import type { AskPrefill } from "./lib/ask-prefill.js";
import { type RenderDescriptor, renderBlocks } from "./lib/plan-render.js";
import { resolveRepoPath } from "./lib/resolve-repo-path.js";
import type {
  PlanComment,
  PlanRevision,
  ProjectEntry,
  VibeSettings,
  WorkflowDashboardItem,
  WorkflowState,
} from "./types.js";

/** Pure function — extracted for testability without Pinia context. */
export function stageReachable(n: 1 | 2 | 3 | 4, state: WorkflowState | null): boolean {
  if (n === 1) return true;
  if (n === 2) return state !== null;
  // Stage 3 reachable when there is a goal — units are created by orchestrate on Stage 3 itself
  if (n === 3) return state !== null;
  if (n === 4) {
    const units = state?.work_units ?? [];
    // Allow verify even if all units blocked — user shouldn't be stuck forever
    return units.length > 0 && units.every((u) => u.status === "done" || u.status === "blocked");
  }
  return false;
}

export const useVfStore = defineStore("vf", () => {
  const stage = ref<0 | 1 | 2 | 3 | 4>(1);
  const state = ref<WorkflowState | null>(null);
  const settings = ref<VibeSettings | null>(null);
  const logsOpen = ref(false); // controlled here so any component can open logs
  const version = document.querySelector<HTMLMetaElement>('meta[name="vf-version"]')?.content ?? "";
  const projects = ref<ProjectEntry[]>([]);
  const reuseGoal = ref<string | null>(null); // one-shot prefill for Stage1Describe
  const askOpen = ref(false);
  const askPrefill = ref<AskPrefill | null>(null);
  const selectedWorkflowKey = ref<string | null>(null);
  const selectedUnit = ref<string | null>(null);
  const dashboardWorkflows = ref<WorkflowDashboardItem[]>([]);

  function selectWorkflow(key: string | null) {
    selectedWorkflowKey.value = key;
    selectedUnit.value = null;
  }

  function selectUnit(name: string | null) {
    selectedUnit.value = name;
  }

  // ── Plan Review state ──
  const revisions = ref<PlanRevision[]>([]);
  const activeRevisionId = ref<string | null>(null);

  const activeRevision = computed(
    () => revisions.value.find((r) => r.id === activeRevisionId.value) ?? null,
  );

  const activeBlocks = computed<RenderDescriptor[]>(() => {
    const rev = activeRevision.value;
    if (!rev) return [];
    return renderBlocks(rev.blocks);
  });

  // ── Comment state ──
  const comments = ref<PlanComment[]>([]);
  const commentLoading = ref(false);

  async function loadComments() {
    const rp = currentRepoPath();
    const wfId = state.value?.task_id;
    const revId = activeRevisionId.value;
    if (!rp || !wfId || !revId) return;
    commentLoading.value = true;
    try {
      comments.value = await api.planReview.comments.list(rp, wfId, revId);
    } catch {
      comments.value = [];
    } finally {
      commentLoading.value = false;
    }
  }

  async function createComment(
    body: string,
    anchor?: import("./types.js").PlanCommentAnchor,
    parentId?: string,
  ) {
    const rp = currentRepoPath();
    const wfId = state.value?.task_id;
    const revId = activeRevisionId.value;
    if (!rp || !wfId || !revId) return;
    await api.planReview.comments.create({
      repoPath: rp,
      workflowId: wfId,
      revisionId: revId,
      parentId,
      anchor,
      body,
      createdBy: { type: "user" as const, id: "user", name: "User" },
    });
    await loadComments();
  }

  async function updateComment(id: string, body: string) {
    const rp = currentRepoPath();
    const wfId = state.value?.task_id;
    if (!rp || !wfId) return;
    await api.planReview.comments.update(id, body, rp, wfId);
    await loadComments();
  }

  async function deleteComment(id: string) {
    const rp = currentRepoPath();
    const wfId = state.value?.task_id;
    if (!rp || !wfId) return;
    await api.planReview.comments.delete(id, rp, wfId);
    await loadComments();
  }

  async function submitComment(id: string) {
    const rp = currentRepoPath();
    const wfId = state.value?.task_id;
    if (!rp || !wfId) return;
    await api.planReview.comments.submit(id, rp, wfId);
    await loadComments();
  }

  /** Resolve repoPath with safe precedence (delegates to pure resolver). */
  function currentRepoPath(): string | null {
    return resolveRepoPath(selectedWorkflowKey.value, state.value, dashboardWorkflows.value);
  }

  const repoPath = computed(() => currentRepoPath());

  async function loadRevisions() {
    const rp = currentRepoPath();
    const wfId = state.value?.task_id;
    if (!rp || !wfId) return;
    try {
      const data = await api.planReview.get(rp, wfId);
      if (data) {
        revisions.value = data.revisions;
        activeRevisionId.value = data.revision.id;
      }
    } catch {
      /* plan-review endpoint may not exist yet */
    }
  }

  async function createRevision(markdown: string) {
    const rp = currentRepoPath();
    const wfId = state.value?.task_id;
    if (!rp || !wfId) return;
    await api.planReview.create({
      repoPath: rp,
      workflowId: wfId,
      markdown,
      createdBy: { type: "user" as const, id: "user", name: "User" },
    });
    await loadRevisions();
  }

  function openAsk(prefill: AskPrefill | null = null) {
    askPrefill.value = prefill;
    askOpen.value = true;
  }
  function closeAsk() {
    askOpen.value = false;
    askPrefill.value = null;
  }

  /** Loads workflow state from server. Returns the new state, or null if not found yet.
   *  Throws on unexpected errors (non-404) so callers can surface them. */
  async function loadState() {
    try {
      state.value = await api.state();
      return state.value;
    } catch (e) {
      // 404-style "no state yet" on first load is expected — stay silent
      const msg = String(e);
      if (msg.includes("404") || msg.includes("not found")) return null;
      // Re-throw unexpected errors so pollers can surface them in UI
      throw e;
    }
  }

  async function loadSettings() {
    try {
      settings.value = await api.settings.get();
    } catch (_e) {
      // settings endpoint may not exist on older server versions
    }
  }

  async function loadProjects() {
    try {
      projects.value = await api.projects.list();
    } catch {
      /* best-effort — registry may not exist yet */
    }
  }

  /** Load a project for resume or reuse.
   *  resume: fetches state, advances to stage 2/3.
   *  reuse: sets reuseGoal so Stage1 can prefill the form; caller must setStage(1). */
  async function loadProject(path: string, mode: "resume" | "reuse") {
    try {
      const s = await api.projects.state(path);
      if (mode === "resume") {
        state.value = s;
        const pending = s.work_units.some((u) => u.status !== "done" && u.status !== "blocked");
        setStage(pending ? 3 : 2);
      } else {
        reuseGoal.value = s.goal;
      }
    } catch {
      /* state may be missing for old projects */
    }
  }

  /** Returns whether stage `n` is reachable given current state. */
  function isStageReachable(n: 1 | 2 | 3 | 4): boolean {
    return stageReachable(n, state.value);
  }

  function setStage(n: 0 | 1 | 2 | 3 | 4) {
    // Stage 0 (home) is always reachable
    if (n === 0) {
      stage.value = 0;
      return;
    }
    // Guard: only advance to reachable stages; always allow going backwards
    if (n > stage.value && !stageReachable(n, state.value)) return;
    stage.value = n;
  }

  function pushLog(_ev: unknown) {
    // ponytail: logs are managed by useSSE in LogPane directly — this is a no-op stub
    // kept for API compatibility if external callers reference it
  }

  return {
    stage,
    state,
    settings,
    logsOpen,
    version,
    projects,
    reuseGoal,
    askOpen,
    askPrefill,
    openAsk,
    closeAsk,
    loadState,
    loadSettings,
    loadProjects,
    loadProject,
    setStage,
    isStageReachable,
    pushLog,
    selectedWorkflowKey,
    selectedUnit,
    dashboardWorkflows,
    selectWorkflow,
    selectUnit,
    repoPath,
    revisions,
    activeRevisionId,
    activeRevision,
    activeBlocks,
    loadRevisions,
    createRevision,
    comments,
    loadComments,
    createComment,
    updateComment,
    deleteComment,
    submitComment,
  };
});
