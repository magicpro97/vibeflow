// src/commands/demo.ts
//
// `vf demo` subcommand — stages a fixed corpus of real source files as work units
// and runs them through the orchestrate path in dry+focus mode. Deterministic,
// repeatable, no engine spend — ideal for screen recording the phase timeline.
//
// PR4: the #186 corpus as a deterministic demo workload.

import { basename } from "node:path";
import { WORK_UNIT_STATUS } from "../core/workflow-contract.js";
import type { WorkUnit, WorkflowState } from "./_shared.js";
import { cwd, normalizeUnit, readState, recomputeTotals, writeState } from "./_shared.js";

/** A fixed corpus of real source files the demo "orchestrates" (dry — no real change). */
export const DEMO_FILES = [
  "src/adapters.ts",
  "src/commands/dispatch-runtime.ts",
  "src/commands/tools.ts",
] as const;

export function defaultWriteUnits(units: WorkUnit[]): void {
  const base = cwd();
  const existing: WorkflowState | null = readState(base);
  if (existing) {
    // Drop any units whose name starts with "split-" (the demo batch),
    // then add the new ones. Idempotent on repeated runs.
    const others = existing.work_units.filter((u: WorkUnit) => !u.name.startsWith("split-"));
    existing.work_units = [...others, ...units.map((u) => normalizeUnit(u))];
    recomputeTotals(existing);
    writeState(base, existing);
  } else {
    const state: WorkflowState = {
      task_id: "demo",
      goal: "VibeFlow demo — split the DEMO_FILES corpus",
      success_criteria: [],
      work_units: [],
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    state.work_units = units.map((u) => normalizeUnit(u));
    recomputeTotals(state);
    writeState(base, state);
  }
}

export async function demo(
  flags: Record<string, string | boolean>,
  inject: {
    orchestrate?: (flags: Record<string, string | boolean>) => Promise<number>;
    writeUnits?: (units: WorkUnit[]) => void;
  } = {},
): Promise<number> {
  const units: WorkUnit[] = DEMO_FILES.map((f) =>
    normalizeUnit({
      name: `split-${basename(f, ".ts")}`,
      status: WORK_UNIT_STATUS.PENDING,
      confidence: 0,
      scope: [f],
      spec: `Split ${f} under 400 LOC`,
    }),
  );

  (inject.writeUnits ?? defaultWriteUnits)(units);
  // Dynamic import keeps demo.ts free of a static sibling import (the ESM
  // cycle rule allows only ./_shared.js); orchestrate is injectable for tests.
  const orch = inject.orchestrate ?? (await import("./orchestrate.js")).orchestrate;
  return orch({ ...flags, dry: true, focus: true });
}
