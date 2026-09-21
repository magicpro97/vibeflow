/**
 * The conversation-project route's observable contract: what the rail can read, what a PATCH
 * persists, and — important — what the route does when the runtime cannot do the thing.
 *
 * The move case is the one that matters most. A durable conversation→project re-bind does not
 * exist in the runtime, so the route must answer with a refusal rather than a success-shaped
 * response; "the rail moved it" and "the server says it moved it" are different claims, and only
 * the second is reachable without a write path.
 */
import { expect, test } from "bun:test";
import type { ProjectV1 } from "../src/orchestrator/conversation/project-types.js";
import {
  CONVERSATION_PROJECT_ROUTE,
  type ConversationProjectRouteAuthorityV1,
  handleConversationProjectRoute,
} from "../src/server/conversation-project-route.js";

const PROJECT: ProjectV1 = {
  id: "alpha",
  name: "alpha-service",
  goal: "Ship the alpha",
  context: "",
  repos: ["/work/alpha"],
  engine: { cli: "codex", model: "gpt-5", thinking: "high" },
  created_at: "2026-09-01T00:00:00.000Z",
};

function authority(
  overrides: Partial<ConversationProjectRouteAuthorityV1> = {},
): ConversationProjectRouteAuthorityV1 {
  return {
    sessions: { authorize: () => true },
    csrf: () => true,
    listProjects: () => [PROJECT],
    ...overrides,
  };
}

const request = (method: string, body?: unknown) =>
  new Request("http://127.0.0.1/x", {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

test("the registry read returns only the rail's fields and is never cached", async () => {
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.LIST}`);
  const response = await handleConversationProjectRoute(authority(), request("GET"), url);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(await response?.json()).toEqual({
    schema_version: "1.0",
    projects: [
      { id: "alpha", name: "alpha-service", goal: "Ship the alpha", engine: PROJECT.engine },
    ],
  });
});

test("an unreadable registry degrades to no projects rather than failing the rail", async () => {
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.LIST}`);
  const response = await handleConversationProjectRoute(
    authority({
      listProjects: () => {
        throw new Error("registry corrupt");
      },
    }),
    request("GET"),
    url,
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ schema_version: "1.0", projects: [] });
});

test("the registry read requires an authorized session", async () => {
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.LIST}`);
  const response = await handleConversationProjectRoute(
    authority({ sessions: { authorize: () => false } }),
    request("GET"),
    url,
  );
  expect(response?.status).toBe(401);
});

test("a PATCH persists the engine override and echoes the stored shape", async () => {
  const updates: Array<{ project_id: string; engine: ProjectV1["engine"] }> = [];
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.ITEM_PREFIX}alpha`);
  const response = await handleConversationProjectRoute(
    authority({ updateProject: (input) => updates.push(input) }),
    request("PATCH", { engine: { cli: "claude", model: null, thinking: "low" } }),
    url,
  );
  expect(response?.status).toBe(200);
  expect(updates).toEqual([
    { project_id: "alpha", engine: { cli: "claude", model: null, thinking: "low" } },
  ]);
  expect(await response?.json()).toEqual({
    schema_version: "1.0",
    project_id: "alpha",
    engine: { cli: "claude", model: null, thinking: "low" },
  });
});

test("an unknown engine or a malformed id is a client error, not a silent no-op", async () => {
  const updates: unknown[] = [];
  const bad = await handleConversationProjectRoute(
    authority({ updateProject: (input) => updates.push(input) }),
    request("PATCH", { engine: { cli: "not-an-engine", model: null, thinking: "low" } }),
    new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.ITEM_PREFIX}alpha`),
  );
  expect(bad?.status).toBe(400);
  const unrouted = await handleConversationProjectRoute(
    authority({ updateProject: (input) => updates.push(input) }),
    request("PATCH", { engine: { cli: "claude", model: null, thinking: "low" } }),
    new URL("http://127.0.0.1/api/conversation-projects/not/a/slug"),
  );
  expect(unrouted).toBeNull();
  expect(updates).toEqual([]);
});

test("a PATCH without an updater reports that it cannot persist, not success", async () => {
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.ITEM_PREFIX}alpha`);
  const response = await handleConversationProjectRoute(
    authority(),
    request("PATCH", { engine: { cli: "claude", model: null, thinking: "low" } }),
    url,
  );
  expect(response?.status).toBe(503);
});

test("a move without a durable re-bind is refused rather than reported as done", async () => {
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.MOVE}`);
  const response = await handleConversationProjectRoute(
    authority(),
    request("POST", { root_session_id: "root-1", project_id: "alpha" }),
    url,
  );
  // The runtime has no re-bind yet; the contract is that the chip is told so, verbatim.
  expect(response?.status).toBe(503);
  const body = (await response?.json()) as { error: { message: string } };
  expect(body.error.message).toContain("cannot re-bind");
});

test("a move with a durable re-bind forwards exactly the session and project", async () => {
  const moves: Array<{ root_session_id: string; project_id: string }> = [];
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.MOVE}`);
  const response = await handleConversationProjectRoute(
    authority({
      moveProject: (input) => {
        moves.push(input);
      },
    }),
    request("POST", { root_session_id: "root-1", project_id: "alpha" }),
    url,
  );
  expect(response?.status).toBe(202);
  expect(moves).toEqual([{ root_session_id: "root-1", project_id: "alpha" }]);
});

test("a move naming a non-slug project is rejected before the mover runs", async () => {
  const moves: unknown[] = [];
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.MOVE}`);
  const response = await handleConversationProjectRoute(
    authority({
      moveProject: (input) => {
        moves.push(input);
      },
    }),
    request("POST", { root_session_id: "root-1", project_id: "../escape" }),
    url,
  );
  expect(response?.status).toBe(400);
  expect(moves).toEqual([]);
});

test("classification is forwarded to the server's ladder and returned verbatim", async () => {
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.CLASSIFY}`);
  const response = await handleConversationProjectRoute(
    authority({
      classify: async () => ({ project_id: "alpha", confidence: 0.31, reason: "fts" }),
    }),
    request("POST", { message: "ship the alpha" }),
    url,
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    schema_version: "1.0",
    project_id: "alpha",
    confidence: 0.31,
    reason: "fts",
  });
});

test("an empty message and a missing classifier are both reported, never guessed", async () => {
  const url = new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.CLASSIFY}`);
  const empty = await handleConversationProjectRoute(
    authority({
      classify: async () => ({ project_id: "idea", confidence: 0, reason: "fallback" }),
    }),
    request("POST", { message: "   " }),
    url,
  );
  expect(empty?.status).toBe(400);
  const unavailable = await handleConversationProjectRoute(
    authority(),
    request("POST", { message: "ship the alpha" }),
    url,
  );
  expect(unavailable?.status).toBe(503);
});

test("an unrelated path is left for the rest of the conversation router", async () => {
  expect(
    await handleConversationProjectRoute(
      authority(),
      request("GET"),
      new URL("http://127.0.0.1/api/conversations"),
    ),
  ).toBeNull();
});
