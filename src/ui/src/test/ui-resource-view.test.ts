// Pure-function tests for the resources drawer view helpers (no Vue mount
// infra). "bun:test" is imported dynamically (String(...)) so vue-tsc
// (src/ui build) never sees the module dependency — repo pattern, same as
// ui-tool-groups.test.ts.
const { describe, expect, test } = await import(String("bun:test"));
import type { ResourceSnapshot, ResourceUnitRow } from "../../../resources.js";
import { formatTokens, resourceSummaryLine, sortUnitRows } from "../lib/resource-view.js";

const snapshot = (over: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  schemaVersion: 1,
  sampledAt: "2026-10-09T00:00:00.000Z",
  source: "workflow-state",
  totals: { units: 2, done: 1, tokens: 12_400, cost_usd: 1.25, wall_seconds: 40 },
  perEngine: [],
  units: [],
  quota: [],
  provenance: { exact: [], estimated: [], unavailable: [] },
  warnings: [],
  ...over,
});

const unit = (name: string, cost_usd: number): ResourceUnitRow => ({
  name,
  status: "done",
  engine: "claude",
  tokens: 100,
  cost_usd,
  wall_seconds: 10,
});

describe("resource view helpers", () => {
  test("formatTokens keeps sub-thousand counts exact", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(0)).toBe("0");
  });

  test("formatTokens renders thousands with one trimmed decimal", () => {
    expect(formatTokens(12_400)).toBe("12.4K");
    expect(formatTokens(12_000)).toBe("12K");
  });

  test("formatTokens renders millions", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });

  test("sortUnitRows orders by cost descending without mutating the input", () => {
    const rows = [unit("cheap", 0.1), unit("pricey", 4), unit("mid", 1)];
    expect(sortUnitRows(rows).map((row) => row.name)).toEqual(["pricey", "mid", "cheap"]);
    expect(rows.map((row) => row.name)).toEqual(["cheap", "pricey", "mid"]);
  });

  test("resourceSummaryLine matches the CLI totals line", () => {
    expect(resourceSummaryLine(snapshot())).toBe("Totals: 1/2 done · 12400 tokens · $1.25 · 40s");
  });

  test("resourceSummaryLine keeps an empty state readable", () => {
    const empty = snapshot({
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    });
    expect(resourceSummaryLine(empty)).toBe("Totals: 0/0 done · 0 tokens · $0 · 0s");
  });
});
