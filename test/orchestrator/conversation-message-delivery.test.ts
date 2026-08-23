import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBinding, MaterializedAgentBinding } from "../../src/agents/binding.js";
import { classifyConversationResult } from "../../src/commands/conversation-args.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import {
  type EngineSessionAdapter,
  type EngineSessionRequest,
  type EngineSessionResult,
  createSpawnOptionsProjection,
} from "../../src/dispatch/session-types.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { DebateConversationPolicy } from "../../src/orchestrator/conversation/debate-policy.js";
import { DirectConversationPolicy } from "../../src/orchestrator/conversation/direct-policy.js";
import {
  ConversationPolicyRegistry,
  type RuntimeCreateRequest,
} from "../../src/orchestrator/conversation/policy-registry.js";
import { ConversationOrchestrator } from "../../src/orchestrator/conversation/service.js";
import type { ConversationPolicy } from "../../src/orchestrator/conversation/types.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";

const roleHash = "a".repeat(64);
const participant = (answer: string, claim: string) =>
  JSON.stringify({ answer, content: answer, claim, evidence: [] });
const evaluator = JSON.stringify({
  agreement: { value: true, evidence: "yes" },
  conflict_resolution: { value: true, evidence: "yes" },
  evidence_quality: { value: true, evidence: "yes" },
  convergence: { value: true, evidence: "yes" },
});

