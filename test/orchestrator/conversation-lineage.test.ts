import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationManifestPath } from "../../src/orchestrator/conversation/artifact-store.js";
import { CatalogCursorCodec } from "../../src/orchestrator/conversation/catalog-cursor.js";
import {
  closePrivateDirectorySnapshot,
  inspectPrivateDirectoryReadOnly,
  readPrivateDirectoryNames,
  readPrivateFileBytesAt,
} from "../../src/orchestrator/conversation/catalog-read-safety.js";
import { deriveConversationLineages } from "../../src/orchestrator/conversation/lineage-reader.js";
import { revisionReservationDigest } from "../../src/orchestrator/conversation/lineage-reservation.js";
import { ConversationLineageService } from "../../src/orchestrator/conversation/lineage-service.js";
import { LineageAuthorityStore } from "../../src/orchestrator/conversation/lineage-store.js";
import {
  type ValidatedConversationSourceV1,
  readConversationSourceInventory,
} from "../../src/orchestrator/conversation/source-inventory.js";
import { traceJournalPath } from "../../src/orchestrator/trace/store.js";

const HASH = "a".repeat(64);
const ISO = "2026-08-25T00:00:00.000Z";

function durableRecord(
  id: string,
  options: {
    revision?: string;
    parentId?: string | null;
    parentRevision?: string | null;
    children?: string[];
    version?: string;
    createdAt?: string;
  } = {},
) {
  return {
    manifest: {
      version: options.version ?? "1.0",
      conversation_id: id,
      workflow_id: "shared-workflow-is-not-lineage",
      revision_id: options.revision ?? `revision-${id}`,
      run_id: `run-${id}`,
      parent_conversation_id: options.parentId ?? null,
      parent_revision_id: options.parentRevision ?? null,
      topic: `Topic ${id}`,
      policy: "direct",
      max_rounds: 1,
      baseline_enabled: true,
      evaluator_auto_added: false,
      repo_root: "/Users/private/secret-project",
      phase: 1,
      task_text: "SECRET-TASK-CANARY",
      bindings: [
        {
          participant_id: `participant-${id}`,
          input: { roleRef: "direct", engine: "codex", sessionMode: "fresh" },
        },
      ],
      created_at: options.createdAt ?? ISO,
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
    resume_bindings: [],
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

function storedRecord(id: string, revision: string, seq: number, ts: string, event: unknown) {
  return {
    stored_event: {
      workflow_id: "shared-workflow-is-not-lineage",
      conversation_id: id,
      revision_id: revision,
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

function writeLegacy(
  artifactRoot: string,
  traceRoot: string,
  record: ReturnType<typeof durableRecord>,
  updatedAt = ISO,
) {
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(traceRoot, "conversations"), { recursive: true, mode: 0o700 });
  const id = record.manifest.conversation_id;
  const revision = record.manifest.revision_id;
  writeFileSync(conversationManifestPath(artifactRoot, id), JSON.stringify(record), {
    mode: 0o600,
  });
  const lines = [
    storedRecord(id, revision, 1, record.manifest.created_at, {
      type: "conversation_configured",
      payload: {
        topic: record.manifest.topic,
        participants: [
          {
            participant_id: record.manifest.bindings[0]?.participant_id,
            role_ref: "direct",
            engine: "codex",
            model: "gpt-5.4",
          },
        ],
        policy: "direct",
        max_rounds: 1,
      },
    }),
    storedRecord(id, revision, 2, updatedAt, {
      type: "state_change",
      payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
    }),
  ];
  writeFileSync(
    traceJournalPath(traceRoot, id),
    `${lines.map((item) => JSON.stringify(item)).join("\n")}\n`,
    {
      mode: 0o600,
    },
  );
}

function memorySource(
  id: string,
  options: { parentId?: string | null; parentRevision?: string | null; children?: string[] } = {},
): ValidatedConversationSourceV1 {
  const record = durableRecord(id, options);
  const digest = `sha256:${createHash("sha256").update(id).digest("hex")}`;
  return {
    manifest: record.manifest,
    manifest_record: record,
    manifest_digest: digest,
    journal_head: {
      schema_version: "1.0" as const,
      record_id: id,
      record_digest: digest,
      last_seq: 0,
      updated_at: ISO,
      lifecycle: "INIT" as const,
      health: "healthy" as const,
      participants: [],
    },
    journal_records: [],
  } as unknown as ValidatedConversationSourceV1;
}

function treeDigest(root: string): string[] {
  const output: string[] = [];
  const walk = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path, `${relative}/`);
      else {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        output.push(`${relative}:${stat.mode & 0o777}:${digest}`);
      }
    }
  };
  walk(root);
  return output;
}

test("an empty legacy repository is authoritative empty state and remains byte-identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-empty-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    mkdirSync(artifacts, { mode: 0o700 });
    mkdirSync(traces, { mode: 0o700 });
    const before = treeDigest(root);
    const inventory = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    const result = deriveConversationLineages(inventory);
    expect(inventory).toMatchObject({ state: "empty", authoritative: true, sources: [] });
    expect(result).toMatchObject({ state: "empty", authoritative: true, lineages: [] });
    expect(treeDigest(root)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source inventory rejects unsafe public identities without reflecting canaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-public-identity-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    const canary = "/Users/alice/private";
    const record = durableRecord(canary, {
      revision: "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    });
    const binding = record.manifest.bindings[0];
    const authority = record.binding_authorities[0];
    if (!binding || !authority) throw new Error("fixture participant is absent");
    binding.participant_id = "participant-safe";
    authority.participant_id = "participant-safe";
    writeLegacy(artifacts, traces, record);
    const unsafeParent = durableRecord("child", {
      parentId: "/private/parent",
      parentRevision: "github_pat_ZYXWVUTSRQPONMLKJIHGFEDCBA123456",
    });
    writeLegacy(artifacts, traces, unsafeParent);
    const result = readConversationSourceInventory({ artifactRoot: artifacts, traceRoot: traces });
    expect(result.sources).toEqual([]);
    expect(result.state).toBe("degraded");
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain("github_pat_");
    expect(JSON.stringify(result)).not.toContain("/private/parent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("descriptor-pinned reads reject replacement of an intermediate path component", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-pinned-"));
  const parent = join(root, "authority");
  const sourceRoot = join(parent, "artifacts");
  const moved = join(root, "authority-original");
  try {
    mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(sourceRoot, "source.json"), "trusted", { mode: 0o600 });
    const snapshot = inspectPrivateDirectoryReadOnly(sourceRoot);
    expect(snapshot.state).toBe("valid");
    try {
      renameSync(parent, moved);
      mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
      writeFileSync(join(sourceRoot, "source.json"), "replacement", { mode: 0o600 });
      expect(() => readPrivateDirectoryNames(snapshot)).toThrow();
      expect(() => readPrivateFileBytesAt(snapshot, "source.json", 1024)).toThrow();
    } finally {
      closePrivateDirectorySnapshot(snapshot);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reader derives paired legacy ancestry and one deterministic initial head without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-one-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    const parent = durableRecord("root", { revision: "revision-root", children: ["child"] });
    const child = durableRecord("child", {
      revision: "revision-child",
      parentId: "root",
      parentRevision: "revision-root",
      createdAt: "2026-08-25T00:01:00.000Z",
    });
    writeLegacy(artifacts, traces, parent, "2026-08-25T00:00:30.000Z");
    writeLegacy(artifacts, traces, child, "2026-08-25T00:01:30.000Z");
    const before = treeDigest(root);

    const inventory = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    const result = deriveConversationLineages(inventory);

    expect(result.lineages).toHaveLength(1);
    expect(result.lineages[0]?.nodes.map((item) => item.node)).toEqual([
      { conversation_id: "root", revision_id: "revision-root", revision_ordinal: 0 },
      { conversation_id: "child", revision_id: "revision-child", revision_ordinal: 1 },
    ]);
    expect(result.lineages[0]?.eligible_leaves.map((item) => item.node.conversation_id)).toEqual([
      "child",
    ]);
    expect(result.lineages[0]?.validated_leaf_set_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.lineages[0]?.initial_head_candidate).toMatchObject({
      head_status: "committed",
      active: { conversation_id: "child", revision_id: "revision-child", revision_ordinal: 1 },
      head_epoch: 0,
      previous_head_digest: null,
      updated_by_operation_id: null,
      updated_at: "2026-08-25T00:01:30.000Z",
    });
    expect(treeDigest(root)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("race leaves remain ambiguous and timestamps never choose a winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-race-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    writeLegacy(
      artifacts,
      traces,
      durableRecord("root", {
        revision: "revision-root",
        children: ["later", "earlier"],
      }),
    );
    writeLegacy(
      artifacts,
      traces,
      durableRecord("later", {
        revision: "revision-z",
        parentId: "root",
        parentRevision: "revision-root",
      }),
      "2026-08-25T23:59:59.000Z",
    );
    writeLegacy(
      artifacts,
      traces,
      durableRecord("earlier", {
        revision: "revision-a",
        parentId: "root",
        parentRevision: "revision-root",
      }),
      "2026-08-25T00:00:01.000Z",
    );

    const result = deriveConversationLineages(
      readConversationSourceInventory({ artifactRoot: artifacts, traceRoot: traces }),
    );
    const head = result.lineages[0]?.initial_head_candidate;
    expect(head?.head_status).toBe("ambiguous");
    expect(head?.active).toBeNull();
    expect(head?.candidate_heads.map((item) => item.conversation_id)).toEqual(["earlier", "later"]);
    expect(head?.updated_at).toBe("2026-08-25T23:59:59.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a durable child claim with no validated child leaves zero eligible heads", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-zero-leaf-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    writeLegacy(
      artifacts,
      traces,
      durableRecord("root", { revision: "revision-root", children: ["missing-child"] }),
    );
    const result = deriveConversationLineages(
      readConversationSourceInventory({ artifactRoot: artifacts, traceRoot: traces }),
    );
    expect(result.lineages[0]?.eligible_leaves).toEqual([]);
    expect(result.lineages[0]?.initial_head_candidate).toBeNull();
    expect(result.authoritative).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["unpaired-child-claim", "zero-eligible-leaves"]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing journals, orphans, mismatched parent pairs, malformed and newer records are excluded with diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-invalid-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    mkdirSync(join(traces, "conversations"), { recursive: true, mode: 0o700 });
    writeLegacy(artifacts, traces, durableRecord("valid"));

    const missing = durableRecord("missing-journal");
    writeFileSync(conversationManifestPath(artifacts, "missing-journal"), JSON.stringify(missing), {
      mode: 0o600,
    });
    writeLegacy(
      artifacts,
      traces,
      durableRecord("orphan", {
        parentId: "absent",
        parentRevision: "revision-absent",
      }),
    );
    writeLegacy(
      artifacts,
      traces,
      durableRecord("half-parent", { parentId: "valid", parentRevision: null }),
    );
    const newer = durableRecord("newer", { version: "2.0" });
    writeFileSync(conversationManifestPath(artifacts, "newer"), JSON.stringify(newer), {
      mode: 0o600,
    });
    writeFileSync(join(artifacts, `${"b".repeat(64)}.json`), "{malformed", { mode: 0o600 });
    writeFileSync(join(artifacts, "not-a-hash.json"), "{}", { mode: 0o600 });

    const inventory = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    const result = deriveConversationLineages(inventory);

    expect(inventory.state).toBe("degraded");
    expect(inventory.authoritative).toBe(false);
    expect(inventory.sources.map((item) => item.manifest.conversation_id)).toEqual([
      "half-parent",
      "orphan",
      "valid",
    ]);
    expect(result.lineages.map((item) => item.root_session_id)).toEqual(["valid"]);
    expect(result.excluded_conversation_ids).toEqual(["half-parent", "orphan"]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "invalid-manifest-filename",
        "invalid-manifest",
        "missing-journal",
        "unsupported-schema-version",
        "unlinked-parent",
        "invalid-parent-pair",
      ]),
    );
    expect(readdirSync(join(traces, "conversations"))).not.toContain(
      traceJournalPath(traces, "missing-journal").split("/").at(-1),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reader rejects symlinked or non-private roots and json-shaped directories without writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-path-safety-"));
  try {
    const real = join(root, "real");
    const artifacts = join(real, "artifacts");
    const traces = join(real, "trace");
    mkdirSync(artifacts, { recursive: true, mode: 0o700 });
    mkdirSync(join(traces, "conversations"), { recursive: true, mode: 0o700 });
    const alias = join(root, "alias");
    symlinkSync(real, alias, "dir");
    const before = treeDigest(real);
    const symlinked = readConversationSourceInventory({
      artifactRoot: join(alias, "artifacts"),
      traceRoot: join(alias, "trace"),
    });
    expect(symlinked).toMatchObject({ state: "degraded", authoritative: false, sources: [] });
    expect(symlinked.diagnostics.map((item) => item.code)).toContain("invalid-source-root");
    expect(treeDigest(real)).toEqual(before);

    chmodSync(artifacts, 0o755);
    const nonPrivate = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    expect(nonPrivate.diagnostics.map((item) => item.code)).toContain("invalid-source-root");
    chmodSync(artifacts, 0o700);

    const directoryName = `${"d".repeat(64)}.json`;
    mkdirSync(join(artifacts, directoryName), { mode: 0o700 });
    const directoryEntry = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    expect(directoryEntry.diagnostics).toContainEqual(
      expect.objectContaining({ code: "invalid-manifest", record_id: directoryName }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reader rejects duplicate configuration and manifest-role disagreement via the semantic fold", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-fold-"));
  try {
    const artifacts = join(root, "artifacts");
    const traces = join(root, "trace");
    const duplicate = durableRecord("duplicate-config");
    writeLegacy(artifacts, traces, duplicate);
    appendFileSync(
      traceJournalPath(traces, "duplicate-config"),
      `${JSON.stringify(
        storedRecord(
          "duplicate-config",
          duplicate.manifest.revision_id,
          3,
          "2026-08-25T00:01:00.000Z",
          {
            type: "conversation_configured",
            payload: {
              topic: duplicate.manifest.topic,
              participants: [
                {
                  participant_id: "participant-duplicate-config",
                  role_ref: "direct",
                  engine: "codex",
                  model: "gpt-5.4",
                },
              ],
              policy: "direct",
              max_rounds: 1,
            },
          },
        ),
      )}\n`,
    );

    const role = durableRecord("role-mismatch");
    writeLegacy(artifacts, traces, role);
    const rolePath = traceJournalPath(traces, "role-mismatch");
    const roleRecords = readFileSync(rolePath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    roleRecords[0].stored_event.event.payload.participants[0].role_ref = "different-role";
    writeFileSync(rolePath, `${roleRecords.map((item) => JSON.stringify(item)).join("\n")}\n`, {
      mode: 0o600,
    });

    const inventory = readConversationSourceInventory({
      artifactRoot: artifacts,
      traceRoot: traces,
    });
    expect(inventory.sources).toEqual([]);
    expect(inventory.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid-journal", record_id: "duplicate-config" }),
        expect.objectContaining({ code: "manifest-journal-mismatch", record_id: "role-mismatch" }),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized candidate sets degrade only that lineage and preserve unrelated roots", () => {
  const childIds = Array.from(
    { length: 513 },
    (_, index) => `leaf-${index.toString().padStart(3, "0")}`,
  );
  const oversizedRoot = memorySource("wide-root", { children: childIds });
  const children = childIds.map((id) =>
    memorySource(id, {
      parentId: "wide-root",
      parentRevision: "revision-wide-root",
    }),
  );
  const independent = memorySource("independent");
  const result = deriveConversationLineages({
    schema_version: "1.0",
    state: "ready",
    authoritative: true,
    sources: [oversizedRoot, ...children, independent],
    diagnostics: [],
    observed_source_digest: `sha256:${"e".repeat(64)}`,
  });
  expect(result.authoritative).toBe(false);
  expect(result.lineages.map((lineage) => lineage.root_session_id)).toEqual(["independent"]);
  expect(result.excluded_conversation_ids).toContain("wide-root");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "lineage-too-large", record_id: "wide-root" }),
  );
});

test("lineage writer installs deterministic initial authority and restart reads identical bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-writer-"));
  try {
    chmodSync(root, 0o700);
    const inventory = {
      schema_version: "1.0" as const,
      state: "ready" as const,
      authoritative: true,
      sources: [memorySource("root")],
      diagnostics: [],
      observed_source_digest: `sha256:${"d".repeat(64)}`,
    };
    const lineage = deriveConversationLineages(inventory).lineages[0];
    if (!lineage) throw new Error("missing test lineage");
    const firstStore = new LineageAuthorityStore({ artifactRoot: root });
    const installed = firstStore.initializeHead(lineage);
    const path = firstStore.paths.heads;
    expect(lineage.initial_head_candidate).not.toBeNull();
    expect(installed).toEqual(
      lineage.initial_head_candidate as NonNullable<typeof lineage.initial_head_candidate>,
    );
    expect(statSync(path).mode & 0o777).toBe(0o700);
    const restarted = new LineageAuthorityStore({ artifactRoot: root });
    expect(restarted.readHead("root")).toEqual(installed);
    expect(restarted.initializeHead(lineage)).toEqual(installed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit first-head deferral persists unclaimed without changing an installed winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-deferred-"));
  try {
    chmodSync(root, 0o700);
    const inventory = {
      schema_version: "1.0" as const,
      state: "ready" as const,
      authoritative: true,
      sources: [memorySource("root")],
      diagnostics: [],
      observed_source_digest: `sha256:${"d".repeat(64)}`,
    };
    const lineage = deriveConversationLineages(inventory).lineages[0];
    if (!lineage) throw new Error("missing test lineage");
    const store = new LineageAuthorityStore({ artifactRoot: root });
    const deferred = store.initializeHead(lineage, { deferSingleCandidate: true });
    expect(deferred).toMatchObject({
      head_status: "unclaimed",
      active: null,
      candidate_heads: [{ conversation_id: "root", revision_ordinal: 0 }],
      head_epoch: 0,
    });
    expect(store.initializeHead(lineage)).toEqual(deferred);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero-leaf lineage never creates a head and reservation CAS enforces legal edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-reservation-"));
  try {
    chmodSync(root, 0o700);
    const store = new LineageAuthorityStore({ artifactRoot: root });
    const noLeaf = {
      schema_version: "1.0" as const,
      root_session_id: "root",
      nodes: [],
      eligible_leaves: [],
      validated_leaf_set_digest: `sha256:${"a".repeat(64)}`,
      initial_head_candidate: null,
    };
    expect(() => store.initializeHead(noLeaf)).toThrow("zero eligible leaves");
    expect(store.readHead("root")).toBeNull();

    const activeBody = {
      schema_version: "1.0" as const,
      root_session_id: "root",
      reservation_epoch: 1,
      previous_reservation_digest: null,
      status: "active" as const,
      parent: { conversation_id: "root", revision_id: "revision-root", revision_ordinal: 0 },
      revision_claim_epoch: 1,
      operation_id: `vf-operation-${"1".repeat(64)}`,
      proposal_id: `vf-proposal-${"2".repeat(64)}`,
      plan_digest: `sha256:${"3".repeat(64)}`,
      child: { conversation_id: "child", revision_id: "revision-child", revision_ordinal: 1 },
      created_at: ISO,
      updated_at: ISO,
    };
    const active = { ...activeBody, content_digest: revisionReservationDigest(activeBody) };
    expect(store.commitReservation(null, active)).toEqual(active);
    const consumedBody = {
      ...activeBody,
      reservation_epoch: 2,
      previous_reservation_digest: active.content_digest,
      status: "consumed" as const,
      updated_at: "2026-08-25T00:00:01.000Z",
    };
    const consumed = {
      ...consumedBody,
      content_digest: revisionReservationDigest(consumedBody),
    };
    expect(store.commitReservation(active, consumed)).toEqual(consumed);
    expect(store.readReservation("root")).toEqual(consumed);
    expect(() => store.commitReservation(active, consumed)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lineage service resolves any revision ID and paginates the selected ancestry", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-lineage-service-"));
  try {
    chmodSync(root, 0o700);
    const inventory = {
      schema_version: "1.0" as const,
      state: "ready" as const,
      authoritative: true,
      sources: [
        memorySource("root", { children: ["child"] }),
        memorySource("child", { parentId: "root", parentRevision: "revision-root" }),
      ],
      diagnostics: [],
      observed_source_digest: `sha256:${"d".repeat(64)}`,
    };
    const service = new ConversationLineageService({
      artifactRoot: root,
      traceRoot: join(root, "unused-traces"),
      scopeId: "project:test",
      cursorCodec: new CatalogCursorCodec(Buffer.alloc(32, 8)),
      readInventory: () => inventory,
    });
    const first = service.read("child", { limit: 1 });
    expect(first).toMatchObject({
      root_session_id: "root",
      requested: { conversation_id: "child", revision_ordinal: 1 },
      head_status: "committed",
      active: { conversation_id: "child", revision_ordinal: 1 },
    });
    expect(first.nodes.map((item) => item.conversation_id)).toEqual(["root"]);
    expect(first.next_cursor).not.toBeNull();
    const second = service.read("root", { limit: 1, cursor: first.next_cursor as string });
    expect(second.nodes.map((item) => item.conversation_id)).toEqual(["child"]);
    expect(second.next_cursor).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
