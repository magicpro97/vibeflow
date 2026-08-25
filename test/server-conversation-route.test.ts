import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationRoutingError } from "../src/orchestrator/conversation/router.js";
import {
  ConversationControlConflictError,
  ConversationInvalidTargetParticipantError,
  ConversationNotFoundError,
} from "../src/orchestrator/conversation/service.js";
import { orchestrationApprovalToken } from "../src/orchestrator/conversation/services.js";
import type {
  ApprovalDecision,
  ConversationContext,
  ConversationService,
  OperationCancelCommand,
} from "../src/orchestrator/conversation/types.js";
import { DurableArtifactRegistry } from "../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../src/orchestrator/trace/store.js";
import { startServer } from "../src/server.js";
import { deriveBrowserActionAuthority } from "../src/server/conversation-action-principal.js";
import {
  ConversationSessionAuthority,
  ConversationStreamTokenAuthority,
} from "../src/server/conversation-auth.js";
import {
  type ConversationHttpAuthority,
  handleConversationRoute,
  isConversationNamespace,
} from "../src/server/conversation-route.js";

const startResult = {
  conversation_id: "conversation-a",
  revision_id: "revision-a",
  operation_id: "operation-a",
  completion: Promise.resolve({
    conversation_id: "conversation-a",
    revision_id: "revision-a",
    result: { operation_id: "operation-a", status: "completed" as const, artifact_refs: [] },
  }),
};

function service(overrides: Record<string, unknown> = {}): ConversationService {
  return {
    start: async () => startResult,
    message: async () => ({ message_id: "message-a", accepted: true as const }),
    pause: async () => ({ paused: true as const, lifecycle: "PAUSED" as const }),
    resume: async () => ({ resumed: true as const, active_state: "ACTIVE" as const }),
    stop: async () => ({ stopped: true as const, terminal_state: "STOPPED" as const }),
    snapshot: async () => ({
      conversation_id: "conversation-a",
      lifecycle: "ACTIVE" as const,
      health: "healthy" as const,
      policy: "direct",
      topic: "topic",
      participants: [],
      rounds: [],
      consensus_score: null,
      last_seq: 1,
    }),
    resolveApproval: async (_id: string, decision: ApprovalDecision) => ({
      status: 202 as const,
      body: { ...decision, resolved: true as const },
    }),
    cancelOperation: async (command: OperationCancelCommand) => ({
      status: 202 as const,
      body: { operation_id: command.operation_id, cancelled: true as const },
    }),
    ...overrides,
  } as unknown as ConversationService;
}

function authority(overrides: Partial<ConversationHttpAuthority> = {}): ConversationHttpAuthority {
  return {
    service: service(),
    sessions: {
      loopback: true,
      authorize: () => true,
      issueCookie: () => null,
    },
    streamTokens: {
      issue: () => ({
        stream_token: Buffer.alloc(32, 3).toString("base64url"),
        stream_token_expires_at: "2026-08-22T00:15:00.000Z",
      }),
      authorize: () => true,
    },
    csrf: () => true,
    ...overrides,
  } as ConversationHttpAuthority;
}

