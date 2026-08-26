import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import { materializeConversationMessageQueueAuthorityV1 } from "../../src/orchestrator/conversation/conversation-message-queue-authority.js";
import { assertQueueJournalAppendCapacity } from "../../src/orchestrator/conversation/conversation-message-queue-journal.js";
import { ConversationMessageQueueRuntimeV1 } from "../../src/orchestrator/conversation/conversation-message-queue-runtime.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";

const roots: string[] = [];
const now = "2026-08-26T00:00:00.000Z";
const marker = (label: string): string =>
  digestV1("VF-QUEUE-RUNTIME-BOUNDARY-TEST\0v1\0", { label });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("exact replay avoids live authority reads and throwing subscribers cannot block durable enqueue", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-queue-runtime-replay-"));
  roots.push(root);
  const authority = materializeConversationMessageQueueAuthorityV1({
    root_session_id: "conversation-root",
    conversation_id: "conversation-active",
    revision_id: "revision-active",
    lineage_head_digest: marker("head"),
    lineage_head_epoch: 1,
    participant_set_digest: marker("participants"),
    active_operation_digest: marker("operation"),
  });
  let live = true;
  let lineageReads = 0;
  let quoteReads = 0;
  const runtime = new ConversationMessageQueueRuntimeV1({
    artifactRoot: join(root, "artifacts"),
    traceStore: new TraceStore({ dir: join(root, "trace"), now: () => now }),
    messages: {
      resolveRoot: () => {
        lineageReads += 1;
        if (!live) throw new Error("mutable lineage is no longer available");
        return {
          authority,
          conversation_id: authority.conversation_id,
          source: { manifest: { bindings: [{ participant_id: "participant-a" }] } },
        };
      },
    } as never,
    broker: {
      mutations: {
        prepareAdmission: () => ({
          binding: null,
          commit: () => undefined,
          rollbackProvenAbsent: () => undefined,
        }),
      },
    } as never,
    social: {
      humanQuotes: () => {
        quoteReads += 1;
        if (!live) throw new Error("mutable quote target is no longer available");
        return [];
      },
    } as never,
    now: () => now,
  });
  const kicks: string[] = [];
  runtime.bindDispatcher((rootSessionId) => kicks.push(rootSessionId));
  runtime.subscribe(authority.root_session_id, () => {
    throw new Error("plugin observer failed");
  });
  const request = {
    schema_version: "1.0" as const,
    idempotency_key: "durable-replay-after-authority-drift",
    expected_authority_digest: authority.authority_digest,
    content: "retain the original admitted request",
    target_participants: ["participant-a"],
    quote_refs: [
      {
        root_session_id: authority.root_session_id,
        conversation_id: authority.conversation_id,
        revision_id: authority.revision_id,
        target_event_id: "event-1",
        target_kind: "user-message" as const,
        content_digest: marker("quoted-content"),
        author_public_id: "human",
      },
    ],
    private_context_present: false,
  };
  const first = runtime.enqueue({
    root_session_id: authority.root_session_id,
    principal_digest: marker("principal"),
    request,
  });
  expect(first.replayed).toBe(false);
  expect(
    runtime
      .storeAuthority(authority.root_session_id)
      .readAuthorityFold()
      .items.map(({ item }) => item),
  ).toEqual([first.item]);
  expect(kicks).toEqual([authority.root_session_id]);
  const readsAfterCommit = [lineageReads, quoteReads];

  live = false;
  const replay = runtime.enqueue({
    root_session_id: authority.root_session_id,
    principal_digest: marker("principal"),
    request,
  });
  expect(replay).toEqual({ item: first.item, replayed: true });
  expect([lineageReads, quoteReads]).toEqual(readsAfterCommit);
  expect(kicks).toEqual([authority.root_session_id, authority.root_session_id]);
});

test("journal capacity rejects the first out-of-bound append before publication", () => {
  expect(() => assertQueueJournalAppendCapacity(999_999)).not.toThrow();
  expect(() => assertQueueJournalAppendCapacity(1_000_000)).toThrow(
    "journal reached its lifetime capacity",
  );
});
