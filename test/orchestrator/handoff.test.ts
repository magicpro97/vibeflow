import { describe, expect, test } from "bun:test";
import type { WorkUnit } from "../../src/core/types.js";
import { deriveHandoff } from "../../src/orchestrator/handoff.js";

function u(over: Partial<WorkUnit> = {}): Pick<WorkUnit, "name" | "status" | "evidence"> {
  return { name: "u", status: "done", evidence: [], ...over };
}

describe("deriveHandoff (#612)", () => {
  test("basic summary format", () => {
    expect(deriveHandoff(u({ name: "build", evidence: ["a.log"] }))).toBe(
      "build: done, 1 evidence item(s)",
    );
  });

  test("evidence count 0 vs N", () => {
    expect(deriveHandoff(u({ evidence: [] }))).toBe("u: done, 0 evidence item(s)");
    expect(deriveHandoff(u({ evidence: ["a", "b", "c"] }))).toBe("u: done, 3 evidence item(s)");
  });

  test("empty evidence is fine", () => {
    expect(deriveHandoff(u({ evidence: undefined }))).toBe("u: done, 0 evidence item(s)");
  });

  test("control chars / newlines are sanitized to spaces", () => {
    const out = deriveHandoff(u({ name: "weird\tunit\nname", evidence: ["x"] }));
    expect(out).not.toContain("\t");
    expect(out).not.toContain("\n");
    expect(out).toContain("weird unit name");
  });

  test("over-cap truncation adds the ellipsis and stays bounded", () => {
    const long = "x".repeat(800);
    const out = deriveHandoff(u({ name: long, evidence: ["y"] }));
    expect(out.endsWith("…")).toBe(true);
    // HANDOFF_CAP = 500 → slice(0, 499) + "…" = 500 chars.
    expect(out.length).toBe(500);
  });

  test("name+status near the cap still gets the ellipsis", () => {
    const name = "a".repeat(495);
    const out = deriveHandoff(u({ name, evidence: ["z"] }));
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith("…")).toBe(true);
  });
});
