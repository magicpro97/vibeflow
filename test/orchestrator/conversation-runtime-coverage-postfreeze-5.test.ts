import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { DirectConversationPolicy } from "../../src/orchestrator/conversation/direct-policy.js";
import { ConversationPolicyRegistry } from "../../src/orchestrator/conversation/policy-registry.js";
import { ConversationRuntime } from "../../src/orchestrator/conversation/runtime.js";
import type { ConversationManifest } from "../../src/orchestrator/conversation/types.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";

test("detached runtime readers retain their bound authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-runtime-control-state-"));
  try {
    const artifactRegistry = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const artifactStore = new ConversationArtifactStore({ dir: join(root, "artifacts") });
    const runtime = new ConversationRuntime({
      traceStore: new TraceStore({
        dir: join(root, "traces"),
        artifactRegistry,
        now: () => "2026-08-26T00:00:00.000Z",
      }),
      artifactRegistry,
      artifactStore,
      sessionAdapter: {
        start: () => {
          throw new Error("unused adapter start");
        },
        reconcileHistory: async () => ({
          engine: "codex",
          nativeSessionId: "unused",
          status: "missing",
        }),
      } as never,
      policies: new ConversationPolicyRegistry([new DirectConversationPolicy()]),
      rehydrateBinding: async () =>
        ({
          resolved: {
            engine: "codex",
            model: "gpt-5.4",
            sessionMode: "fresh",
            role: {
              source: "builtin",
              resolved_hash: "a".repeat(64),
              spec: { name: "direct" },
            },
            skills: [],
          },
        }) as never,
    });

    const readControlState = runtime.controlState;
    expect(await readControlState("absent-conversation")).toBeNull();
    const readOperationOwnerState = runtime.operationOwnerState;
    expect(readOperationOwnerState("absent-conversation", "absent-operation")).toBe("absent");
    const readSnapshot = runtime.snapshot;
    expect(await readSnapshot("absent-conversation")).toBeNull();
    const manifest: ConversationManifest = {
      version: "1.0",
      conversation_id: "detached-runtime-events",
      workflow_id: "detached-runtime-workflow",
      revision_id: "detached-runtime-revision",
      run_id: "detached-runtime-run",
      parent_conversation_id: null,
      parent_revision_id: null,
      topic: "Detached runtime readers",
      policy: "direct",
      max_rounds: 1,
      baseline_enabled: false,
      evaluator_auto_added: false,
      repo_root: root,
      phase: 3,
      task_text: "Read an empty durable event history through detached authority",
      bindings: [
        {
          participant_id: "detached-reader",
          input: { roleRef: "direct", engine: "codex", sessionMode: "fresh" },
        },
      ],
      created_at: "2026-08-26T00:00:00.000Z",
    };
    artifactStore.create(manifest, [
      {
        participant_id: "detached-reader",
        engine: "codex",
        model: "gpt-5.4",
        session_mode: "fresh",
        role_source: "builtin",
        role_hash: "a".repeat(64),
        skill_hashes: [],
      },
    ]);
    const readEvents = runtime.events;
    expect(await readEvents(manifest.conversation_id, 0)).toEqual([]);
    const rehydrate = runtime.rehydrate;
    const hydrated = await rehydrate(manifest.conversation_id);
    expect(hydrated.record.manifest.conversation_id).toBe(manifest.conversation_id);
    expect(hydrated.bindings).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
