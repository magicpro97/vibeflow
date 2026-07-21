/** Resolve repo path with safe precedence:
 *  1. selectedWorkflowKey when task_id matches current state
 *  2. state.repo_path if present (deprecated, may carry data from older workflows)
 *  3. dashboardWorkflows entry whose taskId matches state.task_id
 *  4. null (unavailable)
 */
export function resolveRepoPath(
  selectedWorkflowKey: string | null,
  state: { task_id: string; repo_path?: string } | null,
  dashboardWorkflows: { taskId: string; repoPath: string }[],
): string | null {
  if (selectedWorkflowKey && state) {
    const sep = selectedWorkflowKey.indexOf("\0");
    if (sep !== -1) {
      const rp = selectedWorkflowKey.slice(0, sep);
      const taskId = selectedWorkflowKey.slice(sep + 1);
      if (taskId === state.task_id) return rp;
    }
  }
  if (state?.repo_path) return state.repo_path;
  if (state) {
    for (const wf of dashboardWorkflows) {
      if (wf.taskId === state.task_id) return wf.repoPath;
    }
  }
  return null;
}
