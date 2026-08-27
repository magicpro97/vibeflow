import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS,
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_FIELD,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND,
  CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";

const contractObjects = [
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND,
  CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS,
  CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS,
  CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
] as const;

const queueSemanticObjects = [
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
] as const;

describe("conversation message queue typed runtime contract", () => {
  test("UI and SSE boundaries consume the canonical wire contract without DTO redeclarations", () => {
    const queueTypes = readFileSync(
      resolve("src/ui/src/conversation-home-message-queue-types.ts"),
      "utf8",
    );
    const queueAuthority = readFileSync(
      resolve("src/ui/src/conversation-home-message-queue-authority.ts"),
      "utf8",
    );
    const interactionTypes = readFileSync(
      resolve("src/orchestrator/conversation/conversation-interaction-types.ts"),
      "utf8",
    );
    const sse = readFileSync(resolve("src/server/conversation-sse.ts"), "utf8");

    expect(queueTypes).toContain("conversation-message-queue-wire.js");
    expect(queueTypes).not.toMatch(
      /interface Home(?:EnqueueMessageRequest|EditQueuedMessageRequest|QueuedMessage|MessageQueueSnapshot|MessageQueueInvalidation)/,
    );
    expect(queueAuthority).toContain("isPublicQueuedUserMessageWireV1");
    expect(queueAuthority).toContain("isConversationMessageQueueSnapshotWireV1");
    expect(queueAuthority).toContain("isPublicConversationMessageQueueInvalidationWireV1");
    expect(queueAuthority).not.toMatch(/sha256:\[0-9a-f]|vf-queued-message-/);
    expect(sse).toContain("isPublicConversationMessageQueueInvalidationWireV1");
    expect(sse).not.toMatch(/sha256:\[0-9a-f]|vf-queued-message-/);
    expect(interactionTypes).toContain("ConversationMessageQueueQuoteTargetKindV1");
    expect(interactionTypes).not.toMatch(
      /target_kind:\s*"user-message"\s*\|\s*"completed-agent-response"/,
    );
    const semanticConsumers = [
      resolve("src/ui/src/conversation-home-command-runtime.ts"),
      resolve("src/ui/src/conversation-home-state.ts"),
      resolve("src/ui/src/conversation-home-types.ts"),
    ];
    const semanticDuplicates = semanticConsumers.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return queueSemanticObjects.flatMap((contract) =>
        Object.values(contract)
          .filter((literal) => source.includes(JSON.stringify(literal)))
          .map((literal) => `${path.slice(process.cwd().length + 1)} -> ${literal}`),
      );
    });
    expect(semanticDuplicates).toEqual([]);
  });

  test("assigned persisted-record consumers contain no duplicate raw field literals", () => {
    const consumers = [
      "conversation-message-queue-validation.ts",
      "conversation-message-queue-event-validation.ts",
      "conversation-message-queue-private-validation.ts",
      "conversation-message-queue-authority.ts",
      "conversation-message-queue-records.ts",
      "conversation-message-queue-pending.ts",
    ].map((name) => resolve("src/orchestrator/conversation", name));
    const duplicates = consumers.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return Object.values(CONVERSATION_MESSAGE_QUEUE_FIELD)
        .filter((field) => source.includes(JSON.stringify(field)))
        .map((field) => `${path.slice(process.cwd().length + 1)} -> ${field}`);
    });
    expect(duplicates).toEqual([]);
  });

  test("storage, HTTP, and UI consumers import the contract instead of duplicating literals", () => {
    const conversationRoot = resolve("src/orchestrator/conversation");
    const consumers = readdirSync(conversationRoot)
      .filter(
        (name) =>
          name.startsWith("conversation-message-queue-") &&
          name.endsWith(".ts") &&
          name !== "conversation-message-queue-contract.ts",
      )
      .map((name) => join(conversationRoot, name));
    consumers.push(
      resolve("src/server/conversation-message-queue-http.ts"),
      resolve("src/server/conversation-message-queue-route.ts"),
      resolve("src/ui/src/conversation-home-message-queue-types.ts"),
      resolve("src/ui/src/conversation-home-message-queue-authority.ts"),
      resolve("src/ui/src/conversation-home-message-queue-edit-authority.ts"),
      resolve("src/ui/src/conversation-home-message-queue-runtime.ts"),
      resolve("src/ui/src/conversation-home-message-queue-admission-runtime.ts"),
      resolve("src/ui/src/components/HomeQueuedMessages.vue"),
    );
    const literals = new Set([
      CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      ...contractObjects.flatMap((value) => Object.values(value)),
    ]);
    const duplicates: string[] = [];
    for (const path of consumers) {
      const source = readFileSync(path, "utf8");
      for (const literal of literals) {
        if (source.includes(JSON.stringify(literal)))
          duplicates.push(`${path.slice(process.cwd().length + 1)} -> ${literal}`);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
