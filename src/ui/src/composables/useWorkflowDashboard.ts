import { onUnmounted, ref, watch } from "vue";
import { api } from "../api.js";
import { useVfStore } from "../store.js";
import type { WorkflowDashboardItem } from "../types.js";

export function useWorkflowDashboard() {
  const store = useVfStore();
  const workflows = ref<WorkflowDashboardItem[]>([]);
  const error = ref<string | null>(null);
  const loading = ref(false);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;

  async function fetch() {
    if (destroyed) return;
    loading.value = true;
    try {
      const res = await api.dashboard.workflows();
      workflows.value = res.workflows;
      error.value = null;
      const keys = new Set(res.workflows.map((w: WorkflowDashboardItem) => w.key));
      if (store.selectedWorkflowKey && !keys.has(store.selectedWorkflowKey)) {
        store.selectWorkflow(null);
      }
      const first = res.workflows[0];
      if (!store.selectedWorkflowKey && first) {
        const running = res.workflows.find(
          (w: WorkflowDashboardItem | undefined) => w?.status === "running",
        );
        store.selectWorkflow(running?.key ?? first.key);
      }
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  function schedule() {
    if (pollTimer) clearInterval(pollTimer);
    const anyRunning = workflows.value.some((w) => w.status === "running");
    const interval = anyRunning ? 2000 : 15_000;
    pollTimer = setInterval(fetch, interval);
  }

  fetch().then(schedule);

  watch(workflows, () => schedule());

  onUnmounted(() => {
    destroyed = true;
    if (pollTimer) clearInterval(pollTimer);
  });

  return { workflows, error, loading, refresh: fetch };
}