const request = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(`http://127.0.0.1${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const route = (auth: ConversationHttpAuthority, req: Request) =>
  handleConversationRoute(auth, req, new URL(req.url));

describe("conversation namespace", () => {
  test("owns only the exact conversation namespace", () => {
    expect(isConversationNamespace("/api/conversations")).toBe(true);
    expect(isConversationNamespace("/api/conversations/x")).toBe(true);
    expect(isConversationNamespace("/api/conversations-legacy")).toBe(false);
  });

  test("authenticates before parsing and keeps loopback CSRF separate from session auth", async () => {
    let starts = 0;
    const svc = service({
      start: async () => {
        starts += 1;
        return startResult;
      },
    });
    const denied = authority({
      service: svc,
      sessions: { loopback: true, authorize: () => false, issueCookie: () => null },
    } as never);
    expect(
      (await route(denied, request("POST", "/api/conversations", { topic: "x" }))).status,
    ).toBe(401);
    const csrfDenied = authority({ service: svc, csrf: () => false });
    expect(
      (await route(csrfDenied, request("POST", "/api/conversations", { topic: "x" }))).status,
    ).toBe(403);
    expect(starts).toBe(0);
  });

  test("LAN explicit session capability does not depend on the public HTML CSRF token", async () => {
    const lan = authority({
      sessions: { loopback: false, authorize: () => true, issueCookie: () => null },
      csrf: () => false,
    } as never);
    const response = await route(lan, request("POST", "/api/conversations", { topic: "x" }));
    expect(response.status).toBe(202);
  });

  test("startServer reuses one injected authority and its process-local session across restart", async () => {
    let sessionByte = 20;
    let starts = 0;
    let pauses = 0;
    const sessions = new ConversationSessionAuthority({
      loopback: true,
      randomBytes: () => Buffer.alloc(32, sessionByte++),
    });
    const streamTokens = new ConversationStreamTokenAuthority({
      randomBytes: () => Buffer.alloc(32, 30),
      now: () => Date.parse("2026-08-22T00:00:00.000Z"),
    });
    const shared = authority({
      sessions,
      streamTokens,
      service: service({
        start: async () => {
          starts += 1;
          return startResult;
        },
        pause: async () => {
          pauses += 1;
          return { paused: true, lifecycle: "PAUSED" };
        },
      }),
    });

    const first = await startServer(0, { conversation: shared });
    let sessionCookie: string;
    try {
      const page = await fetch(first.url);
      sessionCookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
      const html = await page.text();
      const csrf = html.match(/name="vf-token" content="([^"]+)"/)?.[1] ?? "";
      const created = await fetch(`${first.url}/api/conversations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
          "x-vibeflow-token": csrf,
        },
        body: JSON.stringify({ topic: "persist authority" }),
      });
      expect(created.status).toBe(202);
    } finally {
      await first.server.stop(true);
    }

    const second = await startServer(0, { conversation: shared });
    try {
      const page = await fetch(second.url);
      const html = await page.text();
      const csrf = html.match(/name="vf-token" content="([^"]+)"/)?.[1] ?? "";
      const paused = await fetch(`${second.url}/api/conversations/conversation-a/pause`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
          "x-vibeflow-token": csrf,
        },
        body: "{}",
      });
      expect(paused.status).toBe(202);
      expect(starts).toBe(1);
      expect(pauses).toBe(1);
    } finally {
      await second.server.stop(true);
    }
  });

  test("startServer preserves a valid loopback conversation cookie across HTML reloads", async () => {
    let sessionByte = 40;
    const sessions = new ConversationSessionAuthority({
      loopback: true,
      randomBytes: () => Buffer.alloc(32, sessionByte++),
    });
    const running = await startServer(0, { conversation: authority({ sessions }) });
    try {
      const first = await fetch(running.url);
      const firstCookie = first.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      expect(firstCookie).toMatch(/^vf_conversation_session=/);
      const firstActor = deriveBrowserActionAuthority(
        new Request(`${running.url}/`, { headers: { cookie: firstCookie } }),
        "conversation-a",
      ).actor.public_actor_id;

      const second = await fetch(running.url, { headers: { cookie: firstCookie } });
      expect(second.headers.get("set-cookie")).toBeNull();
      expect(
        deriveBrowserActionAuthority(
          new Request(`${running.url}/`, { headers: { cookie: firstCookie } }),
          "conversation-a",
        ).actor.public_actor_id,
      ).toBe(firstActor);

      const third = await fetch(running.url, {
        headers: { cookie: "vf_conversation_session=short" },
      });
      const replacement = third.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      expect(replacement).toMatch(/^vf_conversation_session=/);
      expect(
        sessions.authorize(new Request(`${running.url}/`, { headers: { cookie: replacement } })),
      ).toBe(true);
      expect(
        deriveBrowserActionAuthority(
          new Request(`${running.url}/`, { headers: { cookie: replacement } }),
          "conversation-a",
        ).actor.public_actor_id,
      ).not.toBe(firstActor);
    } finally {
      await running.server.stop(true);
    }
  });

  test("never serves HTML or mints a loopback session for a foreign request Host", async () => {
    const sessions = new ConversationSessionAuthority({
      loopback: true,
      randomBytes: () => Buffer.alloc(32, 50),
    });
    const running = await startServer(0, { conversation: authority({ sessions }) });
    try {
      const response = await fetch(running.url, { headers: { host: "attacker.example" } });
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("Forbidden");
    } finally {
      await running.server.stop(true);
    }
  });

  test("rejects a loopback session authority when the server is bound to LAN", async () => {
    const shared = authority({
      sessions: new ConversationSessionAuthority({ loopback: true }),
    });
    let running: Awaited<ReturnType<typeof startServer>> | undefined;
    let observed: unknown;
    try {
      running = await startServer(0, { host: "0.0.0.0", conversation: shared });
      observed = new Error("LAN accepted a loopback conversation authority");
    } catch (error) {
      observed = error;
    } finally {
      await running?.server.stop(true);
    }
    expect(observed).toBeInstanceOf(Error);
    expect((observed as Error).message).toContain("conversation authority host mismatch");
  });

  test("normalizes loopback host casing when validating the injected authority", async () => {
    const running = await startServer(0, {
      host: "LOCALHOST",
      conversation: authority({
        sessions: new ConversationSessionAuthority({ loopback: true }),
      }),
    });
    await running.server.stop(true);
  });

  test("startServer composes catalog, lineage, timeline, handoff, and deferred action routes", async () => {
    const calls: string[] = [];
    const proposalId = `vf-proposal-${"a".repeat(64)}`;
    const proposalDigest = `sha256:${"b".repeat(64)}`;
    const response = {
      schema_version: "1.0",
      proposal: { proposal_id: proposalId, proposal_digest: proposalDigest },
      approval: null,
      operation: { state: "pending_review" },
    };
    const browser = {
      catalog: { list: async () => ({ schema_version: "1.0", items: [], next_cursor: null }) },
      lineage: {
        read: async () => ({ schema_version: "1.0", nodes: [], next_cursor: null }),
        head: () => ({
          schema_version: "1.0",
          root_session_id: "conversation-a",
          head_status: "committed",
          head_epoch: 0,
          head_digest: `sha256:${"d".repeat(64)}`,
          active: {
            schema_version: "1.0",
            conversation_id: "conversation-a",
            revision_id: "revision-a",
            revision_ordinal: 0,
            lock_digest: `sha256:${"e".repeat(64)}`,
          },
        }),
      },
      timeline: {
        read: async () => ({ schema_version: "1.0", items: [], next_cursor: null }),
      },
      handoff: { read: async () => ({ schema_version: "1.0", handoff_id: "handoff-a" }) },
      rootSessionId: () => "conversation-a",
      actions: {
        async propose() {
          calls.push("propose");
          return { created: true, response };
        },
        async get() {
          return response;
        },
        async pending() {
          return [response];
        },
        async anchored() {
          return [response];
        },
        async events() {
          return [];
        },
        async challenge() {
          throw new Error("not used");
        },
        async approve() {
          throw new Error("not used");
        },
        async commit() {
          throw new Error("not used");
        },
        async cancel() {
          throw new Error("not used");
        },
      },
    };
    const running = await startServer(0, {
      conversation: authority({ browser: browser as never }),
    });
    const browserHeaders = {
      cookie: `vf_conversation_session=${Buffer.alloc(32, 5).toString("base64url")}`,
    };
    try {
      for (const path of [
        "/api/conversations",
        "/api/conversations/conversation-a/lineage",
        "/api/conversations/conversation-a/context-handoff",
        "/api/conversation-sessions/conversation-a/head",
        "/api/conversation-sessions/conversation-a/timeline",
        "/api/conversations/conversation-a/action-proposals?state=pending",
      ])
        expect((await fetch(`${running.url}${path}`, { headers: browserHeaders })).status).toBe(
          200,
        );
      const created = await fetch(
        `${running.url}/api/conversations/conversation-a/action-proposals`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...browserHeaders },
          body: JSON.stringify({
            schema_version: "1.0",
            idempotency_key: "http-deferred-settings",
            anchor_event_id: null,
            expected: {
              mode: "writable-revision",
              conversation_id: "conversation-a",
              revision_id: "revision-a",
              last_seq: 4,
              conversation_lock_digest: `sha256:${"c".repeat(64)}`,
            },
            candidate: {
              type: "conversation.update_settings",
              changes: { max_rounds: 3 },
            },
          }),
        },
      );
      expect(created.status).toBe(201);
      expect(((await created.json()) as { operation: { state: string } }).operation.state).toBe(
        "pending_review",
      );
      expect(calls).toEqual(["propose"]);
      expect(
        (
          await fetch(
            `${running.url}/api/conversations/conversation-a/action-proposals/${proposalId}`,
            { headers: browserHeaders },
          )
        ).status,
      ).toBe(200);
    } finally {
      await running.server.stop(true);
    }
  });
});

