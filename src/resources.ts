import type { WorkflowState } from "./core.js";
import { WORK_UNIT_STATUS } from "./core/workflow-contract.js";
import type { QuotaStatus } from "./engine-quota.js";

export const RESOURCE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface ResourceEngineRollup {
  engine: string;
  units: number;
  done: number;
  tokens: number;
  cost_usd: number;
  wall_seconds: number;
}

export interface ResourceUnitRow {
  name: string;
  status: string;
  engine: string | null;
  tokens: number;
  cost_usd: number;
  wall_seconds: number;
}

export interface ResourceQuotaView extends QuotaStatus {
  engine: string;
  sampledAt: string;
}

export interface ResourceSnapshot {
  schemaVersion: typeof RESOURCE_SNAPSHOT_SCHEMA_VERSION;
  sampledAt: string;
  source: "workflow-state";
  totals: WorkflowState["totals"];
  perEngine: ResourceEngineRollup[];
  units: ResourceUnitRow[];
  quota: ResourceQuotaView[];
  provenance: { exact: string[]; estimated: string[]; unavailable: string[] };
  warnings: string[];
}

/**
 * Pure snapshot of a workflow state's resource usage (#523): counts/durations are
 * ledger-exact, tokens/cost are best-effort engine envelope estimates. No I/O —
 * callers inject the quota probe and the clock so output is deterministic.
 */
export function buildResourceSnapshot(
  state: WorkflowState,
  opts: { quota?: Array<{ engine: string; status: QuotaStatus }>; now?: Date } = {},
): ResourceSnapshot {
  const sampledAt = (opts.now ?? new Date()).toISOString();
  const engineOf = (u: WorkflowState["work_units"][number]) => u.engine ?? null;
  const rollup = new Map<string, ResourceEngineRollup>();
  const missingByEngine = new Map<string, number>();
  for (const unit of state.work_units) {
    const key = engineOf(unit) ?? "unknown";
    const row = rollup.get(key) ?? {
      engine: key,
      units: 0,
      done: 0,
      tokens: 0,
      cost_usd: 0,
      wall_seconds: 0,
    };
    row.units += 1;
    if (unit.status === WORK_UNIT_STATUS.DONE) row.done += 1;
    const r = unit.resources;
    // tokens/cost are never negative, so a zero sum means nothing was recorded.
    if (!r || r.tokens + r.cost_usd === 0) {
      missingByEngine.set(key, (missingByEngine.get(key) ?? 0) + 1);
    }
    row.tokens += r?.tokens ?? 0;
    row.cost_usd += r?.cost_usd ?? 0;
    row.wall_seconds += r?.wall_seconds ?? 0;
    rollup.set(key, row);
  }
  const quota = (opts.quota ?? []).map((q) => ({ engine: q.engine, sampledAt, ...q.status }));
  const warnings: string[] = [];
  for (const [engine, count] of missingByEngine) {
    warnings.push(`${count} units on ${engine} have no recorded resources`);
  }
  for (const q of quota) {
    if (q.level === "warning" || q.level === "exhausted" || q.level === "rate-limited") {
      warnings.push(
        `${q.engine}: ${q.level}${q.percentRemaining !== undefined ? ` (${Math.round(q.percentRemaining)}% remaining)` : ""}${q.resetAt ? `, resets ${q.resetAt}` : ""}`,
      );
    }
  }
  return {
    schemaVersion: RESOURCE_SNAPSHOT_SCHEMA_VERSION,
    sampledAt,
    source: "workflow-state",
    totals: state.totals,
    perEngine: [...rollup.values()].sort((a, b) => b.cost_usd - a.cost_usd),
    units: state.work_units.map((u) => ({
      name: u.name,
      status: u.status,
      engine: engineOf(u),
      tokens: u.resources?.tokens ?? 0,
      cost_usd: u.resources?.cost_usd ?? 0,
      wall_seconds: u.resources?.wall_seconds ?? 0,
    })),
    quota,
    provenance: {
      exact: ["units", "done", "wall_seconds"],
      estimated: ["tokens", "cost_usd"],
      unavailable: opts.quota?.length ? [] : ["quota (run with --probe)"],
    },
    warnings,
  };
}
