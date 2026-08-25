import { expect, test } from "bun:test";
import { StaleTimelineCursorError } from "../src/orchestrator/conversation/catalog-timeline-cursor.js";
import { TimelineHeadUnresolvedError } from "../src/orchestrator/conversation/timeline-service.js";
import { handleConversationTimelineRoute } from "../src/server/conversation-timeline-route.js";

const HEAD = { conversation_id: "child", revision_id: "revision-child", revision_ordinal: 1 };
const requestFor = (query = "") =>
  new Request(`http://localhost/api/conversation-sessions/root/timeline${query}`);

test("timeline route authenticates before parsing and returns successful no-store DTOs", async () => {
  let calls = 0;
  const deniedRequest = requestFor("?limit=bad");
  const denied = await handleConversationTimelineRoute(
    {
      sessions: { authorize: () => false },
      timeline: {
        read: async () => {
          calls += 1;
          throw new Error("timeline must not be called");
        },
      },
    } as any,
    deniedRequest,
    new URL(deniedRequest.url),
    "root",
  );
  expect(denied.status).toBe(401);
  expect(calls).toBe(0);

  const body = {
    schema_version: "1.0",
    root_session_id: "root",
    head: HEAD,
    head_epoch: 1,
    head_digest: `sha256:${"a".repeat(64)}`,
    items: [],
    next_cursor: null,
  } as const;
  const successRequest = requestFor("?limit=20");
  const success = await handleConversationTimelineRoute(
    {
      sessions: { authorize: () => true },
      timeline: { read: async () => body as any },
    } as any,
    successRequest,
    new URL(successRequest.url),
    "root",
  );
  expect(success.status).toBe(200);
  expect(success.headers.get("cache-control")).toBe("no-store");
  expect(await success.json()).toEqual(body);
});

test("timeline route exposes exact stale and unresolved head recovery", async () => {
  const run = async (error: Error) => {
    const request = requestFor();
    return handleConversationTimelineRoute(
      {
        sessions: { authorize: () => true },
        timeline: { read: async () => Promise.reject(error) },
      } as any,
      request,
      new URL(request.url),
      "root",
    );
  };
  const stale = await run(
    new StaleTimelineCursorError("restart", HEAD, `sha256:${"b".repeat(64)}`, 3),
  );
  expect(stale.status).toBe(409);
  expect(stale.headers.get("cache-control")).toBe("no-store");
  expect((await stale.json()) as any).toMatchObject({
    error: {
      code: "stale_timeline_cursor",
      recovery_action: "restart-pagination",
      details: {
        restart_cursor: "restart",
        head: HEAD,
        head_digest: `sha256:${"b".repeat(64)}`,
        head_epoch: 3,
      },
    },
  });
  const unresolved = await run(
    new TimelineHeadUnresolvedError("root", "unclaimed", [HEAD], `sha256:${"c".repeat(64)}`, 0),
  );
  expect(unresolved.status).toBe(409);
  expect((await unresolved.json()) as any).toMatchObject({
    error: {
      code: "lineage_head_unresolved",
      recovery_action: "select-lineage-head",
      details: {
        root_session_id: "root",
        head_status: "unclaimed",
        candidate_heads: [HEAD],
        head_digest: `sha256:${"c".repeat(64)}`,
        head_epoch: 0,
      },
    },
  });
});
