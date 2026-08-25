import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import { CatalogCursorCodec } from "../../src/orchestrator/conversation/catalog-cursor.js";
import { ConversationCatalogService } from "../../src/orchestrator/conversation/catalog-service.js";
import {
  CatalogProjectionCorruptError,
  ConversationCatalogStore,
} from "../../src/orchestrator/conversation/catalog-storage.js";
import type { ConversationSessionSummaryV1 } from "../../src/orchestrator/conversation/catalog-types.js";

const ISO = "2026-08-25T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;

function row(root = "root", updatedAt = ISO): ConversationSessionSummaryV1 {
  const revision = {
    schema_version: "1.0" as const,
    conversation_id: root,
    revision_id: `revision-${root}`,
    revision_ordinal: 0,
    parent_conversation_id: null,
    parent_revision_id: null,
    lineage_status: "verified" as const,
    topic: `Topic ${root}`,
    policy: "direct",
    lifecycle: "ACTIVE" as const,
    health: "healthy" as const,
    participants: [],
    created_at: ISO,
    updated_at: updatedAt,
    last_seq: 1,
    lock_digest: DIGEST,
  };
  return {
    schema_version: "1.0",
    root_session_id: root,
    head_status: "committed",
    root: revision,
    active_conversation_id: root,
    active_revision_id: revision.revision_id,
    active_revision_ordinal: 0,
    revision_count: 1,
    active: revision,
    matched_revision: null,
    association_ids: [],
    sort_updated_at: updatedAt,
    lineage_cursor: "opaque",
  };
}

test("catalog store publishes exact generations and dense validated invalidation deltas", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-catalog-store-"));
  try {
    chmodSync(root, 0o700);
    const store = new ConversationCatalogStore({ artifactRoot: root });
    const source = {
      source_kind: "conversation-manifest" as const,
      root_session_id: "root",
      record_id: "root",
      record_digest: DIGEST,
    };
    const delta = store.appendDelta({
      root_session_id: "root",
      cause: "conversation-source-committed",
      source_record: source,
      source_inventory_digest: DIGEST,
      recorded_at: ISO,
    });
    expect(delta).toMatchObject({ sequence: 0, previous_event_digest: null });
    expect(store.readDeltas()).toEqual([delta]);

    const retry = store.appendDelta(
      {
        root_session_id: "root",
        cause: "projection-retry",
        source_record: source,
        source_inventory_digest: DIGEST,
        recorded_at: "2026-08-25T00:00:01.000Z",
      },
      { retrySequence: 0 },
    );
    expect(retry.sequence).toBe(1);
    expect(retry.previous_event_digest).toBe(delta.event_digest);
    expect(() =>
      store.appendDelta(
        {
          root_session_id: "root",
          cause: "projection-retry",
          source_record: { ...source, record_id: "other" },
          source_inventory_digest: DIGEST,
          recorded_at: "2026-08-25T00:00:02.000Z",
        },
        { retrySequence: 0 },
      ),
    ).toThrow("retry source");

    const watermark = store.sourceWatermark(DIGEST, retry.event_digest);
    const published = store.publishGeneration({
      rows: [row()],
      source_inventory_digest: DIGEST,
      source_watermark: watermark,
      starting_delta_sequence: 0,
      applied_through_delta_sequence: 1,
      created_at: ISO,
    });
    expect(store.readPublished()).toEqual(published);
    expect(statSync(store.paths.current).mode & 0o777).toBe(0o600);
    expect(statSync(store.paths.generations).mode & 0o777).toBe(0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog projection corruption is never interpreted as an empty catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-catalog-corrupt-"));
  try {
    chmodSync(root, 0o700);
    const store = new ConversationCatalogStore({ artifactRoot: root });
    const watermark = store.sourceWatermark(DIGEST, null);
    store.publishGeneration({
      rows: [row()],
      source_inventory_digest: DIGEST,
      source_watermark: watermark,
      starting_delta_sequence: 0,
      applied_through_delta_sequence: null,
      created_at: ISO,
    });
    const bytes = Buffer.from(readFileSync(store.paths.current));
    bytes[bytes.length - 2] = bytes[bytes.length - 2] === 48 ? 49 : 48;
    writeFileSync(store.paths.current, bytes, { mode: 0o600 });
    expect(() => store.readPublished()).toThrow(CatalogProjectionCorruptError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing catalog rebuild is single-flight and ordinary reads use only the durable projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-catalog-service-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "traces");
    mkdirSync(artifacts, { mode: 0o700 });
    mkdirSync(traces, { mode: 0o700 });
    let inventories = 0;
    const service = new ConversationCatalogService({
      artifactRoot: artifacts,
      traceRoot: traces,
      scopeId: "project:test",
      cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 4)),
      readInventory(options) {
        inventories += 1;
        const observed = digestV1("VF-CONVERSATION-OBSERVED-SOURCE-INVENTORY\0v1\0", {
          schema_version: "1.0",
          sources: [],
          degraded: false,
        });
        expect(options).toEqual({ artifactRoot: artifacts, traceRoot: traces });
        return {
          schema_version: "1.0",
          state: "empty",
          authoritative: true,
          sources: [],
          diagnostics: [],
          observed_source_digest: observed,
        };
      },
    });

    const [first, second] = await Promise.all([service.list(), service.list()]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ items: [], catalog_health: "ready" });
    expect(inventories).toBe(1);
    expect((await service.list()).catalog_health).toBe("ready");
    expect(inventories).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
