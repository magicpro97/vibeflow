import { describe, expect, test } from "bun:test";
import { pipelineEdges, pipelineWaves, primaryNodeDetail } from "../src/ui/src/lib/pipeline.js";
import type { WorkUnit } from "../src/ui/src/types.js";

function unit(name: string, status: WorkUnit["status"], depends_on: string[] = []): WorkUnit {
  return {
    name,
    status,
    confidence: 0,
    depends_on,
    gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
    resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  };
}

describe("workflow pipeline projection", () => {
  const units = [
    unit("workunit1", "done"),
    unit("workunit2", "running", ["workunit1"]),
    unit("workunit3", "pending", ["workunit1"]),
    unit("workunit4", "pending", ["workunit2", "workunit3"]),
  ];

  test("lays a diamond dependency graph into scheduler waves", () => {
    expect(pipelineWaves(units)).toEqual([
      ["workunit1"],
      ["workunit2", "workunit3"],
      ["workunit4"],
    ]);
  });

  test("returns every dependency edge for SVG rendering", () => {
    expect(pipelineEdges(units)).toEqual([
      { from: "workunit1", to: "workunit2" },
      { from: "workunit1", to: "workunit3" },
      { from: "workunit2", to: "workunit4" },
      { from: "workunit3", to: "workunit4" },
    ]);
  });

  test("returns empty edges for no dependencies", () => {
    expect(pipelineEdges([unit("solo", "done")])).toEqual([]);
  });

  test("edge directional semantics: from=dep, to=dependent", () => {
    const deps = [unit("a", "done"), unit("b", "pending", ["a"])];
    const edges = pipelineEdges(deps);
    expect(edges).toContainEqual({ from: "a", to: "b" });
  });

  test("explains which unfinished dependencies block a unit", () => {
    const target = units.find((u) => u.name === "workunit4");
    expect(target).toBeDefined();
    if (!target) throw new Error("fixture missing workunit4");
    expect(primaryNodeDetail(target, new Map(units.map((u) => [u.name, u])))).toBe(
      "Waiting for: workunit2, workunit3",
    );
  });
});
