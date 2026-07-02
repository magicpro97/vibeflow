import { expect, test } from "bun:test";
import { parseDecisions } from "../../src/memory/parse-decisions.js";

const SAMPLE =
  "# Decisions (ADR-lite)\n\n## [2026-07-01] ADR-001 | Use bun sqlite\n**Context:** need recall\n**Decision:** use bun:sqlite FTS5\n\n## [2026-07-02] ADR-002 | Coverage waiver\n**Context:** unreachable catch\n**Decision:** waive via comment\n";

test("parseDecisions splits ADR entries", () => {
  const e = parseDecisions(SAMPLE);
  expect(e.length).toBe(2);
  expect(e[0]?.id).toBe("ADR-001");
  expect(e[0]?.title).toBe("Use bun sqlite");
  expect(e[0]?.content).toContain("use bun:sqlite FTS5");
});
test("parseDecisions: empty → []", () => {
  expect(parseDecisions("")).toEqual([]);
  expect(parseDecisions("# header only\n")).toEqual([]);
});
test("parseDecisions: preserves body lines", () => {
  const e = parseDecisions(SAMPLE);
  expect(e[0]?.content).toContain("need recall");
});
