import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestV1 } from "../../src/durability/index.js";
import { ConversationInteractionStore } from "../../src/orchestrator/conversation/conversation-interaction-store.js";
import type { PublicMessageLocatorV1 } from "../../src/orchestrator/conversation/conversation-interaction-types.js";
import type { ConversationMessageAuthorityV1 } from "../../src/orchestrator/conversation/conversation-message-authority.js";
import { ConversationSocialAuthorityV1 } from "../../src/orchestrator/conversation/conversation-social-authority.js";

const locator = (
  eventId: string,
  kind: PublicMessageLocatorV1["target_kind"] = "completed-agent-response",
): PublicMessageLocatorV1 => ({
  root_session_id: "root-session",
  conversation_id: "conversation",
  revision_id: "revision",
  target_event_id: eventId,
  target_kind: kind,
  content_digest: digestV1("FIXTURE-MESSAGE\0v1\0", { event_id: eventId }),
});

test("participant social intent rejects self reactions and more than three distinct adds atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-participant-social-"));
  try {
    const response = locator("response-1");
    const targets = ["self", "other-1", "other-2", "other-3", "other-4"].map((id) => ({
      locator: locator(id, "user-message"),
      author_public_id: id === "self" ? "participant-1" : "human",
      preview_text: id,
      created_at: "2026-08-25T00:00:00.000Z",
      revision_ordinal: 0,
      public_seq: id === "self" ? 1 : Number(id.slice(-1)) + 1,
      target_participants: "all" as const,
      quote_refs: [],
    }));
    const responseRow = {
      locator: response,
      author_public_id: "participant-1",
      preview_text: "answer",
      created_at: "2026-08-25T00:00:05.000Z",
      revision_ordinal: 0,
      public_seq: 6,
      target_participants: "all" as const,
      quote_refs: [],
    };
    const rows = [...targets, responseRow];
    const messages = {
      inventory: () => ({ root_session_id: "root-session", messages: rows }),
      resolve: (_conversationId: string, candidate: PublicMessageLocatorV1) => {
        const row = rows.find((item) => item.locator.target_event_id === candidate.target_event_id);
        if (!row) throw new Error("missing target");
        return structuredClone(row);
      },
      quote: () => {
        throw new Error("not used");
      },
    } as unknown as ConversationMessageAuthorityV1;
    const request = (eventIds: string[]) => ({
      present: true,
      quote_refs: undefined,
      reactions: eventIds.map((eventId) => ({
        operation: "add",
        target: rows.find((row) => row.locator.target_event_id === eventId)?.locator,
        emoji: "👍",
      })),
    });
    const selfAuthority = new ConversationSocialAuthorityV1(
      new ConversationInteractionStore(join(root, "self")),
      messages,
      () => "2026-08-25T00:00:06.000Z",
    );
    expect(
      selfAuthority.participantIntent({
        conversation_id: "conversation",
        response_event_id: "response-1",
        actor_participant_id: "participant-1",
        request: request(["self"]),
      }),
    ).toEqual({ accepted: false, diagnostic_code: "invalid_social_intent" });

    const boundedStore = new ConversationInteractionStore(join(root, "bounded"));
    const boundedAuthority = new ConversationSocialAuthorityV1(
      boundedStore,
      messages,
      () => "2026-08-25T00:00:06.000Z",
    );
    expect(
      boundedAuthority.participantIntent({
        conversation_id: "conversation",
        response_event_id: "response-1",
        actor_participant_id: "participant-1",
        request: request(["other-1", "other-2", "other-3", "other-4"]),
      }),
    ).toEqual({ accepted: false, diagnostic_code: "invalid_social_intent" });
    expect(boundedStore.readFold("root-session").reactions).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("conversation interaction authority", () => {
  test("binds retries while preserving add-remove-add and remove-add-remove transitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-interactions-"));
    try {
      const store = new ConversationInteractionStore(root);
      const base = {
        root_session_id: "root-session",
        actor_public_id: "browser-actor",
        target: locator("event-1"),
        emoji: "👍" as const,
        created_at: "2026-08-25T00:00:00.000Z",
      };
      const add1 = store.commitHumanToggle({ ...base, idempotency_key: "toggle-1" });
      expect(store.commitHumanToggle({ ...base, idempotency_key: "toggle-1" })).toEqual(add1);
      expect(
        store.commitHumanReaction({
          ...base,
          idempotency_key: "semantic-add-retry",
          operation: "add",
        }),
      ).toEqual(add1);
      expect(store.readHead("root-session").sequence).toBe(1);

      const remove1 = store.commitHumanToggle({ ...base, idempotency_key: "toggle-2" });
      const add2 = store.commitHumanToggle({ ...base, idempotency_key: "toggle-3" });
      const remove2 = store.commitHumanToggle({ ...base, idempotency_key: "toggle-4" });
      expect([add1.operation, remove1.operation, add2.operation, remove2.operation]).toEqual([
        "add",
        "remove",
        "add",
        "remove",
      ]);
      expect(
        new Set([add1.operation_id, remove1.operation_id, add2.operation_id, remove2.operation_id])
          .size,
      ).toBe(4);
      expect(store.readHead("root-session").sequence).toBe(4);
      expect(store.commitHumanToggle({ ...base, idempotency_key: "toggle-3" })).toEqual(add2);
      expect(store.readHead("root-session").sequence).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects request-key conflicts and participant intent semantic replay changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-interactions-conflict-"));
    try {
      const store = new ConversationInteractionStore(root);
      const base = {
        root_session_id: "root-session",
        actor_public_id: "browser-actor",
        idempotency_key: "same-request",
        target: locator("event-1"),
        emoji: "🎉" as const,
        created_at: "2026-08-25T00:00:00.000Z",
      };
      store.commitHumanToggle(base);
      expect(() => store.commitHumanToggle({ ...base, target: locator("event-2") })).toThrow(
        "idempotency binding conflict",
      );

      const participant = {
        root_session_id: "root-session",
        actor_participant_id: "participant-1",
        response: locator("response-1"),
        quote_refs: [],
        reactions: [],
        diagnostic_code: null,
        created_at: "2026-08-25T00:00:01.000Z",
      };
      const intent = store.commitParticipantIntent(participant);
      expect(store.commitParticipantIntent(participant)).toEqual(intent);
      expect(() =>
        store.commitParticipantIntent({
          ...participant,
          quote_refs: [{ ...locator("event-1"), author_public_id: "human" }],
        }),
      ).toThrow("participant social intent idempotency conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recovers an exact toggle across both request-binding crash frontiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-interactions-crash-"));
    try {
      const base = {
        root_session_id: "root-session",
        actor_public_id: "browser-actor",
        target: locator("event-1"),
        emoji: "👍" as const,
        created_at: "2026-08-25T00:00:00.000Z",
      };
      let failBeforeAppend = true;
      const before = new ConversationInteractionStore(root, {
        afterHumanRequestBinding: () => {
          if (failBeforeAppend) {
            failBeforeAppend = false;
            throw new Error("crash after request binding");
          }
        },
      });
      const firstRequest = { ...base, idempotency_key: "before-append" };
      expect(() => before.commitHumanToggle(firstRequest)).toThrow("crash after request binding");
      expect(before.readHead("root-session").sequence).toBe(0);
      const restarted = new ConversationInteractionStore(root);
      restarted.commitParticipantIntent({
        root_session_id: "root-session",
        actor_participant_id: "participant-1",
        response: locator("response-after-crash"),
        quote_refs: [],
        reactions: [],
        diagnostic_code: null,
        created_at: "2026-08-25T00:00:01.000Z",
      });
      const recoveredFirst = restarted.commitHumanToggle(firstRequest);
      expect(recoveredFirst.operation).toBe("add");
      expect(restarted.readHead("root-session").sequence).toBe(2);
      expect(() =>
        new ConversationInteractionStore(root).commitHumanToggle({
          ...firstRequest,
          emoji: "🎉",
        }),
      ).toThrow("idempotency binding conflict");

      let failAfterAppend = true;
      const after = new ConversationInteractionStore(root, {
        afterHumanReactionAppend: () => {
          if (failAfterAppend) {
            failAfterAppend = false;
            throw new Error("crash after reaction append");
          }
        },
      });
      const secondRequest = { ...base, idempotency_key: "after-append" };
      expect(() => after.commitHumanToggle(secondRequest)).toThrow("crash after reaction append");
      expect(after.readHead("root-session").sequence).toBe(3);
      const recoveredSecond = new ConversationInteractionStore(root).commitHumanToggle(
        secondRequest,
      );
      expect(recoveredSecond.operation).toBe("remove");
      expect(new ConversationInteractionStore(root).readHead("root-session").sequence).toBe(3);
      expect(() =>
        new ConversationInteractionStore(root).commitHumanToggle({
          ...secondRequest,
          target: locator("event-2"),
        }),
      ).toThrow("idempotency binding conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
