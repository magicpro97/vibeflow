import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationManifestPath } from "../../src/orchestrator/conversation/artifact-store.js";
import {
  CatalogCursorCodec,
  CatalogCursorError,
  StaleCatalogCursorError,
} from "../../src/orchestrator/conversation/catalog-cursor.js";
import { projectConversationCatalog } from "../../src/orchestrator/conversation/catalog-projector.js";
import { deriveConversationLineages } from "../../src/orchestrator/conversation/lineage-reader.js";
import { readConversationSourceInventory } from "../../src/orchestrator/conversation/source-inventory.js";
import { traceJournalPath } from "../../src/orchestrator/trace/store.js";

const HASH = "a".repeat(64);
const SECRET = "SECRET-CANARY-DO-NOT-PROJECT";

function fixtureRecord(
  id: string,
  options: { parent?: string; parentRevision?: string; children?: string[]; topic?: string } = {},
) {
  return {
    manifest: {
      version: "1.0",
      conversation_id: id,
      workflow_id: "workflow-shared",
      revision_id: `revision-${id}`,
      run_id: `run-${id}`,
      parent_conversation_id: options.parent ?? null,
      parent_revision_id: options.parentRevision ?? null,
      topic: options.topic ?? `Topic ${id}`,
      policy: "direct",
      max_rounds: 1,
      baseline_enabled: true,
      evaluator_auto_added: false,
      repo_root: `/Users/private/${SECRET}`,
      phase: 1,
      task_text: SECRET,
      bindings: [
        {
          participant_id: `participant-${id}`,
          input: { roleRef: "direct", engine: "codex", sessionMode: "fresh" },
        },
      ],
      created_at: "2026-08-25T00:00:00.000Z",
    },
    binding_authorities: [
      {
        participant_id: `participant-${id}`,
        engine: "codex",
        model: "gpt-5.4",
        session_mode: "fresh",
        role_source: "builtin",
        role_hash: HASH,
        skill_hashes: [],
      },
    ],
    resume_bindings: [
      {
        participant_id: `participant-${id}`,
        attemptId: `attempt-${id}`,
        engine: "codex",
        nativeSessionId: "123e4567-e89b-42d3-a456-426614174000",
      },
    ],
    child_revisions: Object.fromEntries(
      (options.children ?? []).map((child, index) => [
        createHash("sha256").update(`${id}:${index}`).digest("hex"),
        child,
      ]),
    ),
    artifacts: [],
    artifact_reservations: {},
  };
}

function eventRecord(id: string, seq: number, ts: string, event: unknown) {
  return {
    stored_event: {
      workflow_id: "workflow-shared",
      conversation_id: id,
      revision_id: `revision-${id}`,
      run_id: `run-${id}`,
      turn_id: `turn-${seq}`,
      operation_id: `operation-${seq}`,
      attempt_id: `attempt-${seq}`,
      event_id: randomUUID(),
      seq,
      ts,
      idempotency_key: `${id}:${seq}`,
      event,
    },
    native_session_id: null,
  };
}

function installFixture(
  artifactRoot: string,
  traceRoot: string,
  record: ReturnType<typeof fixtureRecord>,
  updatedAt: string,
) {
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(traceRoot, "conversations"), { recursive: true, mode: 0o700 });
  const id = record.manifest.conversation_id;
  writeFileSync(conversationManifestPath(artifactRoot, id), JSON.stringify(record), {
    mode: 0o600,
  });
  const records = [
    eventRecord(id, 1, record.manifest.created_at, {
      type: "conversation_configured",
      payload: {
        topic: record.manifest.topic,
        participants: [
          {
            participant_id: `participant-${id}`,
            role_ref: "direct",
            engine: "codex",
            model: "gpt-5.4",
          },
        ],
        policy: "direct",
        max_rounds: 1,
      },
    }),
    eventRecord(id, 2, updatedAt, {
      type: "state_change",
      payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
    }),
  ];
  writeFileSync(
    traceJournalPath(traceRoot, id),
    `${records.map((item) => JSON.stringify(item)).join("\n")}\n`,
    { mode: 0o600 },
  );
}

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
        topic: `Original planning token=${SECRET}`,
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
    expect(JSON.stringify(projection.response)).not.toContain(SECRET);
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
            extra: SECRET,
          } as never,
        ],
      }),
    ).not.toThrow();
    const invalidAssociation = projectConversationCatalog({
      inventory,
      lineages,
      cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 1)),
      scopeId: "project:demo",
      associationRecords: [{ schema_version: "1.0", extra: SECRET }],
    });
    expect(invalidAssociation.response.catalog_health).toBe("degraded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
