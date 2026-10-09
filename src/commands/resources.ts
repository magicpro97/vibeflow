// src/commands/resources.ts
//
// `vf resources` — render the resource snapshot (Task 2 of the
// resource-management plan). The aggregation lives in ../resources.ts
// (buildResourceSnapshot); this module is only the CLI surface: text
// table + `--json` passthrough + exit-0 degradation when the workflow
// state is missing (matches `vf status`).
//
// `--probe` (Task 3) runs the best-effort engine quota probe. The probed
// roster is the keys of RESOURCE_PROBE_COMMANDS — engines without a stable
// headless quota command are not probed, so the quota section stays clean.
// The probe is injectable (`inject.probe`) so tests never spawn real
// processes.

import type { QuotaStatus } from "../engine-quota.js";
import { RESOURCE_PROBE_COMMANDS, probeQuota } from "../resources-quota.js";
import { buildResourceSnapshot } from "../resources.js";
import { c, out, readState } from "./_shared.js";

type QuotaProbe = (engine: string) => Promise<QuotaStatus>;

export async function resources(
  flags: Record<string, string | boolean> = {},
  inject: {
    now?: Date;
    quota?: Array<{ engine: string; status: QuotaStatus }>;
    probe?: QuotaProbe;
  } = {},
): Promise<number> {
  const state = readState();
  if (!state) {
    out("vf", c.yellow("No workflow state — run vf init"));
    return 0;
  }
  const probe = inject.probe ?? probeQuota;
  const quota =
    inject.quota ??
    (flags.probe
      ? await Promise.all(
          Object.keys(RESOURCE_PROBE_COMMANDS).map(async (engine) => ({
            engine,
            status: await probe(engine),
          })),
        )
      : []);
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
  if (snap.quota.length > 0) {
    out("vf", "Quota:");
    for (const q of snap.quota) {
      const pct =
        q.percentRemaining !== undefined ? ` (${Math.round(q.percentRemaining)}% remaining)` : "";
      out("vf", `  ${q.engine}: ${q.level}${pct}${q.error ? ` (${q.error})` : ""}`);
    }
  }
  for (const w of snap.warnings) out("vf", c.yellow(`  ! ${w}`));
  return 0;
}
