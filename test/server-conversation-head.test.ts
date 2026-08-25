import { expect, test } from "bun:test";
import {
  type ConversationHeadResponseV1,
  ConversationLineageNotFoundError,
} from "../src/orchestrator/conversation/lineage-service.js";
import { LineageAuthorityCorruptError } from "../src/orchestrator/conversation/lineage-store.js";
import { handleConversationHeadRoute } from "../src/server/conversation-head-route.js";

const requestFor = (method = "GET") =>
  new Request("http://localhost/api/conversation-sessions/root/head", { method });

const body: ConversationHeadResponseV1 = {
  schema_version: "1.0",
  root_session_id: "root",
  head_status: "committed",
  head_epoch: 3,
  head_digest: `sha256:${"a".repeat(64)}`,
  active: {
    schema_version: "1.0",
    conversation_id: "child",
    revision_id: "revision-child",
    revision_ordinal: 1,
    parent_conversation_id: "root",
    parent_revision_id: "revision-root",
    lineage_status: "verified",
    topic: "Authoritative child",
    policy: "direct",
    lifecycle: "ACTIVE",
    health: "healthy",
    participants: [],
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:01.000Z",
    last_seq: 7,
    lock_digest: `sha256:${"b".repeat(64)}`,
  },
};

test("head route authenticates before authority access and rejects writes", async () => {
  let calls = 0;
  const authority = {
    sessions: { authorize: () => false },
    lineage: {
      head: () => {
        calls += 1;
        return body;
      },
    },
  };
  const denied = await handleConversationHeadRoute(authority, requestFor(), "root");
  expect(denied.status).toBe(401);
  expect(calls).toBe(0);

  authority.sessions.authorize = () => true;
  const write = await handleConversationHeadRoute(authority, requestFor("POST"), "root");
  expect(write.status).toBe(404);
  expect(calls).toBe(0);
});

test("head route returns the exact no-store lock-bearing authority for the named root", async () => {
  const roots: string[] = [];
  const response = await handleConversationHeadRoute(
    {
      sessions: { authorize: () => true },
      lineage: {
        head(rootSessionId) {
          roots.push(rootSessionId);
          return body;
        },
      },
    },
    requestFor(),
    "root",
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(roots).toEqual(["root"]);
  expect(await response.json()).toEqual(body);
});

test("head route preserves not-found and corrupt-authority failures", async () => {
  const run = async (error: Error) =>
    handleConversationHeadRoute(
      {
        sessions: { authorize: () => true },
        lineage: {
          head: () => {
            throw error;
          },
        },
      },
      requestFor(),
      "root",
    );
  const missing = await run(new ConversationLineageNotFoundError());
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
  const corrupt = await run(new LineageAuthorityCorruptError("bad head"));
  expect(corrupt.status).toBe(423);
  expect(await corrupt.json()).toMatchObject({
    error: { code: "authority_corrupt", recovery_action: "repair-authority" },
  });
});
