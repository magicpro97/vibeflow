import { expect, test } from "bun:test";
import {
  CatalogCursorCodec,
  CatalogCursorError,
  FutureLineageCursorError,
  catalogQueryDigest,
} from "../../src/orchestrator/conversation/catalog-cursor.js";

const codec = new CatalogCursorCodec(Buffer.alloc(32, 7));
const lineagePositions = new Map([
  [0, 4],
  [1, 7],
  [2, 2],
  [3, 18],
]);
const current = {
  scope_id: "project:demo",
  query_digest: catalogQueryDigest({ query: "Agent", lifecycle: ["ACTIVE"], policy: ["direct"] }),
  filter_digest: catalogQueryDigest({ query: "", lifecycle: ["ACTIVE"], policy: ["direct"] }),
  sort: "updated-desc-root-desc" as const,
  catalog_generation: `vf-catalog-generation-${"a".repeat(64)}`,
  source_watermark: `sha256:${"b".repeat(64)}`,
  catalog_head_digest: `sha256:${"c".repeat(64)}`,
  last: { sort_updated_at: "2026-08-25T00:00:00.000Z", root_session_id: "root" },
};

test("catalog cursor is opaque and binds scope, query, filters, sort, generation and head", () => {
  const cursor = codec.encodeCatalog(current);
  expect(cursor).not.toContain("project:demo");
  expect(codec.decodeCatalog(cursor)).toEqual({
    schema_version: "1.0",
    kind: "conversation-catalog",
    ...current,
  });
  expect(codec.validateCatalog(cursor, current)).toEqual({ status: "valid", value: current.last });
  const differentQuery = { ...current, query_digest: catalogQueryDigest({ query: "other" }) };
  expect(() => codec.validateCatalog(cursor, differentQuery)).toThrow(CatalogCursorError);
});

test("cursor tamper is rejected and a changed generation returns a bound restart cursor", () => {
  const cursor = codec.encodeCatalog(current);
  const tampered = `${cursor.slice(0, -2)}aa`;
  expect(() => codec.decodeCatalog(tampered)).toThrow(CatalogCursorError);

  const next = {
    ...current,
    catalog_generation: `vf-catalog-generation-${"d".repeat(64)}`,
    catalog_head_digest: `sha256:${"e".repeat(64)}`,
    last: null,
  };
  const stale = codec.validateCatalog(cursor, next);
  expect(stale.status).toBe("stale");
  if (stale.status === "stale") {
    expect(stale.code).toBe("stale_catalog_cursor");
    expect(codec.decodeCatalog(stale.restart_cursor).catalog_generation).toBe(
      next.catalog_generation,
    );
  }
});

test("lineage cursor detects head changes without accepting the old page boundary", () => {
  const binding = {
    scope_id: "project:demo",
    root_session_id: "root",
    head_digest: `sha256:${"a".repeat(64)}`,
    head_epoch: 2,
    last_revision_ordinal: 3,
    last_public_sequence: 18,
  };
  const cursor = codec.encodeLineage(binding);
  expect(codec.validateLineage(cursor, binding, lineagePositions)).toEqual({
    status: "valid",
    value: { last_revision_ordinal: 3, last_public_sequence: 18 },
  });
  const stale = codec.validateLineage(
    cursor,
    {
      ...binding,
      head_digest: `sha256:${"b".repeat(64)}`,
      head_epoch: 3,
      last_revision_ordinal: 0,
      last_public_sequence: 0,
    },
    new Map([[0, 0]]),
  );
  expect(stale.status).toBe("stale");
  if (stale.status === "stale") {
    expect(stale.code).toBe("stale_lineage_cursor");
    expect(codec.decodeLineage(stale.restart_cursor).head_epoch).toBe(3);
  }
});

test("lineage cursor rejects a position beyond the current bound", () => {
  const currentLineage = {
    scope_id: "project:demo",
    root_session_id: "root",
    head_digest: `sha256:${"a".repeat(64)}`,
    head_epoch: 2,
    last_revision_ordinal: 3,
    last_public_sequence: 18,
  };
  const futureOrdinal = codec.encodeLineage({
    ...currentLineage,
    last_revision_ordinal: 999,
    last_public_sequence: 999,
  });
  expect(() => codec.validateLineage(futureOrdinal, currentLineage, lineagePositions)).toThrow(
    FutureLineageCursorError,
  );
  const futureSequence = codec.encodeLineage({
    ...currentLineage,
    last_public_sequence: 19,
  });
  try {
    codec.validateLineage(futureSequence, currentLineage, lineagePositions);
    throw new Error("future lineage cursor was accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(FutureLineageCursorError);
    expect((error as FutureLineageCursorError).code).toBe("future_event_cursor");
    expect((error as FutureLineageCursorError).current_last_revision_ordinal).toBe(3);
    expect((error as FutureLineageCursorError).current_last_public_sequence).toBe(18);
  }

  const impossibleEarlierSequence = codec.encodeLineage({
    ...currentLineage,
    last_revision_ordinal: 2,
    last_public_sequence: Number.MAX_SAFE_INTEGER,
  });
  expect(() =>
    codec.validateLineage(impossibleEarlierSequence, currentLineage, lineagePositions),
  ).toThrow(FutureLineageCursorError);
});

test("query digest canonicalizes bounded search and set filters", () => {
  expect(
    catalogQueryDigest({ query: "  AGENT  ", lifecycle: ["ACTIVE", "ACTIVE"], policy: ["z", "a"] }),
  ).toBe(catalogQueryDigest({ query: "agent", lifecycle: ["ACTIVE"], policy: ["a", "z"] }));
  expect(() => catalogQueryDigest({ query: "x".repeat(257) })).toThrow();
  expect(() => catalogQueryDigest({ query: "bad\u0000query" })).toThrow();
});
