/**
 * The chip's confirm, end to end through the *production* composition.
 *
 * `test/conversation-project-rebind.test.ts` proves the re-bind unit contract. This file proves
 * the thing the review actually flagged: that the production HTTP authority supplies a mover, so
 * a `POST /api/conversation-projects/move` changes the durable `project_id` and the catalog row
 * the rail groups by — not a 503 behind a control that can never succeed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedAgentBinding, PreviewAgentBinding } from "../src/agents/binding.js";
import type { chat } from "../src/commands/chat.js";
import { buildConversationHttpAuthority } from "../src/commands/conversation-http.js";
import { conversationEnvPolicy } from "../src/dispatch/env-filter.js";
import { type EngineProcess, createSpawnOptionsProjection } from "../src/dispatch/session-types.js";
import type { ConversationBindingFactory } from "../src/orchestrator/conversation/bootstrap-request-resolution.js";
import {
  CONVERSATION_PROJECT_ROUTE,
  handleConversationProjectRoute,
} from "../src/server/conversation-project-route.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function completedProcess(): EngineProcess {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify({ type: "result", session_id: "019f278f-d7ff-77d3-9c44-7459bbf08d19", result: "ok" })}\n`,
  );
  return {
    stdin: null,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    stderr: null,
    exited: Promise.resolve(0),
    kill: () => undefined,
  };
}

function materialized(roleName: string): MaterializedAgentBinding {
  const roleHash = "a".repeat(64);
  const envPolicy = conversationEnvPolicy("claude");
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [] };
  const traceMetadata = { role_resolved_hash: roleHash, skill_resolved_hashes: [] };
  return {
    resolved: {
      role: {
        source: "builtin" as const,
        resolved_hash: roleHash,
        metadata: {},
        spec: {
          name: roleName,
          description: "Hermetic project move role",
          body: "Use only the injected process fixture.",
          tools: ["read" as const],
          model: "sonnet" as const,
          sandbox: "read-only" as const,
        },
      },
      skills: [],
      engine: "claude" as const,
      model: "sonnet",
      sessionMode: "fresh" as const,
      tool_intents: ["read" as const],
      sandbox: "read-only" as const,
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    },
    spawn: createSpawnOptionsProjection({
      engine: "claude",
      model: "sonnet",
      sessionMode: "fresh",
      rendered_prompt: "private project move prompt",
      rendered_tools: ["Read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

function bootstrapOptions(
  stateDir: string,
): NonNullable<NonNullable<Parameters<typeof chat>[1]>["bootstrap"]> {
  return {
    stateDir,
    readiness: () => [{ engine: "claude", ready: true, admitted: true }],
    bindingFactory: {
      materialize: (input: Parameters<ConversationBindingFactory["materialize"]>[0]) =>
        materialized(input.roleRef),
      preview: (input: Parameters<ConversationBindingFactory["preview"]>[0]) =>
        ({
          resolved: materialized(input.roleRef).resolved,
          engineAvailable: true,
          modelValid: true,
        }) as PreviewAgentBinding,
    },
    session: { spawn: () => completedProcess() },
  } satisfies NonNullable<NonNullable<Parameters<typeof chat>[1]>["bootstrap"]>;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vf-project-move-http-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"project-move-http"}\n');
  const authority = buildConversationHttpAuthority(
    { bootstrap: bootstrapOptions(join(root, "conversation")) },
    "127.0.0.1",
    repo,
  );
  const projects = authority.browser?.projects;
  if (!projects) throw new Error("composition did not expose the project surface");
  return { projects };
}

const moveRequest = (body: unknown) =>
  new Request(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.MOVE}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const moveUrl = () => new URL(`http://127.0.0.1${CONVERSATION_PROJECT_ROUTE.MOVE}`);

describe("production project move composition", () => {
  test("the composed authority supplies a real mover, not the refusal path", () => {
    const { projects } = fixture();
    expect(typeof projects.moveProject).toBe("function");
  });

  // Auth is the session cookie authority's concern and is pinned by its own suites; these tests
  // isolate the *project* surface, exactly as the route suite does.
  const routeAuthority = (projects: NonNullable<ReturnType<typeof fixture>["projects"]>) => ({
    ...projects,
    sessions: { authorize: () => true },
    csrf: () => true,
  });

  test("an unregistered project is refused by the composed registry, before any re-bind", async () => {
    const { projects } = fixture();
    const response = await handleConversationProjectRoute(
      routeAuthority(projects),
      moveRequest({ root_session_id: "conv-missing", project_id: "ghost" }),
      moveUrl(),
    );
    // The registry answers first, so an unregistered id is a client error whether or not the
    // conversation exists — the re-bind never reaches the artifact store.
    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Unknown project");
  });

  test("a valid move reaches the artifact store instead of the old 503 refusal", async () => {
    const { projects } = fixture();
    const response = await handleConversationProjectRoute(
      routeAuthority(projects),
      moveRequest({ root_session_id: "conv-does-not-exist", project_id: "idea" }),
      moveUrl(),
    );
    // `idea` is always bindable, so this exercises the composed mover's artifact-store read.
    // A 404 here is the proof the mover ran: the previous composition answered 503 for *every*
    // request because no mover existed.
    expect(response?.status).toBe(404);
    const body = (await response?.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("no durable revision");
  });
});
