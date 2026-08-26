import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import { ConversationAskCompatibilityV1 } from "../../src/orchestrator/conversation/conversation-ask-compatibility.js";
import { ConversationHomeCreateBrokerV1 } from "../../src/orchestrator/conversation/conversation-home-create-authority.js";
import { createIdempotencyKeyDigest } from "../../src/orchestrator/conversation/conversation-private-context-broker-records.js";
import { ConversationPrivateContextBrokerV1 } from "../../src/orchestrator/conversation/conversation-private-context-broker-store.js";
import type { ConversationAllocatedStartV1 } from "../../src/orchestrator/conversation/service-start-authority.js";

const roots: string[] = [];
const principal = digestV1("VF-ASK-ADAPTER-TEST-PRINCIPAL\0v1\0", {});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vf-ask-adapter-"));
  roots.push(root);
  await writeFile(join(root, "context.txt"), "one\ntwo\nthree\n", "utf8");
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 7, 26, 2, 0, tick++)).toISOString();
  const artifactRoot = join(root, "state");
  const privateContext = new ConversationPrivateContextBrokerV1({
    artifactRoot,
    repoRoot: root,
    now,
  });
  const homeCreate = new ConversationHomeCreateBrokerV1(artifactRoot, now, privateContext);
  const starts: ConversationAllocatedStartV1[] = [];
  const enqueues: unknown[] = [];
  const adapter = new ConversationAskCompatibilityV1({
    privateContext,
    homeCreate,
    startAllocated: async (input) => {
      starts.push(input);
      const digest =
        input.private_context_consumed && input.initial_context_record_digest
          ? input.initial_context_record_digest
          : digestV1("VF-ASK-ADAPTER-INITIAL-CONTEXT\0v1\0", {
              conversation_id: input.allocation.conversation_id,
            });
      input.before_publish?.(digest);
      return {
        conversation_id: input.allocation.conversation_id,
        revision_id: input.allocation.revision_id,
        operation_id: input.allocation.operation_id,
        completion: Promise.resolve({
          conversation_id: input.allocation.conversation_id,
          revision_id: input.allocation.revision_id,
          result: {
            operation_id: input.allocation.operation_id,
            status: "completed",
            artifact_refs: [],
          },
        }),
      };
    },
    queue: {
      resolveCommittedConversation: () => ({ root_session_id: "conversation-root" }),
      enqueueCompatibility: (conversationId, principalDigest, idempotencyKey, request) => {
        enqueues.push({ conversationId, principalDigest, idempotencyKey, request });
        return {
          replayed: false,
          item: {
            queue_item_id: `vf-queued-message-${"a".repeat(64)}`,
          },
        } as never;
      },
    },
  });
  return { adapter, starts, enqueues, privateContext };
}

const fresh = (question = "explain") => ({
  kind: "fresh" as const,
  question,
  engine: "codex" as const,
  repo_relative_path: "context.txt",
  start_line: 1,
  end_line: 2,
});

describe("shared Ask conversation adapter", () => {
  test("stages private input, uses fixed Home allocation, and replays after pre-publish consume", async () => {
    const { adapter, starts, privateContext } = await fixture();
    const first = await adapter.submit({
      principal_digest: principal,
      idempotency_key: "ask-create",
      request: fresh(),
    });
    expect(first).toMatchObject({ kind: "created", replayed: false });
    expect(starts[0]).toMatchObject({
      private_context_consumed: false,
      initial_context_record_digest: null,
      request: {
        topic: "explain",
        policy: "direct",
        participants: [{ role_ref: "direct", engine: "codex" }],
        max_rounds: 1,
      },
    });
    expect(starts[0]?.private_file_range).toBeDefined();

    const replay = await adapter.submit({
      principal_digest: principal,
      idempotency_key: "ask-create",
      request: fresh(),
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(starts[1]).toMatchObject({
      allocation: starts[0]?.allocation,
      created_at: starts[0]?.created_at,
      private_context_consumed: true,
      initial_context_record_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(
      privateContext.readDraft(
        privateContext.draftDirectory(principal, createIdempotencyKeyDigest("ask-create")),
      )?.stage_state,
    ).toBe("consumed");
  });

  test("admits identical fresh input under different keys and conflicts on unequal key reuse", async () => {
    const { adapter } = await fixture();
    const first = await adapter.submit({
      principal_digest: principal,
      idempotency_key: "ask-one",
      request: fresh(),
    });
    const second = await adapter.submit({
      principal_digest: principal,
      idempotency_key: "ask-two",
      request: fresh(),
    });
    expect(second.conversation_id).not.toBe(first.conversation_id);
    await expect(
      adapter.submit({
        principal_digest: principal,
        idempotency_key: "ask-one",
        request: fresh("different question"),
      }),
    ).rejects.toThrow("conversation create idempotency key conflict");
  });

  test("resume uses only the committed target resolver and durable queue admission", async () => {
    const { adapter, enqueues } = await fixture();
    expect(
      await adapter.submit({
        principal_digest: principal,
        idempotency_key: "ask-resume",
        request: {
          kind: "resume",
          conversation_id: "conversation-head",
          question: "continue",
        },
      }),
    ).toEqual({
      kind: "queued",
      conversation_id: "conversation-head",
      root_session_id: "conversation-root",
      queue_item_id: `vf-queued-message-${"a".repeat(64)}`,
      replayed: false,
    });
    expect(enqueues).toEqual([
      {
        conversationId: "conversation-head",
        principalDigest: principal,
        idempotencyKey: "ask-resume",
        request: { content: "continue" },
      },
    ]);
  });
});
