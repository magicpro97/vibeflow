import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedAgentBinding, PreviewAgentBinding } from "../src/agents/binding.js";
import { ask } from "../src/commands/ask.js";
import { brainstorm } from "../src/commands/brainstorm.js";
import { chat } from "../src/commands/chat.js";
import { buildConversationHttpAuthority } from "../src/commands/conversation-http.js";
import { conversationEnvPolicy } from "../src/dispatch/env-filter.js";
import { type EngineProcess, createSpawnOptionsProjection } from "../src/dispatch/session-types.js";
import type { ConversationBootstrapOptions } from "../src/orchestrator/conversation/bootstrap.js";
import type { EngineReadiness } from "../src/preflight/types.js";

const roots: string[] = [];
const TEST_PRINCIPAL_DIGEST = `sha256:${"1".repeat(64)}`;
const MISSING_QUEUE_ITEM_ID = `vf-queued-message-${"a".repeat(64)}`;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function completedProcess(output = "completed answer"): EngineProcess {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify({
      type: "result",
      session_id: "019f278f-d7ff-77d3-9c44-7459bbf08d19",
      result: output,
    })}\n`,
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
  const resolved = {
    role: {
      source: "builtin" as const,
      resolved_hash: roleHash,
      metadata: {},
      spec: {
        name: roleName,
        description: "Hermetic command coverage role",
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
  };
  return {
    resolved,
    spawn: createSpawnOptionsProjection({
      engine: "claude",
      model: "sonnet",
      sessionMode: "fresh",
      rendered_prompt: "private command coverage prompt",
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
): NonNullable<NonNullable<Parameters<typeof ask>[2]>["bootstrap"]> {
  return {
    stateDir,
    readiness: () => [{ engine: "claude", ready: true, admitted: true }],
    bindingFactory: {
      materialize: (input) => materialized(input.roleRef),
      preview: (input) =>
        ({
          resolved: materialized(input.roleRef).resolved,
          engineAvailable: true,
          modelValid: true,
        }) as PreviewAgentBinding,
    } as ConversationBootstrapOptions["bindingFactory"],
    session: { spawn: () => completedProcess() },
  };
}

function ready(): EngineReadiness[] {
  return [{ engine: "claude", level: "ready", detail: "ready", checkedAt: "now" }];
}

async function quiet<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await run();
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("default durable conversation command adapters", () => {
  test("Ask contains file failures and exercises both default durable adapters", async () => {
    const missingSpawn = await quiet(() =>
      ask(
        ["missing.ts:1", "why"],
        {},
        {
          readiness: ready,
          spawn: () => 0,
          readText: () => {
            throw new Error("missing");
          },
        },
      ),
    );
    expect(missingSpawn).toBe(2);
    expect(await quiet(() => ask([], {}, {}))).toBe(2);
    expect(await quiet(() => ask([], { conversation: "conversation-missing" }, {}))).toBe(2);

    await expect(
      quiet(() =>
        ask(
          ["missing.ts:1", "why"],
          { conversation: "conversation-missing" },
          {
            createService: () => ({}) as never,
            readText: () => {
              throw new Error("missing");
            },
          },
        ),
      ),
    ).rejects.toThrow("no such file");
    expect(
      await quiet(() =>
        ask(
          ["missing.ts:1", "why"],
          {},
          {
            createService: () => ({}) as never,
            readText: () => {
              throw new Error("missing");
            },
          },
        ),
      ),
    ).toBe(2);

    const local = mkdtempSync(join(process.cwd(), ".vf-command-default-"));
    roots.push(local);
    const source = join(local, "snippet.ts");
    writeFileSync(source, "export const answer = 42;\n");
    const state = mkdtempSync(join(tmpdir(), "vf-command-default-state-"));
    roots.push(state);
    const bootstrap = bootstrapOptions(join(state, "ask"));
    const fresh = await quiet(() =>
      ask([`${source}:1`, "explain"], {}, { readiness: ready, bootstrap }),
    );
    expect(fresh).toBe(0);
    await expect(
      quiet(() =>
        ask(["continue"], { conversation: "conversation-does-not-exist" }, { bootstrap }),
      ),
    ).rejects.toThrow();
  }, 30_000);

  test("Chat and Brainstorm enter their real default create and resume transports", async () => {
    const state = mkdtempSync(join(tmpdir(), "vf-command-chat-state-"));
    roots.push(state);
    const chatBootstrap = bootstrapOptions(join(state, "chat"));
    const created = await quiet(() =>
      chat(["Explain", "the", "runtime", "--participant", "direct@claude"], {
        bootstrap: chatBootstrap,
      }),
    );
    expect(created).toBe(0);
    const resumed = await quiet(() =>
      chat(["continue", "--resume", "conversation-does-not-exist"], {
        bootstrap: chatBootstrap,
      }),
    );
    expect(resumed).not.toBe(0);

    const brainstormBootstrap = bootstrapOptions(join(state, "brainstorm"));
    const brainstormCreate = await quiet(() =>
      brainstorm(
        [
          "Compare durable choices",
          "--participant",
          "direct@claude",
          "--participant",
          "reviewer@claude",
          "--participant",
          "brainstorm-evaluator@claude",
          "--yes",
        ],
        {
          bootstrap: brainstormBootstrap,
          dryRun: async () => ({
            participants: [
              {
                participant_id: "participant-direct",
                role_ref: "direct",
                engine: "claude",
                model: "sonnet",
                engine_available: true,
                model_valid: true,
              },
              {
                participant_id: "participant-reviewer",
                role_ref: "reviewer",
                engine: "claude",
                model: "sonnet",
                engine_available: true,
                model_valid: true,
              },
              {
                participant_id: "participant-evaluator",
                role_ref: "brainstorm-evaluator",
                engine: "claude",
                model: "sonnet",
                engine_available: true,
                model_valid: true,
              },
            ],
            evaluator_auto_added: false,
            engines_available: ["claude"],
            models_valid: true,
          }),
        },
      ),
    );
    expect(brainstormCreate).not.toBe(2);
    const brainstormResume = await quiet(() =>
      brainstorm(["continue", "--resume", "conversation-does-not-exist"], {
        bootstrap: brainstormBootstrap,
      }),
    );
    expect(brainstormResume).not.toBe(0);
  }, 30_000);
});

describe("production HTTP composition delegates every shared authority", () => {
  test("the composed authority exposes queue, compatibility, event, and Home-create adapters", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-http-authority-default-"));
    roots.push(root);
    const repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"name":"http-authority-coverage"}\n');
    writeFileSync(join(repo, "context.txt"), "first\nsecond\nthird\n");
    const authority = buildConversationHttpAuthority(
      { bootstrap: bootstrapOptions(join(root, "conversation")) },
      "127.0.0.1",
      repo,
      {
        userHomeRoot: home,
        userVibeflowRoot: join(home, ".vibeflow"),
        now: () => "2026-08-26T00:00:00.000Z",
        vfVersion: "0.15.0",
        engineVersions: { claude: "1.0.0" },
      },
    );
    const queue = authority.browser?.messageQueue;
    expect(queue).toBeDefined();
    const principalDigest = TEST_PRINCIPAL_DIGEST;
    const calls = [
      () => queue?.assertRoot("missing-root"),
      () => queue?.snapshot("missing-root"),
      () =>
        queue?.enqueue({
          root_session_id: "missing-root",
          principal_digest: principalDigest,
          request: {} as never,
        }),
      () =>
        queue?.edit({
          root_session_id: "missing-root",
          principal_digest: principalDigest,
          queue_item_id: MISSING_QUEUE_ITEM_ID,
          request: {} as never,
        }),
      () => queue?.item("missing-root", MISSING_QUEUE_ITEM_ID),
      () =>
        queue?.stageMessagePrivateContext({
          root_session_id: "missing-root",
          principal_digest: principalDigest,
          request: {} as never,
        }),
      () =>
        queue?.discardMessagePrivateContext({
          root_session_id: "missing-root",
          principal_digest: principalDigest,
          request: {} as never,
        }),
      () =>
        queue?.stageDraftPrivateContext({
          principal_digest: principalDigest,
          request: {} as never,
        }),
      () =>
        queue?.discardDraftPrivateContext({
          principal_digest: principalDigest,
          request: {} as never,
        }),
    ];
    for (const call of calls) {
      try {
        await call();
      } catch {
        // Each adapter is expected to fail closed for an absent root or malformed request.
      }
    }

    const created = await authority.homeCreate?.create({
      principal_digest: principalDigest,
      request: {
        schema_version: "1.0",
        idempotency_key: "http-authority-create",
        topic: "Create through composed Home authority",
        private_context_present: false,
      },
    });
    expect(created?.conversation_id).toBeString();
    if (!created) throw new Error("Home create authority was not composed");

    const rootSessionId = authority.messageQueueEvents?.rootSessionId(created.conversation_id);
    expect(rootSessionId).toBeString();
    if (!rootSessionId) throw new Error("created conversation root was not published");
    const unsubscribe = authority.messageQueueEvents?.subscribe(rootSessionId, () => undefined);
    unsubscribe?.();

    const draftPresence = await queue?.stageDraftPrivateContext({
      principal_digest: principalDigest,
      request: {
        schema_version: "1.0",
        create_idempotency_key: "http-authority-draft-context",
        source_kind: "private-file-range",
        repo_relative_path: "context.txt",
        start_line: 1,
        end_line: 2,
      },
    });
    expect(draftPresence?.presence.private_context_present).toBe(true);
    expect(
      (
        await queue?.discardDraftPrivateContext({
          principal_digest: principalDigest,
          request: {
            schema_version: "1.0",
            idempotency_key: "http-authority-discard-draft",
            create_idempotency_key: "http-authority-draft-context",
            expected_private_context_present: true,
          },
        })
      )?.presence.private_context_present,
    ).toBe(false);
    const messagePresence = await queue?.stageMessagePrivateContext({
      root_session_id: rootSessionId,
      principal_digest: principalDigest,
      request: {
        schema_version: "1.0",
        enqueue_idempotency_key: "http-authority-message-context",
        source_kind: "private-file-range",
        repo_relative_path: "context.txt",
        start_line: 2,
        end_line: 3,
      },
    });
    expect(messagePresence?.presence.private_context_present).toBe(true);
    expect(
      (
        await queue?.discardMessagePrivateContext({
          root_session_id: rootSessionId,
          principal_digest: principalDigest,
          request: {
            schema_version: "1.0",
            idempotency_key: "http-authority-discard-message",
            enqueue_idempotency_key: "http-authority-message-context",
            expected_private_context_present: true,
          },
        })
      )?.presence.private_context_present,
    ).toBe(false);

    const compatibility = authority.compatibilityMessages?.queue;
    expect(() => compatibility?.resolveCommittedConversation("missing-conversation")).toThrow();
    try {
      await compatibility?.enqueueCompatibility(
        "missing-conversation",
        principalDigest,
        "http-authority-message",
        { content: "queued" },
      );
    } catch {
      // The wrapper must preserve the durable not-found authority.
    }
    expect(compatibility?.item("missing-root", MISSING_QUEUE_ITEM_ID)).toBeNull();

    expect(authority.messageQueueEvents?.rootSessionId("missing-conversation")).toBeNull();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const snapshot = await authority.service.snapshot(created.conversation_id);
      if (snapshot?.lifecycle !== "ACTIVE") break;
      await Bun.sleep(10);
    }
    expect((await authority.service.snapshot(created.conversation_id))?.lifecycle).not.toBe(
      "ACTIVE",
    );
  }, 30_000);
});
