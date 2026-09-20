import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationManifestPath } from "../../src/orchestrator/conversation/artifact-store.js";
import type { ConversationDurableRecord } from "../../src/orchestrator/conversation/artifact-validation.js";
import { traceJournalPath } from "../../src/orchestrator/trace/store.js";

export const CATALOG_FIXTURE_HASH = "a".repeat(64);
export const CATALOG_FIXTURE_SECRET = "SECRET-CANARY-DO-NOT-PROJECT";
const DEFAULT_REPO_ROOT = "/Users/private/workspace";

export interface CatalogFixtureRecordOptions {
  parent?: string;
  parentRevision?: string;
  children?: string[];
  topic?: string;
  repoRoot?: string;
}

export function fixtureRecord(
  id: string,
  options: CatalogFixtureRecordOptions = {},
): ConversationDurableRecord {
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
      repo_root: options.repoRoot ?? DEFAULT_REPO_ROOT,
      phase: 1,
      task_text: CATALOG_FIXTURE_SECRET,
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
        role_hash: CATALOG_FIXTURE_HASH,
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

export function eventRecord(id: string, seq: number, ts: string, event: unknown) {
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

export function installFixture(
  artifactRoot: string,
  traceRoot: string,
  record: ConversationDurableRecord,
  updatedAt: string,
): void {
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