function binding(roleName: string): MaterializedAgentBinding {
  const envPolicy = conversationEnvPolicy("codex");
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [] };
  const traceMetadata = { role_resolved_hash: roleHash, skill_resolved_hashes: [] };
  return {
    resolved: {
      role: {
        source: "builtin",
        resolved_hash: roleHash,
        metadata: {},
        spec: {
          name: roleName,
          description: roleName,
          body: "Canonical conversation role",
          tools: ["read"],
          model: "gpt-5.4",
          sandbox: "read-only",
        },
      },
      skills: [],
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      tool_intents: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    },
    spawn: createSpawnOptionsProjection({
      engine: "codex",
      model: "gpt-5.4",
      sessionMode: "fresh",
      rendered_prompt: `Canonical ${roleName}\n\n## Assigned Topic\n\nChoose\n`,
      rendered_tools: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

interface PendingSession {
  request: EngineSessionRequest;
  settle(result: EngineSessionResult): void;
  settled: boolean;
}

class ControlledAdapter implements EngineSessionAdapter {
  readonly sessions: PendingSession[] = [];

  start(request: EngineSessionRequest) {
    request.onLifecycle?.("requested");
    request.onLifecycle?.("dispatched");
    request.onLifecycle?.("acknowledged");
    let resolve!: (result: EngineSessionResult) => void;
    const completion = new Promise<EngineSessionResult>((done) => {
      resolve = done;
    });
    const session: PendingSession = {
      request,
      settled: false,
      settle: (result) => {
        if (session.settled) return;
        session.settled = true;
        request.onLifecycle?.(result.ok ? "completed" : "ambiguous");
        resolve(result);
      },
    };
    this.sessions.push(session);
    return {
      attemptId: request.attemptId,
      completion,
      terminate: async (reason: string) => {
        session.settle(this.result(this.sessions.indexOf(session), "", false, reason));
      },
      readResumeBinding: () => undefined,
      readEvidenceBinding: () => undefined,
    };
  }

  complete(index: number, output: string): void {
    const session = this.sessions[index];
    if (!session) throw new Error(`session ${index} has not started`);
    session.settle(this.result(index, output, true));
  }

  private result(index: number, output: string, ok: boolean, reason?: string): EngineSessionResult {
    const request = this.sessions[index]?.request;
    if (!request) throw new Error(`session ${index} has not started`);
    return {
      attemptId: request.attemptId,
      engine: "codex",
      ok,
      state: ok ? "completed" : "ambiguous",
      lifecycle: ok
        ? ["requested", "dispatched", "acknowledged", "completed"]
        : ["requested", "dispatched", "acknowledged", "ambiguous"],
      output,
      ...(reason ? { reason } : {}),
      evidenceStatus: "persisted",
      nativeSessionStatus: "unavailable",
    };
  }

  async reconcileHistory() {
    return {
      status: "unavailable" as const,
      imported_turn_count: 0,
      imported_tool_count: 0,
      completeness_reason: "not used",
    };
  }
}

const waitFor = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for conversation progress");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

async function setup(policy: ConversationPolicy, roles: string[]) {
  const root = await mkdtemp(join(tmpdir(), "vf-message-delivery-"));
  const opaque = new DurableArtifactRegistry({ dir: join(root, "opaque") });
  let event = 0;
  const adapter = new ControlledAdapter();
  const materialized = roles.map(binding);
  const service = new ConversationOrchestrator({
    traceStore: new TraceStore({
      dir: join(root, "trace"),
      artifactRegistry: opaque,
      eventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, "0")}`,
      now: () => "2026-08-23T00:00:00.000Z",
    }),
    artifactRegistry: opaque,
    artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
    sessionAdapter: adapter,
    policies: new ConversationPolicyRegistry([policy]),
    id: (() => {
      const counters = new Map<string, number>();
      return (kind: string) => {
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        return `${kind}-${next}`;
      };
    })(),
    now: () => "2026-08-23T00:00:00.000Z",
    rehydrateBinding: async (persisted) =>
      materialized[roles.indexOf(persisted.input.roleRef)] as MaterializedAgentBinding,
  });
  const request: RuntimeCreateRequest = {
    topic: "Choose",
    policy: policy.name,
    maxRounds: 1,
    baselineEnabled: true,
    evaluatorAutoAdded: false,
    repoRoot: root,
    phase: 1,
    bindings: materialized.map((item, index) => ({
      participantId: `p${index + 1}`,
      input: {
        roleRef: roles[index] as string,
        engine: "codex",
        sessionMode: "fresh",
      } satisfies AgentBinding,
      materialized: item,
    })),
  };
  return { root, service, adapter, request };
}

async function completeDebate(adapter: ControlledAdapter, offset: number): Promise<void> {
  adapter.complete(offset, "baseline");
  await waitFor(() => adapter.sessions.length >= offset + 3);
  adapter.complete(offset + 1, participant("first", "shared"));
  adapter.complete(offset + 2, participant("second", "shared"));
  await waitFor(() => adapter.sessions.length >= offset + 4);
  adapter.complete(offset + 3, evaluator);
  await waitFor(() => adapter.sessions.length >= offset + 5);
  adapter.complete(offset + 4, evaluator);
}

test("ACTIVE direct message launches a same-conversation continuation with the injected prompt", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const started = await run.service.start(run.request);
    await waitFor(() => run.adapter.sessions.length === 1);
    await expect(
      run.service.message(started.conversation_id, {
        content: "Use the durable cache",
        target_participants: ["p1"],
      }),
    ).resolves.toMatchObject({ accepted: true });
    run.adapter.complete(0, "first answer");
    await waitFor(() => run.adapter.sessions.length === 2);
    const continuationPrompt = run.adapter.sessions[1]?.request.spawn.rendered_prompt;
    run.adapter.complete(1, "revised answer");
    const completed = await started.completion;
    expect(continuationPrompt).toContain("Use the durable cache");
    expect(completed).toMatchObject({ result: { status: "completed" } });
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("debate routes ACTIVE and child-revision messages only to applicable participant prompts", async () => {
  const roles = ["brainstorm-participant", "brainstorm-skeptic", "brainstorm-evaluator"];
  const run = await setup(new DebateConversationPolicy(), roles);
  try {
    const started = await run.service.start(run.request);
    await waitFor(() => run.adapter.sessions.length === 1);
    await run.service.message(started.conversation_id, {
      content: "Apply to every responder",
      target_participants: "all",
    });
    await run.service.message(started.conversation_id, {
      content: "Only the first responder",
      target_participants: ["p1"],
    });
    await completeDebate(run.adapter, 0);
    await expect(started.completion).resolves.toMatchObject({ result: { status: "completed" } });
    const firstPrompt = run.adapter.sessions[1]?.request.spawn.rendered_prompt ?? "";
    const secondPrompt = run.adapter.sessions[2]?.request.spawn.rendered_prompt ?? "";
    expect(firstPrompt).toContain("Apply to every responder");
    expect(firstPrompt).toContain("Only the first responder");
    expect(secondPrompt).toContain("Apply to every responder");
    expect(secondPrompt).not.toContain("Only the first responder");
    expect(run.adapter.sessions[3]?.request.spawn.rendered_prompt).not.toContain(
      "Apply to every responder",
    );

    const revised = await run.service.message(started.conversation_id, {
      content: "Child revision for the skeptic",
      target_participants: ["p2"],
    });
    expect(typeof revised.child_conversation_id).toBe("string");
    await waitFor(() => run.adapter.sessions.length === 6);
    await completeDebate(run.adapter, 5);
    await waitFor(async () => {
      const snapshot = await run.service.snapshot(revised.child_conversation_id as string);
      return snapshot?.lifecycle === "COMPLETED";
    });
    expect(run.adapter.sessions[6]?.request.spawn.rendered_prompt).not.toContain(
      "Child revision for the skeptic",
    );
    expect(run.adapter.sessions[7]?.request.spawn.rendered_prompt).toContain(
      "Child revision for the skeptic",
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("a user STOPPED conversation returns stopped and retains CLI success semantics", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const started = await run.service.start(run.request);
    await waitFor(() => run.adapter.sessions.length === 1);
    await expect(run.service.stop(started.conversation_id)).resolves.toEqual({
      stopped: true,
      terminal_state: "STOPPED",
    });
    const completed = await started.completion;
    expect(completed.result.status).toBe("stopped");
    expect(classifyConversationResult(completed.result.status, [])).toBe(0);
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});
