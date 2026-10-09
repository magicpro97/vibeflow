// Pure view helpers for the Home resources drawer (Task 5). Kept out of the
// component so formatting/sorting rules are unit-tested without Vue mount
// infra, and out of api.ts so the client stays a one-call fetch.
import type { ResourceSnapshot, ResourceUnitRow } from "../../../resources.js";

const trimmed = (value: number): string => value.toFixed(1).replace(/\.0$/, "");

/** Compact token count: 12_400 → "12.4K", 1_500_000 → "1.5M", <1000 exact. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trimmed(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimmed(n / 1_000)}K`;
  return String(n);
}

/** Cost-descending copy; the snapshot keeps an engine-major order, not cost. */
export function sortUnitRows(rows: ResourceUnitRow[]): ResourceUnitRow[] {
  return [...rows].sort((a, b) => b.cost_usd - a.cost_usd);
}

/** The CLI's totals line (`vf resources`, src/commands/resources.ts) verbatim. */
export function resourceSummaryLine(snapshot: ResourceSnapshot): string {
  const t = snapshot.totals;
  return `Totals: ${t.done}/${t.units} done · ${t.tokens} tokens · $${t.cost_usd} · ${t.wall_seconds}s`;
}
