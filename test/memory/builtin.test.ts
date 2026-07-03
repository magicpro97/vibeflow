import { expect, test } from "bun:test";
import { BuiltinMemoryProvider } from "../../src/memory/builtin.js";

const SAMPLE =
  "## [2026-07-01] ADR-001 | Use bun sqlite\n**Context:** need recall\n**Decision:** use bun:sqlite FTS5 for memory\n";

test("recall finds matching decision", () => {
  const p = new BuiltinMemoryProvider("/fake", {
    readDecisions: () => SAMPLE,
    mtime: () => 1,
    dbPath: ":memory:",
  });
  const hits = p.recall("bun sqlite memory");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.id).toBe("ADR-001");
});
test("recall: missing decisions → []", () => {
  const p = new BuiltinMemoryProvider("/fake", {
    readDecisions: () => null,
    mtime: () => null,
    dbPath: ":memory:",
  });
  expect(p.recall("anything")).toEqual([]);
});
test("re-index only when mtime changes", () => {
  let reads = 0;
  const p = new BuiltinMemoryProvider("/fake", {
    readDecisions: () => {
      reads++;
      return SAMPLE;
    },
    mtime: () => 1,
    dbPath: ":memory:",
  });
  p.recall("bun");
  p.recall("sqlite");
  expect(reads).toBe(1);
});
test("tier=titles strips content", () => {
  const p = new BuiltinMemoryProvider("/fake", {
    readDecisions: () => SAMPLE,
    mtime: () => 1,
    dbPath: ":memory:",
  });
  const hits = p.recall("sqlite", { tier: "titles" });
  if (hits.length > 0) expect(hits[0]?.content).toBe("");
});
test("recall: readDecisions throws → [] (catch branch)", () => {
  const p = new BuiltinMemoryProvider("/fake", {
    readDecisions: () => {
      throw new Error("EPERM");
    },
    mtime: () => 1,
    dbPath: ":memory:",
  });
  expect(p.recall("anything")).toEqual([]);
});
test("spec: returns decisions.md content (spec oracle seam, Task 4b)", () => {
  const p = new BuiltinMemoryProvider("/fake", {
    readDecisions: () => SAMPLE,
    mtime: () => 1,
    dbPath: ":memory:",
  });
  expect(p.spec()).toContain("ADR-001");
});
test("spec: missing decisions → null", () => {
  const p = new BuiltinMemoryProvider("/fake", {
    readDecisions: () => null,
    mtime: () => null,
    dbPath: ":memory:",
  });
  expect(p.spec()).toBeNull();
});
