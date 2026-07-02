import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openMemoryDb, searchEntries, upsertEntries } from "../../src/memory/index-db.js";

test("openMemoryDb creates FTS5 table", () => {
  const db = openMemoryDb(":memory:");
  // Insert + select verifies table exists and is FTS5.
  db.run("INSERT INTO mem(id,title,content) VALUES ('x','t','c')");
  const r = db.query("SELECT id FROM mem WHERE mem MATCH 'c'").all();
  expect(r.length).toBe(1);
});

test("searchEntries returns BM25-ranked hits, best first", () => {
  const db = openMemoryDb(":memory:");
  upsertEntries(db, [
    { id: "ADR-001", title: "use bun sqlite for recall", content: "memory recall via FTS5" },
    { id: "ADR-002", title: "coverage waiver policy", content: "gate waiver for catch branches" },
  ]);
  const hits = searchEntries(db, "memory recall", 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.id).toBe("ADR-001");
  expect(hits[0]?.score).toBeGreaterThan(0);
  expect(hits[0]?.score).toBeLessThanOrEqual(1);
});

test("upsertEntries is idempotent on id", () => {
  const db = openMemoryDb(":memory:");
  const e = { id: "ADR-001", title: "x", content: "recall" };
  upsertEntries(db, [e]);
  upsertEntries(db, [e]);
  const hits = searchEntries(db, "recall", 5);
  expect(hits.length).toBe(1); // no dup rows
});

test("searchEntries: empty query → []", () => {
  const db = openMemoryDb(":memory:");
  expect(searchEntries(db, "", 5)).toEqual([]);
  expect(searchEntries(db, "   ", 5)).toEqual([]);
});

test("searchEntries: malformed query → [] (no throw)", () => {
  const db = openMemoryDb(":memory:");
  // Special chars that could break FTS5 MATCH — should return [] not throw.
  expect(() => searchEntries(db, "AND OR (", 5)).not.toThrow();
  expect(searchEntries(db, "AND OR (", 5)).toEqual([]);
});

test("searchEntries: limit respected", () => {
  const db = openMemoryDb(":memory:");
  upsertEntries(db, [
    { id: "a", title: "recall one", content: "recall" },
    { id: "b", title: "recall two", content: "recall" },
    { id: "c", title: "recall three", content: "recall" },
  ]);
  expect(searchEntries(db, "recall", 2).length).toBeLessThanOrEqual(2);
});
