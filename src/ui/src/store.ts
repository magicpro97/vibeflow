import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "./api.js";
import type { VibeSettings, WorkflowState } from "./types.js";

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
  const stage = ref<1 | 2 | 3 | 4>(1);
  const state = ref<WorkflowState | null>(null);
  const settings = ref<VibeSettings | null>(null);
  const logsOpen = ref(false); // controlled here so any component can open logs
  const version = document.querySelector<HTMLMetaElement>('meta[name="vf-version"]')?.content ?? "";

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

  /** Returns whether stage `n` is reachable given current state. */
  function isStageReachable(n: 1 | 2 | 3 | 4): boolean {
    return stageReachable(n, state.value);
  }

  function setStage(n: 1 | 2 | 3 | 4) {
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
    loadState,
    loadSettings,
    setStage,
    isStageReachable,
    pushLog,
  };
});
