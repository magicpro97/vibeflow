import { expect, test } from "bun:test";
import { FutureLineageCursorError } from "../src/orchestrator/conversation/catalog-cursor.js";
import { StaleLineageCursorError } from "../src/orchestrator/conversation/lineage-service.js";
import { handleConversationLineageRoute } from "../src/server/conversation-lineage-route.js";

const requestFor = (query = "") =>
  new Request(`http://localhost/api/conversations/root/lineage${query}`);

test("lineage route authenticates before query parsing and returns nested no-store errors", async () => {
  let calls = 0;
  const request = requestFor("?limit=1&limit=2");
  const response = await handleConversationLineageRoute(
    {
      sessions: { authorize: () => false },
      lineage: {
        read: () => {
          calls += 1;
          throw new Error("lineage must not be called");
        },
      },
    } as any,
    request,
    new URL(request.url),
    "root",
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()) as any).toMatchObject({ error: { code: "unauthenticated" } });
  expect(calls).toBe(0);
});

test("lineage route returns a service DTO and exact cursor conflicts", async () => {
  const successBody = { schema_version: "1.0", nodes: [], next_cursor: null };
  const successRequest = requestFor("?cursor=opaque&limit=10");
  let received: unknown;
  const success = await handleConversationLineageRoute(
    {
      sessions: { authorize: () => true },
      lineage: {
        read(_id: string, input: { cursor?: string; limit?: number }) {
          received = input;
          return successBody as any;
        },
      },
    } as any,
    successRequest,
    new URL(successRequest.url),
    "root",
  );
  expect(success.status).toBe(200);
  expect(success.headers.get("cache-control")).toBe("no-store");
  expect(received).toEqual({ cursor: "opaque", limit: 10 });

  const run = async (error: Error) => {
    const request = requestFor();
    return handleConversationLineageRoute(
      {
        sessions: { authorize: () => true },
        lineage: {
          read: () => {
            throw error;
          },
        },
      } as any,
      request,
      new URL(request.url),
      "root",
    );
  };
  const stale = await run(new StaleLineageCursorError("restart", `sha256:${"a".repeat(64)}`, 2));
  expect(stale.status).toBe(409);
  expect((await stale.json()) as any).toMatchObject({
    error: {
      code: "stale_lineage_cursor",
      details: {
        restart_cursor: "restart",
        head_digest: `sha256:${"a".repeat(64)}`,
        head_epoch: 2,
      },
    },
  });
  const future = await run(new FutureLineageCursorError(3, 42));
  expect(future.status).toBe(409);
  expect((await future.json()) as any).toMatchObject({
    error: { code: "future_event_cursor", details: { current_last_seq: 42 } },
  });
});
