import type { WorkUnit } from "../core.js";
import { PENDING_REQUIRED_WORK_UNIT_GATES, WORK_UNIT_STATUS } from "../core/workflow-contract.js";
import { findScopeConflicts } from "../gates.js";

/** A planner's proposed slice of the task — name + the file scope it owns. */
export interface UnitProposal {
  name: string;
  scope: string[];
  owner_agent?: string;
  confidence?: number;
  acceptance_signal?: string;
  depends_on?: string[];
}

export interface PlanResult {
  /** True only when every proposed scope is disjoint (parallel-safe). */
  ok: boolean;
  units: WorkUnit[];
  conflicts: Array<[string, string]>;
}

/**
 * Decompose a set of proposals into work units, rejecting overlapping scopes so that
 * independent units can run in parallel without clobbering each other. Pure — the
 * proposals themselves come from the orchestrator/planner agent (injected upstream).
 */
export function planWorkUnits(proposals: UnitProposal[]): PlanResult {
  const conflicts = findScopeConflicts(proposals);
  const units: WorkUnit[] = proposals.map((p) => ({
    name: p.name,
    status: WORK_UNIT_STATUS.PENDING,
    confidence: p.confidence ?? 0,
    owner_agent: p.owner_agent,
    scope: p.scope,
    depends_on: p.depends_on,
    gates: { ...PENDING_REQUIRED_WORK_UNIT_GATES },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  }));
  return { ok: conflicts.length === 0, units, conflicts };
}

/**
 * Order units into parallel waves by dependency: each wave contains only units whose
 * dependencies are already satisfied by earlier waves. Units in the same wave are
 * independent and may be dispatched concurrently.
 */
export function scheduleWaves(proposals: UnitProposal[]): string[][] {
  const remaining = new Map(proposals.map((p) => [p.name, new Set(p.depends_on ?? [])]));
  const waves: string[][] = [];
  const done = new Set<string>();
  while (remaining.size) {
    const ready = [...remaining.entries()]
      .filter(([, deps]) => [...deps].every((d) => done.has(d)))
      .map(([name]) => name);
    if (!ready.length) {
      // Dependency cycle or missing dep — emit the rest as a final wave to avoid a hang.
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
