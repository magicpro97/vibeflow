import { expect, test } from "bun:test";
import * as fs from "node:fs";
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
import {
  AttemptStartAuthorityStore,
  createDurableAttemptStartAuthorityReaderV1,
} from "../../src/dispatch/start-authority.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { ConversationHomeAuthorities } from "../../src/orchestrator/conversation/conversation-home-authorities.js";
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
  private authorityRoot?: string;
  private authorityStore?: AttemptStartAuthorityStore;
  private nativeCounter = 0;
  startAuthority?: EngineSessionAdapter["startAuthority"];

  bindAuthority(root: string): void {
    this.authorityRoot = join(root, "adapter-evidence");
    this.authorityStore = new AttemptStartAuthorityStore(this.authorityRoot);
    this.startAuthority = createDurableAttemptStartAuthorityReaderV1(this.authorityStore);
  }

  start(request: EngineSessionRequest) {
    if (!this.authorityRoot || !this.authorityStore)
      throw new Error("test start authority is not bound");
    const nativeSessionId =
      request.spawn.sessionMode === "exact" && request.nativeSessionId
        ? request.nativeSessionId
        : `00000000-0000-4000-8000-${String(++this.nativeCounter).padStart(12, "0")}`;
    const evidenceRef = join(this.authorityRoot, `${request.attemptId}.json`);
    fs.mkdirSync(this.authorityRoot, { recursive: true });
    fs.writeFileSync(evidenceRef, JSON.stringify({ attempt_id: request.attemptId }), {
      mode: 0o600,
    });
    this.authorityStore.record({
      attempt_id: request.attemptId,
      engine: "codex",
      outcome: "accepted",
      native_session_id: nativeSessionId,
      evidence_ref: evidenceRef,
      recorded_at: "2026-08-23T00:00:00.000Z",
    });
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
      readResumeBinding: () => ({
        attemptId: request.attemptId,
        engine: "codex" as const,
        nativeSessionId,
      }),
      readEvidenceBinding: () => ({ attemptId: request.attemptId, internalRef: evidenceRef }),
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
      nativeSessionStatus: "captured",
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
  adapter.bindAuthority(root);
  const materialized = roles.map(binding);
  const artifactRoot = join(root, "manifests");
  const homeAuthorities = new ConversationHomeAuthorities({
    artifactRoot,
    now: () => "2026-08-23T00:00:00.000Z",
  });
  const service = new ConversationOrchestrator({
    traceStore: new TraceStore({
      dir: join(root, "trace"),
      artifactRegistry: opaque,
      eventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, "0")}`,
      now: () => "2026-08-23T00:00:00.000Z",
    }),
    artifactRegistry: opaque,
    artifactStore: new ConversationArtifactStore({ dir: artifactRoot }),
    homeAuthorities,
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
  return { root, service, adapter, request, homeAuthorities };
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

test("private file range handoff reaches the target CLI without leaking into public events", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const started = await run.service.start(run.request);
    const binding = run.homeAuthorities.privateFileRanges.stage({
      handoff_id: "vf-file-range-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repo_relative_path: "src/private.ts",
      start_line: 4,
      end_line: 6,
      content: "alpha\r\nbeta\ncharlie",
      staged_at: "2026-08-23T00:00:00.000Z",
    });
    await waitFor(() => run.adapter.sessions.length === 1);
    await expect(
      run.service.message(started.conversation_id, {
        content: "Use the selected file range.",
        target_participants: ["p1"],
        private_file_range: binding,
      }),
    ).resolves.toMatchObject({ accepted: true });
    run.adapter.complete(0, "first answer");
    await waitFor(() => run.adapter.sessions.length === 2);
    const continuationPrompt = run.adapter.sessions[1]?.request.spawn.rendered_prompt ?? "";
    const events = await run.service.events(started.conversation_id, 0);
    run.adapter.complete(1, "revised answer");
    await started.completion;

    expect(continuationPrompt).toContain("VF-PRIVATE-FILE-RANGES/1");
    expect(continuationPrompt).toContain("src/private.ts");
    expect(continuationPrompt).toContain("alpha\\r\\nbeta\\ncharlie");
    expect(continuationPrompt).not.toContain(run.root);
    expect(JSON.stringify(events)).not.toContain("alpha\r\nbeta\ncharlie");
    expect(JSON.stringify(events)).not.toContain("src/private.ts");
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("failed private file range delivery releases the one-shot reservation", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const started = await run.service.start(run.request);
    const binding = run.homeAuthorities.privateFileRanges.stage({
      handoff_id: "vf-file-range-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      repo_relative_path: "src/private.ts",
      start_line: 1,
      end_line: 1,
      content: "release me",
      staged_at: "2026-08-23T00:00:00.000Z",
    });
    const runtime = (
      run.service as unknown as {
        runtime: {
          controls: { userMessage: (id: string, request: unknown, key: string) => Promise<void> };
        };
      }
    ).runtime;
    const original = runtime.controls.userMessage;
    runtime.controls.userMessage = async () => {
      throw new Error("append failed");
    };
    await expect(
      run.service.message(started.conversation_id, {
        content: "This should fail.",
        target_participants: ["p1"],
        private_file_range: binding,
      }),
    ).rejects.toThrow("append failed");
    runtime.controls.userMessage = original;

    expect(
      run.homeAuthorities.privateFileRanges.readFrames(binding.handoff_id).at(-1),
    ).toMatchObject({
      state: "available",
      reservation_key: null,
      consumed_by: null,
    });
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("ambiguous private file range append stays reserved when trace recovery is unavailable", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const started = await run.service.start(run.request);
    const binding = run.homeAuthorities.privateFileRanges.stage({
      handoff_id: "vf-file-range-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      repo_relative_path: "src/private.ts",
      start_line: 1,
      end_line: 1,
      content: "fail closed",
      staged_at: "2026-08-23T00:00:00.000Z",
    });
    const serviceInternals = run.service as unknown as {
      options: { traceStore: { recoverConversation: (id: string) => Promise<unknown> } };
      runtime: {
        controls: { userMessage: (id: string, request: unknown, key: string) => Promise<void> };
      };
    };
    let appendAttempted = false;
    const recover = serviceInternals.options.traceStore.recoverConversation.bind(
      serviceInternals.options.traceStore,
    );
    serviceInternals.runtime.controls.userMessage = async () => {
      appendAttempted = true;
      throw new Error("append outcome unknown");
    };
    serviceInternals.options.traceStore.recoverConversation = async (id) => {
      if (appendAttempted) throw new Error("trace recovery unavailable");
      return recover(id);
    };

    await expect(
      run.service.message(started.conversation_id, {
        content: "This outcome is ambiguous.",
        target_participants: ["p1"],
        private_file_range: binding,
      }),
    ).rejects.toThrow("append outcome unknown");
    expect(
      run.homeAuthorities.privateFileRanges.readFrames(binding.handoff_id).at(-1),
    ).toMatchObject({
      state: "reserved",
      consumed_by: null,
    });
    expect(() =>
      run.homeAuthorities.privateFileRanges.reserve(
        binding,
        "different-message",
        "2026-08-23T00:00:01.000Z",
      ),
    ).toThrow("available");
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("durable user-message append failure is reconciled without releasing its file range", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const started = await run.service.start(run.request);
    const binding = run.homeAuthorities.privateFileRanges.stage({
      handoff_id: "vf-file-range-7777777777777777777777777777777777777777777777777777777777777777",
      repo_relative_path: "src/private.ts",
      start_line: 1,
      end_line: 1,
      content: "durable message",
      staged_at: "2026-08-23T00:00:00.000Z",
    });
    const traceStore = (run.service as unknown as { options: { traceStore: TraceStore } }).options
      .traceStore;
    const append = traceStore.append.bind(traceStore);
    traceStore.append = async (...input: Parameters<TraceStore["append"]>) => {
      const stored = await append(...input);
      if (input[1].event.type === "user_message")
        throw new Error("message append failed after commit");
      return stored;
    };

    await expect(
      run.service.message(started.conversation_id, {
        content: "This message is already durable.",
        target_participants: ["p1"],
        private_file_range: binding,
      }),
    ).rejects.toThrow("message append failed after commit");
    expect(
      run.homeAuthorities.privateFileRanges.readFrames(binding.handoff_id).at(-1),
    ).toMatchObject({
      state: "consumed",
      consumed_by: expect.stringContaining(":message:"),
    });
    expect(() =>
      run.homeAuthorities.privateFileRanges.reserve(
        binding,
        "different-message",
        "2026-08-23T00:00:01.000Z",
      ),
    ).toThrow("available");
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("post-append private file consume failure never makes a delivered handoff reusable", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const started = await run.service.start(run.request);
    const binding = run.homeAuthorities.privateFileRanges.stage({
      handoff_id: "vf-file-range-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      repo_relative_path: "src/private.ts",
      start_line: 1,
      end_line: 1,
      content: "one shot",
      staged_at: "2026-08-23T00:00:00.000Z",
    });
    const staging = run.homeAuthorities.privateFileRanges;
    const consume = staging.consume.bind(staging);
    staging.consume = () => {
      throw new Error("consume failed after append");
    };
    await expect(
      run.service.message(started.conversation_id, {
        content: "This append is durable.",
        target_participants: ["p1"],
        private_file_range: binding,
      }),
    ).rejects.toThrow("consume failed after append");
    staging.consume = consume;

    expect(staging.readFrames(binding.handoff_id).at(-1)).toMatchObject({
      state: "reserved",
      consumed_by: null,
    });
    expect(() => staging.reserve(binding, "different-message", "2026-08-23T00:00:01.000Z")).toThrow(
      "available",
    );
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("create begin failure releases its private file range reservation", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const binding = run.homeAuthorities.privateFileRanges.stage({
      handoff_id: "vf-file-range-dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      repo_relative_path: "src/private.ts",
      start_line: 1,
      end_line: 1,
      content: "retryable create",
      staged_at: "2026-08-23T00:00:00.000Z",
    });
    const runtime = (
      run.service as unknown as {
        runtime: { begin: (...input: unknown[]) => string };
      }
    ).runtime;
    runtime.begin = () => {
      throw new Error("begin failed");
    };
    await expect(
      run.service.start({ ...run.request, private_file_range: binding }),
    ).rejects.toThrow("begin failed");
    expect(
      run.homeAuthorities.privateFileRanges.readFrames(binding.handoff_id).at(-1),
    ).toMatchObject({
      state: "available",
      reservation_key: null,
      consumed_by: null,
    });
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("durable create persistence consumes its private file range after a late failure", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const binding = run.homeAuthorities.privateFileRanges.stage({
      handoff_id: "vf-file-range-9999999999999999999999999999999999999999999999999999999999999999",
      repo_relative_path: "src/private.ts",
      start_line: 1,
      end_line: 1,
      content: "manifest owns this range",
      staged_at: "2026-08-23T00:00:00.000Z",
    });
    const artifacts = (
      run.service as unknown as {
        options: { artifactStore: ConversationArtifactStore };
      }
    ).options.artifactStore;
    const create = artifacts.create.bind(artifacts);
    artifacts.create = (...input: Parameters<ConversationArtifactStore["create"]>) => {
      create(...input);
      throw new Error("manifest persistence failed after commit");
    };

    await expect(
      run.service.start({ ...run.request, private_file_range: binding }),
    ).rejects.toThrow("manifest persistence failed after commit");
    expect(
      run.homeAuthorities.privateFileRanges.readFrames(binding.handoff_id).at(-1),
    ).toMatchObject({
      state: "consumed",
      consumed_by: expect.stringContaining(":create"),
    });
    expect(() =>
      run.homeAuthorities.privateFileRanges.reserve(
        binding,
        "different-create",
        "2026-08-23T00:00:01.000Z",
      ),
    ).toThrow("available");
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("proven-absent create persistence releases its private file range", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const binding = run.homeAuthorities.privateFileRanges.stage({
      handoff_id: "vf-file-range-8888888888888888888888888888888888888888888888888888888888888888",
      repo_relative_path: "src/private.ts",
      start_line: 1,
      end_line: 1,
      content: "safe to retry",
      staged_at: "2026-08-23T00:00:00.000Z",
    });
    const artifacts = (
      run.service as unknown as { options: { artifactStore: ConversationArtifactStore } }
    ).options.artifactStore;
    artifacts.create = () => {
      throw new Error("manifest persistence failed before commit");
    };

    await expect(
      run.service.start({ ...run.request, private_file_range: binding }),
    ).rejects.toThrow("manifest persistence failed before commit");
    expect(
      run.homeAuthorities.privateFileRanges.readFrames(binding.handoff_id).at(-1),
    ).toMatchObject({
      state: "available",
      reservation_key: null,
      consumed_by: null,
    });
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("durable create configuration failure consumes its private file range", async () => {
  const run = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const binding = run.homeAuthorities.privateFileRanges.stage({
      handoff_id: "vf-file-range-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      repo_relative_path: "src/private.ts",
      start_line: 1,
      end_line: 1,
      content: "configured once",
      staged_at: "2026-08-23T00:00:00.000Z",
    });
    const traceStore = (run.service as unknown as { options: { traceStore: TraceStore } }).options
      .traceStore;
    const append = traceStore.append.bind(traceStore);
    traceStore.append = async (...input: Parameters<TraceStore["append"]>) => {
      const stored = await append(...input);
      if (input[1].idempotency_key === "conversation:configured")
        throw new Error("configured append failed after commit");
      return stored;
    };

    await expect(
      run.service.start({ ...run.request, private_file_range: binding }),
    ).rejects.toThrow("configured append failed after commit");
    expect(
      run.homeAuthorities.privateFileRanges.readFrames(binding.handoff_id).at(-1),
    ).toMatchObject({
      state: "consumed",
      consumed_by: expect.stringContaining(":create"),
    });
    expect(() =>
      run.homeAuthorities.privateFileRanges.reserve(
        binding,
        "different-create",
        "2026-08-23T00:00:01.000Z",
      ),
    ).toThrow("available");
  } finally {
    await rm(run.root, { recursive: true, force: true });
  }
});

test("direct plain text streams before completion while a structured social candidate stays buffered", async () => {
  const plain = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const started = await plain.service.start(plain.request);
    await waitFor(() => plain.adapter.sessions.length === 1);
    plain.adapter.sessions[0]?.request.onChunk?.({ stream: "stdout", content: "live answer" });
    await waitFor(
      async () =>
        (await plain.service.events(started.conversation_id, 0))?.some(
          (event) =>
            event.event.type === "agent_response_delta" &&
            event.event.payload.content_delta === "live answer" &&
            !event.event.payload.completes_response,
        ) === true,
    );
    plain.adapter.complete(0, "live answer");
    await started.completion;
  } finally {
    await rm(plain.root, { recursive: true, force: true });
  }

  const structured = await setup(new DirectConversationPolicy(), ["direct"]);
  try {
    const started = await structured.service.start(structured.request);
    await waitFor(() => structured.adapter.sessions.length === 1);
    const output = '{"answer":"visible","quote_refs":[],"reactions":[]}';
    structured.adapter.sessions[0]?.request.onChunk?.({
      stream: "stdout",
      content: output.slice(0, 20),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (await structured.service.events(started.conversation_id, 0))?.some(
        (event) => event.event.type === "agent_response_delta",
      ),
    ).toBe(false);
    structured.adapter.sessions[0]?.request.onChunk?.({
      stream: "stdout",
      content: output.slice(20),
    });
    structured.adapter.complete(0, output);
    await started.completion;
    const visible = (await structured.service.events(started.conversation_id, 0))?.flatMap(
      (event) =>
        event.event.type === "agent_response_delta"
          ? [String(event.event.payload.content_delta)]
          : [],
    );
    expect(visible).toEqual(["visible", ""]);
    expect(JSON.stringify(visible)).not.toContain("quote_refs");
  } finally {
    await rm(structured.root, { recursive: true, force: true });
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
    await waitFor(() => run.adapter.sessions.length === 8);
    run.adapter.complete(5, "barrier-ready");
    run.adapter.complete(6, "barrier-ready");
    run.adapter.complete(7, "barrier-ready");
    await waitFor(() => run.adapter.sessions.length === 9);
    const barrierHandoffs = [5, 6, 7].map((index) => {
      const prompt = run.adapter.sessions[index]?.request.spawn.rendered_prompt ?? "";
      const offset = prompt.indexOf("VF-HANDOFF/1\n");
      if (offset < 0) throw new Error("child handoff is absent");
      return prompt.slice(offset).trimEnd();
    });
    expect(new Set(barrierHandoffs).size).toBe(1);
    expect(barrierHandoffs[0]).toContain("first");
    expect(barrierHandoffs[0]).toContain("second");
    await completeDebate(run.adapter, 8);
    await waitFor(async () => {
      const snapshot = await run.service.snapshot(revised.child_conversation_id as string);
      return snapshot?.lifecycle === "COMPLETED";
    });
    expect(run.adapter.sessions[9]?.request.spawn.rendered_prompt).not.toContain(
      "Child revision for the skeptic",
    );
    expect(run.adapter.sessions[10]?.request.spawn.rendered_prompt).toContain(
      "Child revision for the skeptic",
    );
    const childPrompts = [9, 10].map(
      (index) => run.adapter.sessions[index]?.request.spawn.rendered_prompt ?? "",
    );
    for (const prompt of childPrompts) {
      expect(prompt).toContain("VF-HANDOFF/1");
      expect(prompt.match(/VF-HANDOFF\/1/g)).toHaveLength(1);
    }
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
