import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeDurableQueuedConversationMessageV1 } from "../../src/orchestrator/conversation/conversation-command-compatibility.js";
import { executeDurableConversationCreateV1 } from "../../src/orchestrator/conversation/conversation-command-create-compatibility.js";
import { ConversationPrivateContextBrokerV1 } from "../../src/orchestrator/conversation/conversation-private-context-broker-store.js";
import type { ConversationAllocatedStartV1 } from "../../src/orchestrator/conversation/service-start-authority.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const unsubscribe = (onClose: () => void) =>
  Object.assign(() => onClose(), {
    replayReady: Promise.resolve(),
  });

describe("conversation command durable compatibility", () => {
  test("fresh durable create uses allocated Home start instead of direct service.start", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-command-create-"));
    roots.push(root);
    const artifactRoot = join(root, "state");
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 7, 26, 3, 0, tick++)).toISOString();
    const privateContext = new ConversationPrivateContextBrokerV1({
      artifactRoot,
      repoRoot: root,
      now,
    });
    let directStartCalled = false;
    let allocatedStartCalled = false;
    const result = await executeDurableConversationCreateV1(
      {
        authorities: {
          artifactStore: { rootPath: () => artifactRoot },
          homeAuthorities: { now },
          privateContextBroker: privateContext,
        },
        service: {
          start: async () => {
            directStartCalled = true;
            throw new Error("unexpected direct service.start");
          },
          startAllocated: async (input: ConversationAllocatedStartV1) => {
            allocatedStartCalled = true;
            input.before_publish(null);
            return {
              conversation_id: input.allocation.conversation_id,
              revision_id: input.allocation.revision_id,
              operation_id: input.allocation.operation_id,
              completion: Promise.resolve({
                conversation_id: input.allocation.conversation_id,
                revision_id: input.allocation.revision_id,
                result: {
                  operation_id: input.allocation.operation_id,
                  status: "awaiting_approval",
                  artifact_refs: ["artifact-plan"],
                },
              }),
            };
          },
          subscribe: () => unsubscribe(() => undefined),
        },
      } as never,
      {
        principal_digest: "sha256:1".padEnd(71, "1"),
        idempotency_key: "vf.chat.create.test",
        request: {
          topic: "draft a plan",
          policy: "plan",
        },
      },
    );
    expect(allocatedStartCalled).toBe(true);
    expect(directStartCalled).toBe(false);
    expect(result).toMatchObject({
      conversationId: expect.stringMatching(/^conversation-/),
      revisionId: expect.stringMatching(/^revision-/),
      status: "awaiting_approval",
      artifactRefs: ["artifact-plan"],
    });
  });

  test("queued delivery wait aborts with AbortError before a child conversation is delivered", async () => {
    const controller = new AbortController();
    const pending = executeDurableQueuedConversationMessageV1(
      {
        authorities: {
          messageQueue: {
            resolveCommittedConversation: () => ({ root_session_id: "conversation-root" }),
            assertRoot: () => ({ authority_digest: "sha256:2".padEnd(71, "2") }),
            enqueueCompatibility: () => ({
              item: { queue_item_id: "queue-item-1" },
            }),
            storeAuthority: () => ({
              journal: { readEvents: () => [] },
            }),
          },
          privateContextBroker: {},
        },
        service: {
          subscribe: () => unsubscribe(() => undefined),
          snapshot: async () => ({ lifecycle: "ACTIVE" }),
        },
      } as never,
      {
        conversation_id: "conversation-head",
        principal_digest: "sha256:3".padEnd(71, "3"),
        idempotency_key: "vf.chat.message.test",
        content: "continue",
      },
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("terminal wait aborts with AbortError and unsubscribes the stream listener", async () => {
    let unsubscribed = false;
    const controller = new AbortController();
    const pending = executeDurableQueuedConversationMessageV1(
      {
        authorities: {
          messageQueue: {
            resolveCommittedConversation: () => ({ root_session_id: "conversation-root" }),
            assertRoot: () => ({ authority_digest: "sha256:4".padEnd(71, "4") }),
            enqueueCompatibility: () => ({
              item: { queue_item_id: "queue-item-2" },
            }),
            storeAuthority: () => ({
              journal: {
                readEvents: () => [
                  {
                    payload: {
                      kind: "delivered",
                      item: { queue_item_id: "queue-item-2" },
                      delivery_proof: {
                        successor_authority: { conversation_id: "conversation-child" },
                      },
                    },
                  },
                ],
              },
            }),
          },
          privateContextBroker: {},
        },
        service: {
          subscribe: () =>
            unsubscribe(() => {
              unsubscribed = true;
            }),
          snapshot: async () => ({ lifecycle: "ACTIVE" }),
        },
      } as never,
      {
        conversation_id: "conversation-head",
        principal_digest: "sha256:5".padEnd(71, "5"),
        idempotency_key: "vf.chat.message.abort",
        content: "continue",
      },
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(unsubscribed).toBe(true);
  });
});
