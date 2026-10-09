// src/commands/resources.ts
//
// `vf resources` — render the resource snapshot (Task 2 of the
// resource-management plan). The aggregation lives in ../resources.ts
// (buildResourceSnapshot); this module is only the CLI surface: text
// table + `--json` passthrough + exit-0 degradation when the workflow
// state is missing (matches `vf status`).
//
// The `quota` probe is injectable but currently empty — Task 3 wires
// `--probe` to the real engine-quota probe.

import type { QuotaStatus } from "../engine-quota.js";
import { buildResourceSnapshot } from "../resources.js";
import { c, out, readState } from "./_shared.js";

export function resources(
  flags: Record<string, string | boolean> = {},
  inject: { now?: Date; quota?: Array<{ engine: string; status: QuotaStatus }> } = {},
): number {
  const state = readState();
  if (!state) {
    out("vf", c.yellow("No workflow state — run vf init"));
    return 0;
  }
  const quota = inject.quota ?? [];
  const snap = buildResourceSnapshot(state, { quota, now: inject.now });
  if (flags.json) {
    out("vf", JSON.stringify(snap, null, 2));
    return 0;
  }
  out("vf", c.bold(`Resources · sampled ${snap.sampledAt}`));
  const t = snap.totals;
  out(
    "vf",
    `Totals: ${t.done}/${t.units} done · ${t.tokens} tokens · $${t.cost_usd} · ${t.wall_seconds}s`,
  );
  for (const e of snap.perEngine) {
    out(
      "vf",
      `  ${e.engine}: ${e.units} units · ${e.tokens} tokens · $${e.cost_usd} · ${e.wall_seconds}s`,
    );
  }
  for (const w of snap.warnings) out("vf", c.yellow(`  ! ${w}`));
  return 0;
}
