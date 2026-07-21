import { basename, join } from "node:path";
import { CTX_DIR, readState } from "../core.js";
import type { WorkUnit, WorkflowState } from "../core/types.js";
import type { LogEvent } from "../logbus/types.js";
import type { ProjectEntry } from "../registry.js";
import { replayFromLog } from "./handlers.js";

export {
  resolveBaseline,
  buildWorkflowDiffSummary,
  buildUnitDiff,
  buildDiffResponse,
  type DiffFileEntry,
  type WorkflowDiffSummary,
  type WorkUnitDiffResult,
  type DiffRequest,
  type DiffResponse,
} from "./dashboard-diff.js";

export type WorkflowDashboardStatus = "running" | "blocked" | "pending" | "done";

export interface WorkflowDashboardItem {
  key: string;
  repoPath: string;
  repoName: string;
  taskId: string;
  goal: string;
  updatedAt: number;
  workUnits: WorkUnit[];
  totals: WorkflowState["totals"];
  status: WorkflowDashboardStatus;
  waves: string[][];
  latestEvent?: LogEvent;
}

export interface DashboardSelection {
  repoPath: string;
  workflowId: string;
  unit?: string;
}

export function dashboardKey(repoPath: string, taskId: string): string {
  return `${repoPath}\u0000${taskId}`;
}

export function workflowStatus(units: WorkUnit[]): WorkflowDashboardStatus {
  if (units.some((u) => u.status === "running" || u.status === "verifying")) return "running";
  if (units.some((u) => u.status === "blocked")) return "blocked";
  if (units.length > 0 && units.every((u) => u.status === "done")) return "done";
  return "pending";
}

function scheduleWaves(units: Pick<WorkUnit, "name" | "scope" | "depends_on">[]): string[][] {
  const remaining = new Map(units.map((p) => [p.name, new Set(p.depends_on ?? [])]));
  const waves: string[][] = [];
  const done = new Set<string>();
  while (remaining.size) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((d) => done.has(d)))
      .map(([name]) => name);
    if (!ready.length) {
      waves.push([...remaining.keys()]);
      break;
    }
    waves.push(ready);
    for (const name of ready) {
      done.add(name);
      remaining.delete(name);
    }
  }
  return waves;
}

export function buildDashboardItems(entries: ProjectEntry[]): WorkflowDashboardItem[] {
  const items: WorkflowDashboardItem[] = [];
  for (const entry of entries) {
    const state = readState(entry.path);
    if (!state) continue;
    const units = state.work_units ?? [];
    const waves = scheduleWaves(
      units.map((u) => ({ name: u.name, scope: u.scope ?? [], depends_on: u.depends_on })),
    );
    const logFile = join(entry.path, CTX_DIR, "logs", "current.log");
    // replayFromLog returns chronological events; retain its bounded tail, then select newest.
    const latestEvents = replayFromLog(logFile, 0, 5000);
    items.push({
      key: dashboardKey(entry.path, state.task_id),
      repoPath: entry.path,
      repoName: basename(entry.path),
      taskId: state.task_id,
      goal: state.goal,
      updatedAt: entry.lastUsed,
      workUnits: units,
      totals: state.totals ?? {
        units: units.length,
        done: 0,
        tokens: 0,
        cost_usd: 0,
        wall_seconds: 0,
      },
      status: workflowStatus(units),
      waves,
      latestEvent: latestEvents.at(-1),
    });
  }
  items.sort((a, b) => {
    const order: Record<WorkflowDashboardStatus, number> = {
      running: 0,
      blocked: 1,
      pending: 2,
      done: 3,
    };
    const diff = (order[a.status] ?? 99) - (order[b.status] ?? 99);
    if (diff !== 0) return diff;
    return b.updatedAt - a.updatedAt;
  });
  return items;
}

export function resolveDashboardSelection(
  repoPath: string,
  workflowId: string,
  unit: string | undefined,
  items: WorkflowDashboardItem[],
): DashboardSelection | { error: string; status: number } {
  const match = items.find((i) => i.repoPath === repoPath);
  if (!match) return { error: "repo not found in registry", status: 400 };
  if (match.taskId !== workflowId)
    return { error: "workflow not found for this repo", status: 404 };
  if (unit && !match.workUnits.some((u) => u.name === unit)) {
    return { error: "unit not found", status: 404 };
  }
  return { repoPath, workflowId, unit };
}

export function matchesDashboardEvent(
  ev: LogEvent,
  selection: DashboardSelection,
  includeWorkflowEvents: boolean,
): boolean {
  // A dashboard view is task-scoped. Legacy events cannot prove task ownership,
  // so exclude them rather than leaking an earlier workflow from the same repo.
  if (!ev.repoPath || !ev.workflowId) return false;
  if (ev.repoPath !== selection.repoPath || ev.workflowId !== selection.workflowId) return false;
  if (!selection.unit) return true;
  return ev.unit === selection.unit || (includeWorkflowEvents && !ev.unit);
}
