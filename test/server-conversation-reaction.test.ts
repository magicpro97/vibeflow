import { expect, test } from "bun:test";
import { digestV1 } from "../src/durability/index.js";
import type { ConversationInteractionProjectionV1 } from "../src/orchestrator/conversation/conversation-interaction-types.js";
import { handleConversationReactionRoute } from "../src/server/conversation-reaction-route.js";
import { handleConversationTimelineRoute } from "../src/server/conversation-timeline-route.js";

const locator = {
  root_session_id: "root-session",
  conversation_id: "conversation",
  revision_id: "revision",
  target_event_id: "event-1",
  target_kind: "completed-agent-response" as const,
  content_digest: digestV1("FIXTURE-MESSAGE\0v1\0", { event_id: "event-1" }),
};

const sessionA = Buffer.alloc(32, 1).toString("base64url");
const sessionB = Buffer.alloc(32, 2).toString("base64url");

const request = (cookie: string, body?: unknown) =>
  new Request("http://127.0.0.1/api/conversations/conversation/events/event-1/reactions", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "x-vibeflow-token": "csrf",
    },
    body: JSON.stringify(
      body ?? {
        schema_version: "1.0",
        idempotency_key: "reaction-request-1",
        mode: "toggle-self",
        emoji: "👍",
        message_ref: locator,
      },
    ),
  });

test("reaction mutation and timeline reload derive the same actor without exposing credentials", async () => {
  let mutatedActor = "";
  const projection = (recipient: string | null): ConversationInteractionProjectionV1 => ({
    schema_version: "1.0",
    state: "ready",
    root_session_id: "root-session",
    interaction_head_digest: digestV1("FIXTURE-INTERACTION\0v1\0", { sequence: 1 }),
    interaction_head_sequence: 1,
    interaction_head_digests_by_sequence: {},
    reaction_changes: [],
    message_locators_by_event_id: { "event-1": locator },
    quote_projections_by_response_event_id: {},
    reaction_projections: [
      {
        target: locator,
        emoji: "👍",
        count: 1,
        reacted_by_recipient: recipient === mutatedActor,
        actor_public_ids: [mutatedActor],
      },
    ],
    diagnostics_by_response_event_id: {},
  });
  const response = await handleConversationReactionRoute(
    {
      sessions: { authorize: () => true },
      csrf: () => true,
      rootSessionId: () => "root-session",
      interactions: {
        humanToggle: (input) => {
          mutatedActor = input.actor_public_id;
          return {
            schema_version: "1.0",
            operation_id: `vf-reaction-${"a".repeat(64)}`,
            root_session_id: "root-session",
            actor_public_id: input.actor_public_id,
            actor_kind: "human",
            operation: "add",
            target: locator,
            emoji: "👍",
            prior_interaction_head_digest: digestV1("FIXTURE\0v1\0", { prior: true }),
            created_at: "2026-08-25T00:00:00.000Z",
            operation_digest: digestV1("FIXTURE\0v1\0", { operation: true }),
          };
        },
        projection: (_conversationId, recipient) => projection(recipient),
      },
    },
    request(`unrelated=one; vf_conversation_session=${sessionA}; theme=dark`),
    "conversation",
    "event-1",
  );
  expect(response.status).toBe(200);
  const responseBody = await response.json();
  if (!responseBody || typeof responseBody !== "object") throw new Error("missing response body");
  const reactions = (responseBody as { reactions?: Array<{ reacted_by_recipient?: boolean }> })
    .reactions;
  expect(reactions?.[0]?.reacted_by_recipient).toBe(true);
  expect(JSON.stringify(responseBody)).not.toContain("session-a");

  const recipients: string[] = [];
  const timeline = {
    read: async (_root: string, input: { recipient_public_id?: string }) => {
      recipients.push(input.recipient_public_id ?? "");
      return { schema_version: "1.0", items: [] } as never;
    },
  };
  for (const cookie of [
    `theme=light; vf_conversation_session=${sessionA}; unrelated=two`,
    `vf_conversation_session=${sessionB}`,
  ])
    expect(
      (
        await handleConversationTimelineRoute(
          { sessions: { authorize: () => true }, timeline },
          new Request("http://127.0.0.1/api/conversation-sessions/root-session/timeline", {
            headers: { cookie, "x-vibeflow-token": "csrf" },
          }),
          new URL("http://127.0.0.1/api/conversation-sessions/root-session/timeline"),
          "root-session",
        )
      ).status,
    ).toBe(200);
  expect(recipients[0]).toBe(mutatedActor);
  expect(recipients[1]).not.toBe(mutatedActor);
});

test("reaction route rejects malformed and oversized bodies before mutation", async () => {
  let mutations = 0;
  const authority = {
    sessions: { authorize: () => true },
    csrf: () => true,
    rootSessionId: () => "root-session",
    interactions: {
      humanToggle: () => {
        mutations += 1;
        throw new Error("must not run");
      },
      projection: () => projectionNever(),
    },
  };
  const malformed = await handleConversationReactionRoute(
    authority,
    request(`vf_conversation_session=${sessionA}`, { mode: "toggle-self" }),
    "conversation",
    "event-1",
  );
  expect(malformed.status).toBe(400);
  const oversized = await handleConversationReactionRoute(
    authority,
    new Request("http://127.0.0.1/", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "70000" },
      body: "{}",
    }),
    "conversation",
    "event-1",
  );
  expect(oversized.status).toBe(400);
  expect(mutations).toBe(0);
});

function projectionNever(): ConversationInteractionProjectionV1 {
  throw new Error("projection must not run");
}
