import { describe, expect, test } from "bun:test";
import { matchesUnitFilter } from "../src/logbus.js";

// #525: pure predicate for the SSE ?unit= scope. No server involved.
describe("matchesUnitFilter (#525)", () => {
  test("no filter (undefined) passes an event WITH a unit", () => {
    expect(matchesUnitFilter({ unit: "A" }, undefined)).toBe(true);
  });

  test("no filter (undefined) passes an event WITHOUT a unit", () => {
    expect(matchesUnitFilter({}, undefined)).toBe(true);
  });

  test("empty-string filter behaves as no filter (passes everything)", () => {
    expect(matchesUnitFilter({ unit: "A" }, "")).toBe(true);
    expect(matchesUnitFilter({}, "")).toBe(true);
  });

  test("filter set passes only the matching unit", () => {
    expect(matchesUnitFilter({ unit: "A" }, "A")).toBe(true);
    expect(matchesUnitFilter({ unit: "B" }, "A")).toBe(false);
  });

  test("filter set excludes a session-level event (no unit)", () => {
    expect(matchesUnitFilter({}, "A")).toBe(false);
    expect(matchesUnitFilter({ unit: undefined }, "A")).toBe(false);
  });
});
