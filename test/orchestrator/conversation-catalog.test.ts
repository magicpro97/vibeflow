import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CatalogCursorCodec,
  CatalogCursorError,
  StaleCatalogCursorError,
} from "../../src/orchestrator/conversation/catalog-cursor.js";
import { projectConversationCatalog } from "../../src/orchestrator/conversation/catalog-projector.js";
import { CONVERSATION_DEFAULT_PROJECT_ID } from "../../src/orchestrator/conversation/conversation-catalog-contract.js";
import { deriveConversationLineages } from "../../src/orchestrator/conversation/lineage-reader.js";
import { readConversationSourceInventory } from "../../src/orchestrator/conversation/source-inventory.js";
import {
  CATALOG_FIXTURE_SECRET,
  fixtureRecord,
  installFixture,
} from "../helpers/conversation-catalog-fixture.js";

test("catalog projects one safe searchable root row and matches historical revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-catalog-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    installFixture(
      artifacts,
      traces,
      fixtureRecord("root", {
        children: ["child"],
        topic: `Original planning token=${CATALOG_FIXTURE_SECRET}`,
      }),
      "2026-08-25T00:00:30.000Z",
    );
    installFixture(
      artifacts,
      traces,
      fixtureRecord("child", {
        parent: "root",
        parentRevision: "revision-root",
        topic: "Current execution",
      }),
      "2026-08-25T00:01:30.000Z",
    );
    const inventory = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    const lineages = deriveConversationLineages(inventory);
    const codec = new CatalogCursorCodec(Buffer.alloc(32, 9));
    const headRecords = new Map(
      lineages.lineages.map((lineage) => [lineage.root_session_id, lineage.initial_head_candidate]),
    );
    const shadowOnly = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: codec,
      scopeId: "project:demo",
    });
    expect(shadowOnly.authoritative).toBe(false);
    expect(shadowOnly.response.catalog_health).toBe("degraded");
    expect(shadowOnly.response.items).toEqual([]);
    const newerHead = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: codec,
      scopeId: "project:demo",
      headRecords: new Map([
        ["root", { ...lineages.lineages[0]?.initial_head_candidate, schema_version: "2.0" }],
      ]),
    });
    expect(newerHead.response.catalog_health).toBe("degraded");
    expect(newerHead.response.items).toEqual([]);

    const projection = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: codec,
      scopeId: "project:demo",
      query: { query: "original" },
      limit: 20,
      headRecords,
    });

    expect(projection.response.catalog_health).toBe("ready");
    expect(projection.response.items).toHaveLength(1);
    expect(projection.response.items[0]).toMatchObject({
      root_session_id: "root",
      head_status: "committed",
      active_conversation_id: "child",
      active_revision_ordinal: 1,
      revision_count: 2,
      matched_revision: {
        conversation_id: "root",
        revision_id: "revision-root",
        revision_ordinal: 0,
      },
    });
    expect(projection.response.catalog_generation).toMatch(/^vf-catalog-generation-[0-9a-f]{64}$/);
    expect(projection.response.source_watermark).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(projection.response)).not.toContain(CATALOG_FIXTURE_SECRET);
    expect(JSON.stringify(projection.response)).not.toContain("/Users/private");
    expect(projection.response.items[0]?.root.project_id).toBe(CONVERSATION_DEFAULT_PROJECT_ID);
    expect(Object.keys(projection.response.items[0]?.active?.participants[0] ?? {}).sort()).toEqual(
      ["engine", "model", "participant_id", "role_ref"],
    );
    const otherQuery = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: codec,
      scopeId: "project:demo",
      query: { query: "current" },
      headRecords,
    });
    expect(otherQuery.response.catalog_generation).toBe(projection.response.catalog_generation);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog ordering and pagination remain bytewise stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-catalog-order-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    installFixture(artifacts, traces, fixtureRecord("a"), "2026-08-25T00:01:00.000Z");
    installFixture(artifacts, traces, fixtureRecord("b"), "2026-08-25T00:01:00.000Z");
    installFixture(artifacts, traces, fixtureRecord("c"), "2026-08-25T00:00:00.000Z");
    const inventory = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    const lineages = deriveConversationLineages(inventory);
    const codec = new CatalogCursorCodec(Buffer.alloc(32, 5));
    const headRecords = new Map(
      lineages.lineages.map((lineage) => [lineage.root_session_id, lineage.initial_head_candidate]),
    );
    const first = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: codec,
      scopeId: "project:demo",
      limit: 2,
      headRecords,
    });
    expect(first.response.items.map((item) => item.root_session_id)).toEqual(["b", "a"]);
    expect(first.response.next_cursor).not.toBeNull();
    const decodedFirstCursor = codec.decodeCatalog(first.response.next_cursor ?? "");
    const absentBoundaryCursor = codec.encodeCatalog({
      ...decodedFirstCursor,
      last: {
        sort_updated_at: decodedFirstCursor.last?.sort_updated_at ?? "",
        root_session_id: "missing-root",
      },
    });
    try {
      projectConversationCatalog({
        inventory,
        lineages,
        cursorCodec: codec,
        scopeId: "project:demo",
        limit: 2,
        cursor: absentBoundaryCursor,
        headRecords,
      });
      throw new Error("expected an absent catalog boundary rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogCursorError);
      if (!(error instanceof CatalogCursorError)) throw error;
      expect(error.code).toBe("cursor_binding_mismatch");
      expect(error.message).toBe("catalog cursor boundary is absent");
    }
    try {
      projectConversationCatalog({
        inventory,
        lineages,
        cursorCodec: codec,
        scopeId: "project:demo",
        limit: 2,
        cursor: first.response.next_cursor ?? undefined,
        headRecords,
        generationCreatedAt: "2026-08-25T00:02:00.000Z",
      });
      throw new Error("expected a stale catalog cursor");
    } catch (error) {
      expect(error).toBeInstanceOf(StaleCatalogCursorError);
      if (!(error instanceof StaleCatalogCursorError)) throw error;
      expect(error.code).toBe("stale_catalog_cursor");
      expect(codec.decodeCatalog(error.restart_cursor)).toMatchObject({
        catalog_generation: error.catalog_generation,
        last: null,
      });
      expect(error.catalog_generation).not.toBe(first.response.catalog_generation);
    }
    const second = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: codec,
      scopeId: "project:demo",
      limit: 2,
      cursor: first.response.next_cursor ?? undefined,
      headRecords,
    });
    expect(second.response.items.map((item) => item.root_session_id)).toEqual(["c"]);
    expect(second.response.next_cursor).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("degraded sources are explicit read-only state, never an authoritative empty catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-catalog-degraded-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    mkdirSync(join(traces, "conversations"), { recursive: true, mode: 0o700 });
    writeFileSync(join(artifacts, `${"f".repeat(64)}.json`), JSON.stringify({ version: "9.0" }), {
      mode: 0o600,
    });
    const inventory = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    const lineages = deriveConversationLineages(inventory);
    const projection = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 1)),
      scopeId: "project:demo",
    });
    expect(projection.read_only).toBe(true);
    expect(projection.authoritative).toBe(false);
    expect(projection.response.catalog_health).toBe("degraded");
    expect(projection.diagnostics.length).toBeGreaterThan(0);
    expect(projection.response.items).toEqual([]);
    expect(() =>
      projectConversationCatalog({
        inventory,
        lineages,
        cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 1)),
        scopeId: "project:demo",
        associationRecords: [
          {
            schema_version: "1.0",
            extra: CATALOG_FIXTURE_SECRET,
          } as never,
        ],
      }),
    ).not.toThrow();
    const invalidAssociation = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 1)),
      scopeId: "project:demo",
      associationRecords: [{ schema_version: "1.0", extra: CATALOG_FIXTURE_SECRET }],
    });
    expect(invalidAssociation.response.catalog_health).toBe("degraded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