describe("conversation DTO and status mapping", () => {
  test("starts a valid bounded exact create request and returns only the frozen 202 DTO", async () => {
    let captured: unknown;
    const auth = authority({
      service: service({
        start: async (value: unknown) => {
          captured = value;
          return startResult;
        },
      }),
    });
    const response = await route(
      auth,
      request("POST", "/api/conversations", {
        topic: "Compare APIs",
        policy: "debate",
        participants: [
          { role_ref: "brainstorm-participant", engine: "codex", model: "gpt-5.4" },
          { role_ref: "brainstorm-skeptic", engine: "claude" },
        ],
        max_rounds: 3,
      }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe("/api/conversations/conversation-a");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      conversation_id: "conversation-a",
      stream_token: Buffer.alloc(32, 3).toString("base64url"),
      stream_token_expires_at: "2026-08-22T00:15:00.000Z",
    });
    expect(captured).toEqual({
      topic: "Compare APIs",
      policy: "debate",
      participants: [
        { role_ref: "brainstorm-participant", engine: "codex", model: "gpt-5.4" },
        { role_ref: "brainstorm-skeptic", engine: "claude" },
      ],
      max_rounds: 3,
    });
  });

  test("rejects unknown keys, empty fields, excess participants, and over-cap bodies as 400", async () => {
    const auth = authority();
    const invalid = [
      { topic: "x", extra: true },
      { topic: "   " },
      { topic: "x", participants: [] },
      {
        topic: "x",
        participants: Array.from({ length: 65 }, (_, index) => ({
          role_ref: `role-${index}`,
          engine: "codex",
        })),
      },
      { topic: "x", max_rounds: 0 },
    ];
    for (const body of invalid) {
      expect((await route(auth, request("POST", "/api/conversations", body))).status).toBe(400);
    }
    const huge = new Request("http://127.0.0.1/api/conversations", {
      method: "POST",
      body: JSON.stringify({ topic: "x".repeat(70 * 1024) }),
      headers: { "content-type": "application/json" },
    });
    expect((await route(auth, huge)).status).toBe(400);
    expect(
      (
        await route(
          auth,
          new Request("http://127.0.0.1/api/conversations", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: JSON.stringify({ topic: "not JSON media type" }),
          }),
        )
      ).status,
    ).toBe(400);
  });

  test("messages return 202 and preserve child revision Location without reopening the parent", async () => {
    let observedMessage: unknown;
    const quote = {
      root_session_id: "conversation-a",
      conversation_id: "conversation-a",
      revision_id: "revision-a",
      target_event_id: "event-a",
      target_kind: "completed-agent-response",
      content_digest: `sha256:${"a".repeat(64)}`,
      author_public_id: "participant-1",
    };
    const auth = authority({
      service: service({
        message: async (_id: string, input: unknown) => {
          observedMessage = structuredClone(input);
          return {
            message_id: "message-a",
            accepted: true,
            child_conversation_id: "conversation-child",
            location: "/api/conversations/conversation-child",
          };
        },
      }),
    });
    const response = await route(
      auth,
      request("POST", "/api/conversations/conversation-a/messages", {
        content: "revise this",
        target_participants: ["participant-1"],
        quote_refs: [quote],
      }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe("/api/conversations/conversation-child");
    expect(observedMessage).toEqual({
      content: "revise this",
      target_participants: ["participant-1"],
      quote_refs: [quote],
    });
    expect(await response.json()).toEqual({
      message_id: "message-a",
      accepted: true,
      child_conversation_id: "conversation-child",
      location: "/api/conversations/conversation-child",
    });
  });

  test("maps lifecycle conflict, unknown conversation, and unexpected errors to 409/404/500", async () => {
    const cases = [
      [
        new ConversationControlConflictError("message requires ACTIVE"),
        409,
        "conversation_conflict",
      ],
      [
        new ConversationControlConflictError("conversation state authority is changing"),
        409,
        "conversation_conflict",
      ],
      [new ConversationNotFoundError("conversation not found"), 404, "conversation_not_found"],
      [
        new ConversationInvalidTargetParticipantError("unknown target participant"),
        400,
        "invalid_request",
      ],
      [new ConversationRoutingError("unknown_explicit_policy"), 400, "invalid_request"],
      [new Error("conversation not found"), 500, "conversation_failed"],
      [new Error("unknown target participant"), 500, "conversation_failed"],
      [new Error("trace journal: invalid hash chain"), 500, "conversation_failed"],
      [new Error("/private/secret stack detail"), 500, "conversation_failed"],
    ] as const;
    for (const [error, status, code] of cases) {
      const response = await route(
        authority({ service: service({ pause: async () => Promise.reject(error) }) }),
        request("POST", "/api/conversations/conversation-a/pause", {}),
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(body).toEqual({ code });
      expect(JSON.stringify(body)).not.toContain("/private/secret");
    }
  });

  test("rejects route/body identity mismatch before approval or cancellation authority", async () => {
    let approvals = 0;
    let cancellations = 0;
    const auth = authority({
      service: service({
        resolveApproval: async () => {
          approvals += 1;
          throw new Error("must not resolve");
        },
        cancelOperation: async () => {
          cancellations += 1;
          throw new Error("must not cancel");
        },
      }),
    });
    const approval = await route(
      auth,
      request("POST", "/api/conversations/conversation-a/approvals/approval-a/resolve", {
        approval_id: "approval-b",
        operation_id: "operation-a",
        actor: "human",
        outcome: "approve",
        reason: null,
      }),
    );
    expect(approval.status).toBe(409);
    expect(await approval.json()).toEqual({ code: "approval_route_body_mismatch" });
    const operation = await route(
      auth,
      request("POST", "/api/conversations/conversation-a/operations/operation-a/cancel", {
        conversation_id: "conversation-a",
        operation_id: "operation-b",
        actor: "human",
        reason: null,
      }),
    );
    expect(operation.status).toBe(409);
    expect(await operation.json()).toEqual({ code: "operation_route_body_mismatch" });
    const conversation = await route(
      auth,
      request("POST", "/api/conversations/conversation-a/operations/operation-a/cancel", {
        conversation_id: "conversation-b",
        operation_id: "operation-a",
        actor: "human",
        reason: null,
      }),
    );
    expect(conversation.status).toBe(409);
    expect(await conversation.json()).toEqual({ code: "operation_conversation_mismatch" });
    expect(approvals).toBe(0);
    expect(cancellations).toBe(0);
  });

  test("resolves production approval tokens without widening other route identities", async () => {
    const token = orchestrationApprovalToken(
      {
        correlation: {
          workflow_id: "workflow-a",
          conversation_id: "conversation-a",
          revision_id: "revision-a",
          run_id: "run-a",
          turn_id: "turn-a",
          operation_id: "operation-a",
          attempt_id: "attempt-a",
        },
      } as ConversationContext,
      "human",
    );
    let resolved: ApprovalDecision | undefined;
    let cancellations = 0;
    const auth = authority({
      service: service({
        resolveApproval: async (_conversationId: string, decision: ApprovalDecision) => {
          resolved = decision;
          return { status: 202, body: { ...decision, resolved: true } };
        },
        cancelOperation: async (command: OperationCancelCommand) => {
          cancellations += 1;
          return {
            status: 202,
            body: { operation_id: command.operation_id, cancelled: true },
          };
        },
      }),
    });
    const decision = { ...token, outcome: "approve" as const, reason: null };
    const approved = await route(
      auth,
      request(
        "POST",
        `/api/conversations/conversation-a/approvals/${encodeURIComponent(token.approval_id)}/resolve`,
        decision,
      ),
    );
    expect(approved.status).toBe(202);
    expect(await approved.json()).toEqual({ ...decision, resolved: true });
    expect(resolved).toEqual(decision);

    const malformedApprovalId = "approval:not-a-sha256";
    const malformedApproval = await route(
      auth,
      request(
        "POST",
        `/api/conversations/conversation-a/approvals/${encodeURIComponent(malformedApprovalId)}/resolve`,
        { ...decision, approval_id: malformedApprovalId },
      ),
    );
    expect(malformedApproval.status).toBe(404);
    expect(
      (
        await route(
          auth,
          request("GET", `/api/conversations/${encodeURIComponent("conversation:a")}/snapshot`),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await route(
          auth,
          request(
            "POST",
            `/api/conversations/conversation-a/operations/${encodeURIComponent("operation:a")}/cancel`,
            {
              conversation_id: "conversation-a",
              operation_id: "operation:a",
              actor: "human",
              reason: null,
            },
          ),
        )
      ).status,
    ).toBe(404);
    expect(resolved).toEqual(decision);
    expect(cancellations).toBe(0);
  });

  test("passes typed approval and cancellation service results through exactly", async () => {
    const auth = authority({
      service: service({
        resolveApproval: async () => ({
          status: 409,
          body: { code: "approval_operation_mismatch" },
        }),
        cancelOperation: async () => ({ status: 404, body: { code: "operation_not_found" } }),
      }),
    });
    const approval = await route(
      auth,
      request("POST", "/api/conversations/conversation-a/approvals/approval-a/resolve", {
        approval_id: "approval-a",
        operation_id: "operation-a",
        actor: "human",
        outcome: "approve",
        reason: null,
      }),
    );
    expect(approval.status).toBe(409);
    expect(await approval.json()).toEqual({ code: "approval_operation_mismatch" });
    const cancel = await route(
      auth,
      request("POST", "/api/conversations/conversation-a/operations/operation-a/cancel", {
        conversation_id: "conversation-a",
        operation_id: "operation-a",
        actor: "human",
        reason: null,
      }),
    );
    expect(cancel.status).toBe(404);
    expect(await cancel.json()).toEqual({ code: "operation_not_found" });
  });

  test("requires explicit nullable reason keys in approval and cancellation DTOs", async () => {
    const auth = authority();
    const approval = await route(
      auth,
      request("POST", "/api/conversations/conversation-a/approvals/approval-a/resolve", {
        approval_id: "approval-a",
        operation_id: "operation-a",
        actor: "human",
        outcome: "approve",
      }),
    );
    expect(approval.status).toBe(400);
    const cancel = await route(
      auth,
      request("POST", "/api/conversations/conversation-a/operations/operation-a/cancel", {
        conversation_id: "conversation-a",
        operation_id: "operation-a",
        actor: "human",
      }),
    );
    expect(cancel.status).toBe(400);
  });

  test("serves authenticated snapshots, renews tokens, and maps unknown route/method", async () => {
    const auth = authority();
    expect(
      (await route(auth, request("GET", "/api/conversations/conversation-a/snapshot"))).status,
    ).toBe(200);
    expect(
      (await route(auth, request("POST", "/api/conversations/conversation-a/stream-token", {})))
        .status,
    ).toBe(202);
    expect(
      (await route(auth, request("DELETE", "/api/conversations/conversation-a/snapshot"))).status,
    ).toBe(404);
    expect((await route(auth, request("GET", "/api/conversations/%ZZ/snapshot"))).status).toBe(400);
  });

  test("refreshes the durable registry before the first artifact read after process restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-http-artifact-restart-"));
    try {
      const registryDir = join(root, "registry");
      const traceDir = join(root, "trace");
      const firstRegistry = new DurableArtifactRegistry({ dir: registryDir });
      const trace = new TraceStore({ dir: traceDir, artifactRegistry: firstRegistry });
      const internalRef = `vf-artifact-${"a".repeat(64)}`;
      await trace.append(
        {
          workflow_id: "workflow-a",
          conversation_id: "conversation-a",
          revision_id: "revision-a",
          run_id: "run-a",
          turn_id: "turn-a",
          operation_id: "operation-a",
          attempt_id: "attempt-a",
        },
        {
          idempotency_key: "artifact:create",
          event: {
            type: "artifact_created",
            payload: { artifact_id: "plan-a", artifact_type: "plan", ref: internalRef },
          },
        },
      );
      const opaqueId = firstRegistry.register("conversation-a", internalRef);
      const restartedRegistry = new DurableArtifactRegistry({ dir: registryDir });
      const reopenedTrace = new TraceStore({
        dir: traceDir,
        artifactRegistry: restartedRegistry,
      });
      expect(restartedRegistry.resolve("conversation-a", opaqueId)).toBeNull();
      let reads = 0;
      const auth = authority({
        service: service({
          snapshot: async () => {
            await reopenedTrace.readConversation("conversation-a");
            return {
              conversation_id: "conversation-a",
              lifecycle: "COMPLETED",
              health: "healthy",
              policy: "plan",
              topic: "persisted topic",
              participants: [],
              rounds: [],
              consensus_score: null,
              last_seq: 1,
            };
          },
        }),
        artifacts: {
          ancestry: {
            resolve(conversationId, artifactId) {
              const resolution = restartedRegistry.resolve(conversationId, artifactId);
              return resolution
                ? {
                    owner_conversation_id: conversationId,
                    internal_ref: resolution.internalRef,
                    reference: {
                      artifact_id: artifactId,
                      artifact_kind: "conversation-artifact" as const,
                      media_type: "application/octet-stream",
                      byte_length: Buffer.byteLength("durable artifact"),
                      content_sha256: createHash("sha256").update("durable artifact").digest("hex"),
                      resolver: "conversation-artifact-v1" as const,
                    },
                  }
                : null;
            },
          },
          store: {
            readArtifactRef(conversationId, observedRef) {
              reads += 1;
              expect(conversationId).toBe("conversation-a");
              expect(observedRef).toBe(internalRef);
              return new TextEncoder().encode("durable artifact");
            },
          },
        },
      });
      const response = await route(
        auth,
        request(
          "GET",
          `/api/conversations/conversation-a/artifacts/${opaqueId}?expected_sha256=${createHash("sha256").update("durable artifact").digest("hex")}`,
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("durable artifact");
      expect(reads).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
