// src/commands/eval.ts — #549
//
// `vf eval` — a passive regression gate. It reads the verdict/verify telemetry
// vf already writes during normal use, aggregates a real success-rate + cost +
// gate breakdown, and exits 1 when the pass-rate is below an expected threshold
// (so you can wire it into pre-push/CI). No LLM, no network, no fixtures.

import { c, cwd, writeFileSafe } from "../core.js";
import { out } from "../logbus.js";
import { readSettings } from "../settings.js";
import { buildReport, type EvalReport } from "../eval/report.js";
import { readVerdictSamples, readVerifySamples } from "../eval/telemetry.js";

/** Format the report as a human-readable block. Pure. */
function formatReport(r: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(c.bold("vf eval — success-rate from real telemetry"));
  lines.push(
    `  verdict: ${r.verdict.passed}/${r.verdict.total} passed  (${pct(r.verdict.passRate)})`,
  );
  if (r.verdict.avgGoalScore !== undefined) {
    lines.push(`  avg goal score: ${r.verdict.avgGoalScore.toFixed(2)}`);
  }
  if (r.verdict.totalCostUsd !== undefined) {
    lines.push(
      `  cost: $${r.verdict.totalCostUsd.toFixed(4)}  tokens: ${r.verdict.totalTokens ?? 0}`,
    );
  }
  const gates = Object.entries(r.verdict.gateFailures);
  if (gates.length > 0) {
    lines.push(`  gate failures: ${gates.map(([g, n]) => `${g}=${n}`).join("  ")}`);
  }
  lines.push(`  verify: ${r.verify.passed}/${r.verify.total} passed  (${pct(r.verify.passRate)})`);
  if (r.minPassRate !== undefined) {
    lines.push(`  threshold: ${pct(r.minPassRate)}  →  ${r.ok ? c.green("OK") : c.red("BELOW")}`);
  }
  if (r.sampleWarning) lines.push(c.yellow(`  ⚠ ${r.sampleWarning}`));
  return lines.join("\n");
}

/** vf eval entry. Reads telemetry → builds report → prints/writes → exit code. */
export function evalCmd(
  _positionals: string[],
  flags: Record<string, string | boolean>,
): number {
  const base = cwd();
  const verdicts = readVerdictSamples(base);
  const verifies = readVerifySamples(base);

  if (verdicts.length === 0 && verifies.length === 0) {
    out("vf", c.dim("no telemetry yet — run some units (vf orchestrate / vf demo) first"));
    return 0;
  }

  const settings = readSettings(base);
  const minPassRate =
    typeof flags["min-pass-rate"] === "string"
      ? Number(flags["min-pass-rate"])
      : settings.eval?.minPassRate;
  const minSamples =
    typeof flags["min-samples"] === "string"
      ? Number(flags["min-samples"])
      : settings.eval?.minSamples;

  const report = buildReport(verdicts, verifies, { minPassRate, minSamples });
  const json = JSON.stringify(report, null, 2);

  if (typeof flags.out === "string") writeFileSafe(flags.out, json);
  if (flags.json === true) {
    out("vf", json);
  } else {
    out("vf", formatReport(report));
  }
  return report.ok ? 0 : 1;
}
