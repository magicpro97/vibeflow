import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS,
  CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODES,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KINDS,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KINDS,
  CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASONS,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_STATES,
  isConversationMessageQueueErrorCode,
  isConversationMessageQueueEventKind,
  isConversationMessageQueueMutationKind,
  isConversationMessageQueueStaleReason,
  isConversationMessageQueueState,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";

const contractObjects = [
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

describe("conversation message queue typed runtime contract", () => {
  test("runtime values are frozen, inferred, and narrowed fail-closed", () => {
    expect(contractObjects.every(Object.isFrozen)).toBe(true);
    expect(CONVERSATION_MESSAGE_QUEUE_STATES).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_STATE),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_STALE_REASONS).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_STALE_REASON),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_EVENT_KINDS).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_EVENT_KIND),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_MUTATION_KINDS).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_ERROR_CODES).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_ERROR_CODE),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_STATES.every(isConversationMessageQueueState)).toBe(true);
    expect(
      CONVERSATION_MESSAGE_QUEUE_STALE_REASONS.every(isConversationMessageQueueStaleReason),
    ).toBe(true);
    expect(CONVERSATION_MESSAGE_QUEUE_EVENT_KINDS.every(isConversationMessageQueueEventKind)).toBe(
      true,
    );
    expect(
      CONVERSATION_MESSAGE_QUEUE_MUTATION_KINDS.every(isConversationMessageQueueMutationKind),
    ).toBe(true);
    expect(CONVERSATION_MESSAGE_QUEUE_ERROR_CODES.every(isConversationMessageQueueErrorCode)).toBe(
      true,
    );
    expect([
      isConversationMessageQueueState("unknown"),
      isConversationMessageQueueStaleReason(null),
      isConversationMessageQueueEventKind(1),
      isConversationMessageQueueMutationKind("remove"),
      isConversationMessageQueueErrorCode("internal_error"),
    ]).toEqual([false, false, false, false, false]);
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
