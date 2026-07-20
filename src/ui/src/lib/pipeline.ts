import type { WorkUnit } from "../types.js";

export function pipelineWaves(
  units: Pick<WorkUnit, "name" | "scope" | "depends_on">[],
): string[][] {
  const remaining = new Map<string, Set<string>>(
    units.map((p) => [p.name, new Set(p.depends_on ?? [])]),
  );
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

export function pipelineEdges(
  units: Pick<WorkUnit, "name" | "depends_on">[],
): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const u of units) {
    for (const dep of u.depends_on ?? []) {
      edges.push({ from: dep, to: u.name });
    }
  }
  return edges;
}

export function waitingOn(unit: WorkUnit, byName: Map<string, WorkUnit>): string[] {
  return (unit.depends_on ?? []).filter((d) => {
    const dep = byName.get(d);
    return !dep || dep.status !== "done";
  });
}

export function primaryNodeDetail(unit: WorkUnit, byName: Map<string, WorkUnit>): string {
  const wait = waitingOn(unit, byName);
  if (wait.length > 0) return `Waiting for: ${wait.join(", ")}`;
  if (unit.status === "blocked") {
    const failed = Object.entries(unit.gates).filter(([, v]) => v === "fail");
    if (failed.length > 0) return `Failed: ${failed.map(([k]) => k).join(", ")}`;
    return "Blocked";
  }
  return "";
}
