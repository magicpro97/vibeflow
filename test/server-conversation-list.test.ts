import { expect, test } from "bun:test";
import { StaleCatalogCursorError } from "../src/orchestrator/conversation/catalog-cursor.js";
import { CatalogDegradedError } from "../src/orchestrator/conversation/catalog-service.js";
import { handleConversationListRoute } from "../src/server/conversation-list-route.js";

test("conversation list authenticates before parsing and never calls the catalog on failure", async () => {
  let calls = 0;
  const request = new Request("http://localhost/api/conversations?limit=bad&limit=2");
  const response = await handleConversationListRoute(
    {
      sessions: { authorize: () => false },
      catalog: {
        list: async () => {
          calls += 1;
          throw new Error("catalog must not be called");
        },
      },
    } as any,
    request,
    new URL(request.url),
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()) as any).toMatchObject({
    schema_version: "1.0",
    error: { code: "unauthenticated", recovery_action: null },
  });
  expect(calls).toBe(0);
});

test("conversation list forwards one normalized bounded query and returns no-store", async () => {
  let received: unknown;
  const body = {
    schema_version: "1.0",
    items: [],
    next_cursor: null,
    catalog_generation: `vf-catalog-generation-${"a".repeat(64)}`,
    source_watermark: `sha256:${"b".repeat(64)}`,
    catalog_health: "ready",
  } as const;
  const request = new Request(
    "http://localhost/api/conversations?q=hello&lifecycle=ACTIVE%2CPAUSED&policy=direct&limit=20",
  );
  const response = await handleConversationListRoute(
    {
      sessions: { authorize: () => true },
      catalog: {
        async list(input: unknown) {
          received = input;
          return body as any;
        },
      },
    } as any,
    request,
    new URL(request.url),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(received).toEqual({
    query: "hello",
    lifecycle: ["ACTIVE", "PAUSED"],
    policy: ["direct"],
    limit: 20,
  });
  expect(await response.json()).toEqual(body);
});

test("conversation list exposes exact stale and degraded recovery contracts", async () => {
  const run = async (error: Error) => {
    const request = new Request("http://localhost/api/conversations");
    return handleConversationListRoute(
      {
        sessions: { authorize: () => true },
        catalog: { list: async () => Promise.reject(error) },
      } as any,
      request,
      new URL(request.url),
    );
  };
  const stale = await run(
    new StaleCatalogCursorError("restart", `vf-catalog-generation-${"c".repeat(64)}`),
  );
  expect(stale.status).toBe(409);
  expect((await stale.json()) as any).toMatchObject({
    error: {
      code: "stale_catalog_cursor",
      recovery_action: "restart-pagination",
      details: {
        restart_cursor: "restart",
        catalog_generation: `vf-catalog-generation-${"c".repeat(64)}`,
      },
    },
  });
  const degraded = await run(new CatalogDegradedError(true));
  expect(degraded.status).toBe(503);
  expect((await degraded.json()) as any).toMatchObject({
    error: {
      code: "catalog_degraded",
      recovery_action: "resume-by-id",
      details: { recoverable_by_id: true },
    },
  });
});
