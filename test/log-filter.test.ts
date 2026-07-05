import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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

// #535: matchesUnitFilter excludes no-`unit` lifecycle lines (review/goal are
// emitted via out("vf", ...) with NO unit field, so a ?unit= stream drops them).
// That is only correct because the dashboard log pane subscribes the SESSION-WIDE
// stream (no ?unit=). Lock that wiring so a future "scope the pane to a unit"
// change can't silently swallow every review/goal/journal line.
describe("dashboard log pane consumes the session-wide stream (#535)", () => {
  const componentsDir = new URL("../src/ui/src/components/", import.meta.url);
  // Every useSSE("<url>") call site across ALL components — the real cross-file
  // invariant is "no UI log stream is unit-scoped", not "LogPane specifically".
  const sseUrls = readdirSync(componentsDir)
    .filter((f) => f.endsWith(".vue"))
    .flatMap((f) => [
      ...readFileSync(new URL(f, componentsDir), "utf8").matchAll(
        /useSSE\(\s*["'`]([^"'`]+)["'`]/g,
      ),
    ])
    .map((m) => m[1] as string);

  test("some component subscribes the log stream (the dashboard pane exists)", () => {
    expect(sseUrls).toContain("/api/logs/stream");
  });

  test("NO component scopes a log stream to a unit (?unit= would drop lifecycle events)", () => {
    // A unit-scoped stream filters out no-`unit` review/goal/journal lines. If any
    // component ever does useSSE("/api/logs/stream?unit=..."), this fails loudly.
    const scoped = sseUrls.filter((u) => u.includes("?unit") || u.includes("&unit"));
    expect(scoped).toEqual([]);
  });
});
