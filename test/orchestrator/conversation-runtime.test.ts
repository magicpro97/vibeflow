import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBinding, MaterializedAgentBinding } from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import {
  type EngineSessionAdapter,
  type EngineSessionRequest,
  type HistoryReconcileRequest,
  createSpawnOptionsProjection,
} from "../../src/dispatch/session-types.js";
import type { EngineSessionResult } from "../../src/dispatch/session-types.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { DirectConversationPolicy } from "../../src/orchestrator/conversation/direct-policy.js";
import { OperationTransitionReservedError } from "../../src/orchestrator/conversation/operation-registry.js";
import {
  ConversationPolicyRegistry,
  conversationChildId,
  terminalEmissions,
} from "../../src/orchestrator/conversation/policy-registry.js";
import type {
  ConversationRuntime,
  ConversationRuntimeOptions,
} from "../../src/orchestrator/conversation/runtime.js";
import {
  ConversationControlConflictError,
  ConversationOrchestrator,
} from "../../src/orchestrator/conversation/service.js";
import type {
  ConversationContext,
  ConversationCreateRequest,
  ConversationPolicy,
  DryRunResult,
  PolicyAttemptRequest,
} from "../../src/orchestrator/conversation/types.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore, traceJournalPath } from "../../src/orchestrator/trace/store.js";
import type {
  PolicyEmission,
  TraceAppendInput,
  TraceCorrelation,
} from "../../src/orchestrator/trace/types.js";

const input: AgentBinding = {
  roleRef: "direct",
  engine: "codex",
  sessionMode: "fresh",
};
const ROLE_HASH = "a".repeat(64);
const SKILL_HASH = "b".repeat(64);

function materialized(
  withSkill = false,
  options: { roleName?: string; sessionMode?: "exact" | "replay" | "fresh" } = {},
): MaterializedAgentBinding {
  const roleName = options.roleName ?? "direct";
  const sessionMode = options.sessionMode ?? "fresh";
  const env_policy = conversationEnvPolicy("codex");
  const skills = withSkill
    ? [
        {
          ref: "runtime-portability",
          source: "builtin" as const,
          version: "1.0.0",
          resolved_hash: SKILL_HASH,
          resolved_body: "Canonical skill body",
          dependency_hashes: [],
        },
      ]
    : [];
  const skillHashes = skills.map((skill) => skill.resolved_hash);
  const provenance = { roleSource: "builtin" as const, roleHash: ROLE_HASH, skillHashes };
  const trace_metadata = { role_resolved_hash: ROLE_HASH, skill_resolved_hashes: skillHashes };
  return {
    resolved: {
      role: {
        source: "builtin",
        resolved_hash: ROLE_HASH,
        metadata: {},
        spec: {
          name: roleName,
          description: "Direct",
          body: "Canonical role prompt",
          tools: ["read"],
          model: "gpt-5.4",
          sandbox: "read-only",
        },
      },
      skills,
      engine: "codex",
      model: "gpt-5.4",
      sessionMode,
      tool_intents: ["read"],
      sandbox: "read-only",
      env_policy,
      isolation: null,
      provenance,
      trace_metadata,
    },
    spawn: createSpawnOptionsProjection({
      engine: "codex",
      model: "gpt-5.4",
      sessionMode,
      rendered_prompt: "Canonical role prompt\n\n## Assigned Topic\n\nTopic\n",
      rendered_tools: ["read"],
      sandbox: "read-only",
      env_policy,
      isolation: null,
      provenance,
      trace_metadata,
    }),
  };
}

class FakeAdapter implements EngineSessionAdapter {
  readonly starts: EngineSessionRequest[] = [];
  readonly terminated: string[] = [];
  readonly reconciliations: HistoryReconcileRequest[] = [];
  ambiguous = false;
  evidenceRef: string | undefined;
  nativeSessionId: string | undefined;
  chunks = ["delta:attempt"];
  output = "answer";

  start(request: EngineSessionRequest) {
    this.starts.push(request);
    request.onLifecycle?.("requested");
    request.onLifecycle?.("dispatched");
    request.onLifecycle?.("acknowledged");
    for (const content of this.chunks) request.onChunk?.({ stream: "stdout", content });
    request.onLifecycle?.(this.ambiguous ? "ambiguous" : "completed");
    return {
      attemptId: request.attemptId,
      completion: Promise.resolve({
        ...completed(request.attemptId),
        output: this.output,
        state: this.ambiguous ? ("ambiguous" as const) : ("completed" as const),
        ok: !this.ambiguous,
      }),
      terminate: async (reason?: string) => {
        this.terminated.push(`${request.attemptId}:${reason ?? ""}`);
      },
      readResumeBinding: () =>
        this.nativeSessionId
          ? {
              attemptId: request.attemptId,
              engine: "codex" as const,
              nativeSessionId: this.nativeSessionId,
            }
          : undefined,
      readEvidenceBinding: () =>
        this.evidenceRef
          ? { attemptId: request.attemptId, internalRef: this.evidenceRef }
          : undefined,
    };
  }

  async reconcileHistory(request: HistoryReconcileRequest) {
    this.reconciliations.push(request);
    return {
      status: "unavailable" as const,
      imported_turn_count: 0,
      imported_tool_count: 0,
      completeness_reason: "fake",
    };
  }
}

class TerminateLifecycleAdapter implements EngineSessionAdapter {
  readonly starts: EngineSessionRequest[] = [];
  readonly terminated: string[] = [];
  private releaseLifecycle!: () => void;
  private readonly lifecycleGate = new Promise<void>((resolve) => {
    this.releaseLifecycle = resolve;
  });

  reportTerminationLifecycle(): void {
    this.releaseLifecycle();
  }

  start(request: EngineSessionRequest) {
    this.starts.push(request);
    let complete!: (result: EngineSessionResult) => void;
    const completion = new Promise<EngineSessionResult>((resolve) => {
      complete = resolve;
    });
    request.onLifecycle?.("requested");
    request.onLifecycle?.("dispatched");
    request.onLifecycle?.("acknowledged");
    return {
      attemptId: request.attemptId,
      completion,
      terminate: async (reason?: string) => {
        this.terminated.push(`${request.attemptId}:${reason ?? ""}`);
        complete({ ...completed(request.attemptId), ok: false, state: "ambiguous" });
        void this.lifecycleGate.then(() => {
          request.onLifecycle?.("ambiguous");
        });
      },
      readResumeBinding: () => undefined,
      readEvidenceBinding: () => undefined,
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

class ManualChunkAdapter implements EngineSessionAdapter {
  readonly starts: EngineSessionRequest[] = [];
  private readonly completeAttempt: Array<(result: EngineSessionResult) => void> = [];

  start(request: EngineSessionRequest) {
    this.starts.push(request);
    let complete!: (result: EngineSessionResult) => void;
    const completion = new Promise<EngineSessionResult>((resolve) => {
      complete = resolve;
    });
    this.completeAttempt.push(complete);
    return {
      attemptId: request.attemptId,
      completion,
      terminate: async () => complete({ ...completed(request.attemptId), ok: false }),
      readResumeBinding: () => undefined,
      readEvidenceBinding: () => undefined,
    };
  }

  emit(index: number, content: string): void {
    this.starts[index]?.onChunk?.({ stream: "stdout", content });
  }

  complete(index: number): void {
    const request = this.starts[index];
    if (request) this.completeAttempt[index]?.(completed(request.attemptId));
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

class OrderedResumeAdapter implements EngineSessionAdapter {
  readonly starts: EngineSessionRequest[] = [];
  readonly reconciliations: HistoryReconcileRequest[] = [];
  private readonly completions = new Map<string, (result: EngineSessionResult) => void>();

  start(request: EngineSessionRequest) {
    this.starts.push(request);
    request.onLifecycle?.("requested");
    const completion = new Promise<EngineSessionResult>((resolve) => {
      this.completions.set(request.attemptId, resolve);
    });
    return {
      attemptId: request.attemptId,
      completion,
      terminate: async () => {
        this.complete(request.attemptId);
      },
      readResumeBinding: () => ({
        attemptId: request.attemptId,
        engine: "codex" as const,
        nativeSessionId: `00000000-0000-4000-8000-${request.attemptId.endsWith("2") ? "000000000002" : "000000000001"}`,
      }),
      readEvidenceBinding: () => undefined,
    };
  }

  complete(attemptId: string): void {
    this.completions.get(attemptId)?.(completed(attemptId));
    this.completions.delete(attemptId);
  }

  async reconcileHistory(request: HistoryReconcileRequest) {
    this.reconciliations.push(request);
    return {
      status: "unavailable" as const,
      imported_turn_count: 0,
      imported_tool_count: 0,
      completeness_reason: "not used",
    };
  }
}

const waitFor = async (check: () => boolean | Promise<boolean>) => {
  for (let index = 0; index < 100; index++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for test state");
};

async function harness<T extends EngineSessionAdapter = FakeAdapter>(
  policy: ConversationPolicy,
  adapter: T = new FakeAdapter() as unknown as T,
  wrapTraceStore: (store: TraceStore) => TraceStore = (store) => store,
  rehydrateBinding: () => Promise<MaterializedAgentBinding> = async () => materialized(),
  overrides: Partial<ConversationRuntimeOptions> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-runtime-"));
  const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
  let event = 0;
  const traceStore = new TraceStore({
    dir: join(root, "trace"),
    artifactRegistry: artifacts,
    eventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, "0")}`,
    now: () => "2026-08-22T00:00:00.000Z",
  });
  const counters = new Map<string, number>();
  const runtime = new ConversationOrchestrator({
    traceStore: wrapTraceStore(traceStore),
    artifactRegistry: artifacts,
    artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
    sessionAdapter: adapter,
    policies: new ConversationPolicyRegistry([policy]),
    id: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      return `${kind}-${next}`;
    },
    now: () => "2026-08-22T00:00:00.000Z",
    rehydrateBinding,
    ...overrides,
  });
  return { root, runtime, traceStore, adapter };
}

const createInput = (
  policy: string,
  count = 1,
  withSkill = false,
  options: { roles?: string[]; sessionMode?: "exact" | "replay" | "fresh" } = {},
) => ({
  topic: "Topic",
  policy,
  maxRounds: 1,
  repoRoot: process.cwd(),
  phase: 1,
  bindings: Array.from({ length: count }, (_, index) => ({
    participantId: `participant-${index + 1}`,
    input: { ...input, sessionMode: options.sessionMode ?? "fresh" },
    materialized: materialized(withSkill, {
      roleName: options.roles?.[index],
      sessionMode: options.sessionMode,
    }),
  })),
});

const completed = (attemptId = "runtime-attempt"): EngineSessionResult => ({
  attemptId,
  engine: "codex",
  ok: true,
  state: "completed",
  lifecycle: ["requested", "dispatched", "acknowledged", "completed"],
  output: "answer",
  evidenceStatus: "persisted",
  nativeSessionStatus: "unavailable",
});

test("policy registry rejects duplicate names and never falls back for unknown policy", () => {
  const policy = {
    name: "direct",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "completed" as const,
        artifact_refs: [],
      };
    },
  } satisfies ConversationPolicy;
  expect(() => new ConversationPolicyRegistry([policy, policy])).toThrow("duplicate policy");
  const registry = new ConversationPolicyRegistry([policy]);
  expect(registry.require("direct")).toBe(policy);
  expect(() => registry.require("missing")).toThrow("unknown conversation policy");
});

test("start rejects an unknown policy before persisting conversation existence", async () => {
  const { root, runtime } = await harness(new DirectConversationPolicy());
  try {
    await expect(runtime.start(createInput("missing"))).rejects.toThrow(
      "unknown conversation policy",
    );
    expect(await runtime.events("conversation-1", 0)).toBeNull();
    expect(
      new ConversationArtifactStore({ dir: join(root, "manifests") }).read("conversation-1"),
    ).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct policy uses the canonical participant id and launchAttempt exactly once", async () => {
  const requests: PolicyAttemptRequest[] = [];
  const emissions: unknown[] = [];
  const context = {
    correlation: Object.freeze({
      workflow_id: "workflow",
      conversation_id: "conversation",
      revision_id: "revision",
      run_id: "run",
      turn_id: "turn",
      operation_id: "operation",
      attempt_id: "coordinator",
    }),
    topic: "Explain the tradeoff",
    policy: "direct",
    bindings: [materialized().resolved],
    participantIds: Object.freeze(["custom-participant"]),
    bindingReadiness: Object.freeze([{ engine_available: true, model_valid: true }]),
    signal: new AbortController().signal,
    messages: () => Promise.resolve(Object.freeze([])),
    async emit() {
      throw new Error("direct policy should not append raw response events");
    },
    launchAttempt(request: PolicyAttemptRequest) {
      requests.push(request);
      return {
        ref: "opaque-runtime-ref" as never,
        completion: Promise.resolve(completed()),
        async emit(emission: PolicyEmission) {
          emissions.push(emission);
          return {} as never;
        },
        onChunk(listener: (chunk: { stream: "stdout"; content: string }) => void) {
          listener({ stream: "stdout", content: "answer" });
          return () => {};
        },
      };
    },
  } as unknown as ConversationContext;

  const policy = new DirectConversationPolicy();
  expect((await policy.dryRun(context)).participants[0]?.participant_id).toBe("custom-participant");
  const output = await policy.execute(context);
  expect(requests).toEqual([
    {
      participantId: "custom-participant",
      bindingIndex: 0,
      purpose: "direct",
      promptInput: "Explain the tradeoff",
    },
  ]);
  expect(output).toEqual({ operation_id: "operation", status: "completed", artifact_refs: [] });
  expect(emissions).toEqual([
    {
      idempotency_key: "direct:operation:chunk:0",
      event: {
        type: "agent_response_delta",
        payload: {
          round_id: "direct:operation",
          participant_id: "custom-participant",
          content_delta: "answer",
          final_claim: null,
          final_evidence: [],
          completes_response: false,
        },
      },
    },
    {
      idempotency_key: "direct:operation:complete",
      event: {
        type: "agent_response_delta",
        payload: {
          round_id: "direct:operation",
          participant_id: "custom-participant",
          content_delta: "",
          final_claim: "answer",
          final_evidence: [],
          completes_response: true,
        },
      },
    },
  ]);
});

test("unknown conversation reads return null without creating an empty journal", async () => {
  const { root, runtime } = await harness(new DirectConversationPolicy());
  try {
    expect(await runtime.snapshot("missing")).toBeNull();
    expect(await runtime.events("missing", 0)).toBeNull();
    expect(runtime.subscribe("missing", () => {})).toBeNull();
    expect(existsSync(traceJournalPath(join(root, "trace"), "missing"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context maps max rounds and private baseline/evaluator configuration defaults", async () => {
  const observed: Array<{
    maxRounds: unknown;
    baselineEnabled: unknown;
    evaluatorAutoAdded: unknown;
  }> = [];
  const policy: ConversationPolicy = {
    name: "private-config",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      observed.push({
        maxRounds: context.maxRounds,
        baselineEnabled: context.baselineEnabled,
        evaluatorAutoAdded: context.evaluatorAutoAdded,
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    const service = runtime as unknown as {
      create(
        input: ReturnType<typeof createInput>,
        options?: { baselineEnabled?: boolean },
      ): Promise<unknown>;
    };
    const first = createInput("private-config");
    first.maxRounds = 4;
    Object.assign(first, { evaluatorAutoAdded: true });
    await service.create(first, { baselineEnabled: false });
    await service.create(createInput("private-config"));
    expect(observed).toEqual([
      { maxRounds: 4, baselineEnabled: false, evaluatorAutoAdded: true },
      { maxRounds: 1, baselineEnabled: true, evaluatorAutoAdded: false },
    ]);
    const store = new ConversationArtifactStore({ dir: join(root, "manifests") });
    expect(store.read("conversation-1")).toMatchObject({
      baseline_enabled: false,
      evaluator_auto_added: true,
    });
    expect(store.read("conversation-2")).toMatchObject({
      baseline_enabled: true,
      evaluator_auto_added: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service dryRun uses canonical read-only context without durable or engine effects", async () => {
  let preview!: ConversationContext;
  let executeCalls = 0;
  const expected: DryRunResult = {
    participants: [],
    evaluator_auto_added: false,
    engines_available: [],
    models_valid: true,
  };
  const policy: ConversationPolicy = {
    name: "preview",
    async dryRun(context) {
      preview = context;
      return expected;
    },
    async execute(context) {
      executeCalls += 1;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  const { root, runtime } = await harness(policy, adapter);
  try {
    const service = runtime as unknown as {
      dryRun(
        input: ReturnType<typeof createInput>,
        options?: { baselineEnabled?: boolean },
      ): Promise<typeof expected>;
    };
    const request = createInput("preview");
    request.maxRounds = 5;
    Object.assign(request, { evaluatorAutoAdded: true });
    expect(await service.dryRun(request, { baselineEnabled: false })).toEqual(expected);
    expect(
      preview as unknown as {
        maxRounds: number;
        baselineEnabled: boolean;
        evaluatorAutoAdded: boolean;
      },
    ).toMatchObject({ maxRounds: 5, baselineEnabled: false, evaluatorAutoAdded: true });
    expect(() =>
      preview.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "forbidden",
      }),
    ).toThrow("dry-run");
    await expect(
      preview.createArtifact({
        artifact_type: "synthesis",
        content: "forbidden",
        idempotency_key: "preview:artifact",
      }),
    ).rejects.toThrow("dry-run");
    expect({ executeCalls, starts: adapter.starts.length }).toEqual({ executeCalls: 0, starts: 0 });
    expect(await runtime.events("conversation-1", 0)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dryRun returns only an immutable validated public result", async () => {
  const valid: DryRunResult = {
    participants: [
      {
        participant_id: "participant-1",
        role_ref: "direct",
        engine: "codex",
        model: "gpt-5.4",
        engine_available: true,
        model_valid: true,
      },
    ],
    evaluator_auto_added: false,
    engines_available: ["codex"],
    models_valid: true,
  };
  let candidate: unknown = valid;
  const policy: ConversationPolicy = {
    name: "bounded-preview",
    async dryRun() {
      return candidate as DryRunResult;
    },
    async execute(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "failed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    const projected = await runtime.dryRun(createInput("bounded-preview"));
    expect(projected).toEqual(valid);
    expect(projected).not.toBe(valid);
    expect(Object.isFrozen(projected)).toBe(true);
    expect(Object.isFrozen(projected.participants)).toBe(true);
    expect(Object.isFrozen(projected.participants[0])).toBe(true);
    const validParticipant = valid.participants[0];
    if (!validParticipant) throw new Error("test participant missing");
    validParticipant.participant_id = "mutated";
    expect(projected.participants[0]?.participant_id).toBe("participant-1");

    for (const model of ["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"]) {
      candidate = {
        ...valid,
        participants: [{ ...valid.participants[0], model }],
      };
      expect((await runtime.dryRun(createInput("bounded-preview"))).participants[0]?.model).toBe(
        model,
      );
    }

    for (const model of [
      "provider//model",
      "../private/model",
      "src/secret/model",
      "provider/..hidden",
    ]) {
      candidate = {
        ...valid,
        participants: [{ ...valid.participants[0], model }],
      };
      await expect(runtime.dryRun(createInput("bounded-preview"))).rejects.toThrow(
        "invalid dry-run policy result",
      );
    }

    candidate = { ...valid, private_native_id: "forbidden" };
    await expect(runtime.dryRun(createInput("bounded-preview"))).rejects.toThrow(
      "invalid dry-run policy result",
    );
    candidate = Object.defineProperties(
      {},
      {
        participants: { enumerable: true, value: [] },
        evaluator_auto_added: { enumerable: true, value: false },
        engines_available: {
          enumerable: true,
          get() {
            throw new Error("hostile dry-run getter escaped");
          },
        },
        models_valid: { enumerable: true, value: true },
      },
    );
    await expect(runtime.dryRun(createInput("bounded-preview"))).rejects.toThrow(
      "invalid dry-run policy result",
    );
    const credentialShapedModel = "provider/sk-abcdefghijklmnopqrstuvwxyz1234567890";
    candidate = {
      participants: [
        {
          participant_id: "participant-1",
          role_ref: "direct",
          engine: "codex",
          model: credentialShapedModel,
          engine_available: true,
          model_valid: false,
        },
      ],
      evaluator_auto_added: false,
      engines_available: ["codex"],
      models_valid: false,
    };
    const invalidModel = await runtime.dryRun(createInput("bounded-preview"));
    expect(invalidModel.participants[0]?.model).toBeNull();
    expect(JSON.stringify(invalidModel)).not.toContain(credentialShapedModel);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("create snapshots public resolution, invocation options, and direct bindings before await", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const observed: Array<{ topic: string; baseline: boolean; participant: string }> = [];
  const policy: ConversationPolicy = {
    name: "snapshot-create",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      observed.push({
        topic: context.topic,
        baseline: context.baselineEnabled,
        participant: context.participantIds[0] ?? "",
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    {
      async resolveCreateRequest(request) {
        await gate;
        return { ...createInput("snapshot-create"), topic: request.topic };
      },
    },
  );
  try {
    const request: ConversationCreateRequest = { topic: "original", policy: "snapshot-create" };
    const options = { baselineEnabled: false };
    const pending = runtime.create(request, options);
    request.topic = "mutated";
    options.baselineEnabled = true;
    release();
    await pending;

    const direct = createInput("snapshot-create");
    const directPending = runtime.create(direct, { baselineEnabled: false });
    const directBinding = direct.bindings[0];
    if (!directBinding) throw new Error("test binding missing");
    direct.bindings[0] = { ...directBinding, participantId: "forged" };
    await directPending;
    expect(observed).toEqual([
      { topic: "original", baseline: false, participant: "participant-1" },
      { topic: "Topic", baseline: false, participant: "participant-1" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid materialized startup authority leaves no manifest or live operation", async () => {
  const { root, runtime } = await harness(new DirectConversationPolicy());
  try {
    const request = createInput("direct");
    const binding = request.bindings[0];
    if (!binding) throw new Error("test binding missing");
    const original = binding.materialized;
    request.bindings[0] = {
      ...binding,
      materialized: {
        ...original,
        resolved: { ...original.resolved, model: "forged-model" },
      },
    };
    await expect(runtime.start(request)).rejects.toThrow("materialized binding authority mismatch");
    expect(await runtime.events("conversation-1", 0)).toBeNull();
    expect(
      new ConversationArtifactStore({ dir: join(root, "manifests") }).read("conversation-1"),
    ).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start returns a durable accepted conversation before background policy completion", async () => {
  let release!: () => void;
  let executing = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "accepted-start",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      executing = true;
      await gate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    const service = runtime as unknown as {
      start(input: ReturnType<typeof createInput>): Promise<{
        conversation_id: string;
        revision_id: string;
        operation_id: string;
        completion: Promise<{ result: { status: string } }>;
      }>;
    };
    const accepted = await service.start(createInput("accepted-start"));
    expect(executing).toBe(false);
    expect(accepted).toMatchObject({
      conversation_id: "conversation-1",
      revision_id: "revision-1",
      operation_id: "operation-1",
    });
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ACTIVE");
    await waitFor(() => executing);
    let completed = false;
    void accepted.completion.then(() => {
      completed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    release();
    expect((await accepted.completion).result.status).toBe("completed");
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("configure failure rejects start and releases its live operation authority", async () => {
  let executeCalls = 0;
  const policy: ConversationPolicy = {
    name: "configure-failure",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      executeCalls += 1;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy, new FakeAdapter(), (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: (correlation, input, native) =>
      input.event.type === "participant_bound"
        ? Promise.reject(new Error("injected configure failure"))
        : store.append(correlation, input, native),
  }));
  try {
    const service = runtime as unknown as {
      start(input: ReturnType<typeof createInput>): Promise<unknown>;
      runtime: { operationId(id: string): string | null };
    };
    const partial = createInput("configure-failure");
    partial.topic = "ghp_topic_abcdefghijklmnopqrstuvwxyz1234567890";
    await expect(service.start(partial)).rejects.toThrow("injected configure failure");
    expect({ executeCalls, operationId: service.runtime.operationId("conversation-1") }).toEqual({
      executeCalls: 0,
      operationId: null,
    });
    expect(
      await runtime.cancelOperation({
        conversation_id: "conversation-1",
        operation_id: "operation-1",
        actor: "user",
        reason: null,
      }),
    ).toEqual({ status: 409, body: { code: "operation_not_cancellable" } });
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("INIT");
    expect(await runtime.stop("conversation-1")).toEqual({
      stopped: true,
      terminal_state: "STOPPED",
    });
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("STOPPED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a zero-trace manifest is stoppable without projecting any private manifest field", async () => {
  const { root, runtime } = await harness(new DirectConversationPolicy());
  try {
    const secrets = {
      topic: "ghp_topic_abcdefghijklmnopqrstuvwxyz1234567890",
      participant: "sk-participant-abcdefghijklmnopqrstuvwxyz1234567890",
      role: "/private/roles/secret-reviewer.md",
      model: "provider/sk-model-abcdefghijklmnopqrstuvwxyz1234567890",
      repo: "/private/repos/secret-project",
    };
    new ConversationArtifactStore({ dir: join(root, "manifests") }).create(
      {
        version: "1.0",
        conversation_id: "conversation-1",
        workflow_id: "workflow-1",
        revision_id: "revision-1",
        run_id: "run-1",
        parent_conversation_id: null,
        parent_revision_id: null,
        topic: secrets.topic,
        policy: "direct",
        max_rounds: 1,
        baseline_enabled: true,
        evaluator_auto_added: false,
        repo_root: secrets.repo,
        phase: 1,
        task_text: secrets.topic,
        bindings: [
          {
            participant_id: secrets.participant,
            input: { roleRef: secrets.role, engine: "codex", sessionMode: "fresh" },
          },
        ],
        created_at: "2026-08-22T00:00:00.000Z",
      },
      [
        {
          participant_id: secrets.participant,
          engine: "codex",
          model: secrets.model,
          session_mode: "fresh",
          role_source: "builtin",
          role_hash: ROLE_HASH,
          skill_hashes: [],
        },
      ],
    );
    expect(await runtime.snapshot("conversation-1")).toBeNull();
    expect(JSON.stringify(await runtime.snapshot("conversation-1"))).not.toContain("private");
    expect(await runtime.stop("conversation-1")).toEqual({
      stopped: true,
      terminal_state: "STOPPED",
    });
    const events = await runtime.events("conversation-1", 0);
    expect(events?.[0]?.event.type).toBe("conversation_configured");
    expect(
      events?.some(({ event }) => event.type === "state_change" && !event.payload.terminal),
    ).toBe(false);
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("STOPPED");
    const publicJson = JSON.stringify({
      events,
      snapshot: await runtime.snapshot("conversation-1"),
    });
    for (const secret of Object.values(secrets)) expect(publicJson).not.toContain(secret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted completion cannot contradict a concurrent durable STOPPED terminal", async () => {
  let release!: () => void;
  let executing = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "ignore-stop",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      executing = true;
      await gate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy);
  try {
    const service = runtime as unknown as {
      start(input: ReturnType<typeof createInput>): Promise<{
        conversation_id: string;
        completion: Promise<{ result: { status: string } }>;
      }>;
    };
    const accepted = await service.start(createInput("ignore-stop"));
    expect(executing).toBe(false);
    await waitFor(() => executing);
    await runtime.stop(accepted.conversation_id);
    const stoppedLength = (await traceStore.readConversation(accepted.conversation_id)).length;
    release();
    expect((await accepted.completion).result.status).toBe("aborted");
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("STOPPED");
    expect((await traceStore.readConversation(accepted.conversation_id)).length).toBe(
      stoppedLength,
    );
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("awaiting approval cannot escape a terminal reserved after its ACTIVE snapshot", async () => {
  const policy: ConversationPolicy = {
    name: "awaiting-stop-race",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  const authority = (
    runtime as unknown as {
      runtime: { snapshot(id: string): ReturnType<ConversationOrchestrator["snapshot"]> };
    }
  ).runtime;
  const snapshot = authority.snapshot.bind(authority);
  let captured!: () => void;
  let release!: () => void;
  const capturedSnapshot = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const terminalGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let block = true;
  authority.snapshot = async (id) => {
    const value = await snapshot(id);
    if (block && value?.lifecycle === "ACTIVE") {
      block = false;
      captured();
      await terminalGate;
    }
    return value;
  };
  try {
    const accepted = await runtime.start(createInput("awaiting-stop-race"));
    await capturedSnapshot;
    await runtime.stop(accepted.conversation_id);
    release();
    expect((await accepted.completion).result.status).toBe("aborted");
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("STOPPED");
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable caller cancellation dominates an abort-ignoring policy completion", async () => {
  let release!: () => void;
  let context!: ConversationContext;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "cancel-dominates",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      await gate;
      return {
        operation_id: value.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  const { root, runtime } = await harness(policy, adapter);
  try {
    const accepted = await runtime.start(createInput("cancel-dominates"));
    await waitFor(() => context !== undefined);
    expect(
      await runtime.cancelOperation({
        conversation_id: accepted.conversation_id,
        operation_id: accepted.operation_id,
        actor: "user",
        reason: "cancel",
      }),
    ).toMatchObject({ status: 202 });
    expect(() =>
      context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "too late",
      }),
    ).toThrow("closed");
    expect(adapter.starts).toHaveLength(0);
    release();
    expect((await accepted.completion).result.status).toBe("aborted");
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ABORTED");
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed cancellation append cannot override a concurrent valid completion", async () => {
  let releasePolicy!: () => void;
  let rejectCancellation!: () => void;
  let cancellationStarted!: () => void;
  const policyGate = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  const cancellationGate = new Promise<void>((resolve) => {
    rejectCancellation = resolve;
  });
  const cancellationAppend = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  let ownerContext: ConversationContext | null = null;
  const policy: ConversationPolicy = {
    name: "failed-cancel-race",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      ownerContext = context;
      await policyGate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy, new FakeAdapter(), (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: async (correlation, emission, native) => {
      if (emission.event.type === "caller_cancelled") {
        cancellationStarted();
        await cancellationGate;
        throw new Error("injected cancellation append failure");
      }
      return store.append(correlation, emission, native);
    },
  }));
  const authority = (runtime as unknown as { runtime: ConversationRuntime }).runtime;
  const terminal = authority.terminal.bind(authority);
  let terminalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    terminalEntered = resolve;
  });
  const terminalSpy = spyOn(authority, "terminal").mockImplementation((...args) => {
    terminalEntered();
    return terminal(...args);
  });
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await waitFor(() => ownerContext !== null);
    const cancellation = runtime.cancelOperation({
      conversation_id: accepted.conversation_id,
      operation_id: accepted.operation_id,
      actor: "user",
      reason: "must fail",
    });
    await cancellationAppend;
    releasePolicy();
    await entered;
    rejectCancellation();
    await expect(cancellation).rejects.toThrow("injected cancellation append failure");
    expect((await accepted.completion).result.status).toBe("completed");
    const captured = ownerContext as unknown as ConversationContext | null;
    if (!captured) throw new Error("owner context missing");
    expect(captured.signal.reason).toBe("conversation terminal");
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("COMPLETED");
  } finally {
    terminalSpy.mockRestore();
    releasePolicy();
    rejectCancellation();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed PAUSED cancellation preserves deferred work and buffered active chunks", async () => {
  let context!: ConversationContext;
  let releasePolicy!: () => void;
  const policyGate = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  const chunks: string[] = [];
  const policy: ConversationPolicy = {
    name: "cancel-rollback-buffer",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      const active = value.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "stay live across failed cancel",
      });
      active.onChunk((chunk) => chunks.push(chunk.content));
      await policyGate;
      await active.completion;
      return {
        operation_id: value.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  let releaseCancellation!: () => void;
  const cancellationGate = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let cancellationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    cancellationStarted = resolve;
  });
  const adapter = new ManualChunkAdapter();
  const { root, runtime } = await harness(policy, adapter, (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: async (correlation, emission, native) => {
      if (emission.event.type === "caller_cancelled") {
        cancellationStarted();
        await cancellationGate;
        throw new Error("injected paused cancellation failure");
      }
      return store.append(correlation, emission, native);
    },
  }));
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await waitFor(() => adapter.starts.length === 1);
    await runtime.pause(accepted.conversation_id);
    let deferredSettled = false;
    const deferredEffect = context
      .emit({
        idempotency_key: "cancel-rollback:deferred-effect",
        event: {
          type: "baseline_result",
          payload: {
            status: "skipped",
            answer: null,
            confidence: null,
            skip_reason: "cancel rollback",
          },
        },
      })
      .finally(() => {
        deferredSettled = true;
      });
    const deferredAttempt = context.launchAttempt({
      participantId: "participant-1",
      bindingIndex: 0,
      purpose: "direct",
      promptInput: "start after rollback and resume",
    });
    const cancellation = runtime.cancelOperation({
      conversation_id: accepted.conversation_id,
      operation_id: accepted.operation_id,
      actor: "user",
      reason: "must roll back",
    });
    await started;
    adapter.emit(0, "buffered-during-cancel");
    releaseCancellation();
    await expect(cancellation).rejects.toThrow("injected paused cancellation failure");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks).toEqual([]);
    expect(deferredSettled).toBe(false);
    expect(adapter.starts).toHaveLength(1);

    await runtime.resume(accepted.conversation_id);
    await waitFor(() => adapter.starts.length === 2 && chunks.length === 1);
    await deferredEffect;
    expect(chunks).toEqual(["buffered-during-cancel"]);
    adapter.complete(0);
    adapter.complete(1);
    await deferredAttempt.completion;
    releasePolicy();
    expect((await accepted.completion).result.status).toBe("completed");
  } finally {
    releaseCancellation();
    releasePolicy();
    adapter.complete(0);
    adapter.complete(1);
    await rm(root, { recursive: true, force: true });
  }
});

test("PAUSED operation cancellation journals once and terminates its preserved attempt", async () => {
  const adapter = new TerminateLifecycleAdapter();
  const { root, runtime } = await harness(new DirectConversationPolicy(), adapter);
  try {
    const accepted = await runtime.start(createInput("direct"));
    await waitFor(() => adapter.starts.length === 1);
    await runtime.pause(accepted.conversation_id);
    const cancelled = runtime.cancelOperation({
      conversation_id: accepted.conversation_id,
      operation_id: accepted.operation_id,
      actor: "user",
      reason: "cancel paused",
    });
    expect(
      await Promise.race([
        cancelled,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("cancel timed out")), 1000),
        ),
      ]),
    ).toMatchObject({ status: 202 });
    expect(adapter.terminated).toEqual(["attempt-1:cancel paused"]);
    expect(
      (
        await Promise.race([
          accepted.completion,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("completion timed out")), 1000),
          ),
        ])
      ).result.status,
    ).toBe("aborted");
    const events = await runtime.events(accepted.conversation_id, 0);
    expect(events?.filter((event) => event.event.type === "caller_cancelled")).toHaveLength(1);
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ABORTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy completion observed while PAUSED maps to durable ABORTED without a live leak", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "paused-completion",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await gate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    const accepted = await runtime.start(createInput("paused-completion"));
    await runtime.pause(accepted.conversation_id);
    release();
    expect((await accepted.completion).result.status).toBe("aborted");
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ABORTED");
    expect(
      await runtime.cancelOperation({
        conversation_id: accepted.conversation_id,
        operation_id: accepted.operation_id,
        actor: "user",
        reason: null,
      }),
    ).toEqual({ status: 409, body: { code: "operation_not_cancellable" } });
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["failed", "aborted"] as const)(
  "policy %s observed while PAUSED terminalizes legally",
  async (status) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy: ConversationPolicy = {
      name: `paused-${status}`,
      async dryRun() {
        return {
          participants: [],
          evaluator_auto_added: false,
          engines_available: [],
          models_valid: true,
        };
      },
      async execute(context) {
        await gate;
        return { operation_id: context.correlation.operation_id, status, artifact_refs: [] };
      },
    };
    const { root, runtime } = await harness(policy);
    try {
      const accepted = await runtime.start(createInput(policy.name));
      await runtime.pause(accepted.conversation_id);
      release();
      expect((await accepted.completion).result.status).toBe(status);
      expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe(
        status === "failed" ? "FAILED" : "ABORTED",
      );
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("terminal reservation atomically maps a stale ACTIVE completion after PAUSE to ABORTED", async () => {
  let release!: () => void;
  let releasePause!: () => void;
  let pauseStarted = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pauseGate = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  const policy: ConversationPolicy = {
    name: "pause-terminal-barrier",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await gate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy, new FakeAdapter(), (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: async (correlation, emission, native) => {
      if (emission.event.type === "state_change" && emission.event.payload.lifecycle === "PAUSED") {
        pauseStarted = true;
        await pauseGate;
      }
      return store.append(correlation, emission, native);
    },
  }));
  try {
    const accepted = await runtime.start(createInput("pause-terminal-barrier"));
    const pausing = runtime.pause(accepted.conversation_id);
    await waitFor(() => pauseStarted);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releasePause();
    await pausing;
    expect((await accepted.completion).result.status).toBe("aborted");
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ABORTED");
  } finally {
    release();
    releasePause();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime owns concurrent attempt correlation and resolves branded retry parents", async () => {
  const observedRefs: string[] = [];
  const policy: ConversationPolicy = {
    name: "parallel",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      const participantIds = (context as unknown as { participantIds: readonly string[] })
        .participantIds;
      expect(participantIds).toEqual(["participant-1", "participant-2", "participant-3"]);
      expect(Object.isFrozen(participantIds)).toBe(true);
      expect(() => {
        (context.correlation as { attempt_id: string }).attempt_id = "forged";
      }).toThrow();
      const first = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "participant",
        promptInput: "first",
      });
      const second = context.launchAttempt({
        participantId: "participant-2",
        bindingIndex: 1,
        purpose: "participant",
        promptInput: "second",
      });
      const evaluator = context.launchAttempt({
        participantId: "participant-3",
        bindingIndex: 2,
        purpose: "evaluator",
        promptInput: "evaluate",
      });
      const retry = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "participant",
        promptInput: "retry",
        parent: first.ref,
      });
      observedRefs.push(first.ref, second.ref, evaluator.ref, retry.ref);
      await Promise.all([
        first.completion,
        second.completion,
        evaluator.completion,
        retry.completion,
      ]);
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  const { root, runtime, traceStore } = await harness(policy, adapter);
  try {
    const created = await runtime.create(
      createInput("parallel", 3, false, {
        roles: ["brainstorm-participant", "brainstorm-skeptic", "brainstorm-evaluator"],
      }),
    );
    expect(adapter.starts).toHaveLength(4);
    expect(new Set(observedRefs).size).toBe(4);
    expect(
      adapter.starts.every((request) =>
        request.spawn.rendered_prompt.includes("Canonical role prompt"),
      ),
    ).toBe(true);
    const records = await traceStore.readConversation(created.conversation_id);
    expect(records[0]?.stored_event.event.type).toBe("conversation_configured");
    expect(
      records.some((record) => record.stored_event.event.type === "coordinator_decision"),
    ).toBe(true);
    expect(
      records.filter((record) => record.stored_event.event.type === "participant_bound"),
    ).toHaveLength(3);
    const attempts = records.filter(
      (record) => record.stored_event.event.type === "operation_lifecycle",
    );
    expect(new Set(attempts.map((record) => record.stored_event.attempt_id)).size).toBe(4);
    expect(attempts.every((record) => Boolean(record.stored_event.participant_id))).toBe(true);
    const retry = attempts.find((record) => record.stored_event.parent_attempt_id);
    expect(retry?.stored_event.parent_attempt_id).toBe(attempts[0]?.stored_event.attempt_id);
    expect(records.at(-2)?.stored_event.event).toMatchObject({
      type: "state_change",
      payload: { lifecycle: "COMPLETED", terminal: true },
    });
    expect(records.at(-1)?.stored_event.event).toMatchObject({
      type: "conversation_terminal",
      payload: { lifecycle: "COMPLETED", terminal: true },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime binds attempt purpose to role and isolates baseline/evaluator native history", async () => {
  const rejected: string[] = [];
  const policy: ConversationPolicy = {
    name: "purpose-authority",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      try {
        context.launchAttempt({
          participantId: "participant-1",
          bindingIndex: 0,
          purpose: "evaluator",
          promptInput: "forged evaluator",
        });
      } catch {
        rejected.push("evaluator-role");
      }
      for (const purpose of [
        "direct",
        "participant",
        "baseline",
        "plan",
        "review",
        "verify",
        "orchestrate",
      ] as const) {
        try {
          context.launchAttempt({
            participantId: "participant-2",
            bindingIndex: 1,
            purpose,
            promptInput: `forged ${purpose}`,
          });
        } catch {
          rejected.push(`${purpose}-role`);
        }
      }
      const baseline = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "baseline",
        promptInput: "isolated baseline",
      });
      const evaluator = context.launchAttempt({
        participantId: "participant-2",
        bindingIndex: 1,
        purpose: "evaluator",
        promptInput: "isolated evaluator",
      });
      await Promise.all([baseline.completion, evaluator.completion]);
      return {
        operation_id: context.correlation.operation_id,
        status: "failed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  adapter.nativeSessionId = "00000000-0000-4000-8000-000000000321";
  const { root, runtime } = await harness(policy, adapter);
  try {
    await runtime.create(
      createInput("purpose-authority", 2, false, {
        roles: ["brainstorm-participant", "brainstorm-evaluator"],
      }),
    );
    expect(rejected.sort()).toEqual([
      "baseline-role",
      "direct-role",
      "evaluator-role",
      "orchestrate-role",
      "participant-role",
      "plan-role",
      "review-role",
      "verify-role",
    ]);
    expect(adapter.starts).toHaveLength(2);
    expect(adapter.starts.map((request) => request.spawn.sessionMode)).toEqual(["fresh", "fresh"]);
    expect(adapter.starts.every((request) => request.nativeSessionId === undefined)).toBe(true);
    expect(
      new ConversationArtifactStore({ dir: join(root, "manifests") }).readRecord("conversation-1")
        ?.resume_bindings,
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy emitters reject forged system events and raw append methods are not exposed", async () => {
  const rejected = new Set<string>();
  const policy: ConversationPolicy = {
    name: "adversarial-emission",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      const coordinatorForgeries: Array<[string, PolicyEmission]> = [
        [
          "operation",
          {
            idempotency_key: "forged:operation",
            event: {
              type: "operation_lifecycle",
              payload: { operation_id: "forged", attempt_id: "forged", state: "completed" },
            },
          },
        ],
        [
          "state",
          {
            idempotency_key: "forged:state",
            event: {
              type: "state_change",
              payload: { lifecycle: "COMPLETED", health: "healthy", terminal: true, reason: null },
            },
          },
        ],
        [
          "terminal",
          {
            idempotency_key: "forged:terminal",
            event: {
              type: "conversation_terminal",
              payload: { lifecycle: "COMPLETED", terminal: true, final_score: null },
            },
          },
        ],
        [
          "approval-operation",
          {
            idempotency_key: "forged:approval-request",
            event: {
              type: "approval_requested",
              payload: {
                token: { approval_id: "approval", operation_id: "wrong", actor: "reviewer" },
                description: "forged operation",
              },
            },
          },
        ],
      ];
      for (const [name, emission] of coordinatorForgeries) {
        try {
          await context.emit(emission as never);
        } catch {
          rejected.add(`coordinator:${name}`);
        }
      }
      const attempt = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "safe",
      });
      await attempt.completion;
      const attemptForgeries: Array<[string, PolicyEmission]> = [
        [
          "approval",
          {
            idempotency_key: "forged:approval",
            event: {
              type: "approval_resolved",
              payload: {
                decision: {
                  approval_id: "forged",
                  operation_id: "forged",
                  actor: "forged",
                  outcome: "approve",
                  reason: null,
                },
              },
            },
          },
        ],
        [
          "precommit-participant",
          {
            idempotency_key: "forged:precommit",
            event: {
              type: "precommit",
              payload: {
                round_id: "round",
                participant_id: "participant-2",
                answer: "forged",
                evidence: [],
              },
            },
          },
        ],
        [
          "response-participant",
          {
            idempotency_key: "forged:response",
            event: {
              type: "agent_response_delta",
              payload: {
                round_id: "round",
                participant_id: "participant-2",
                content_delta: "forged",
                final_claim: null,
                final_evidence: [],
                completes_response: false,
              },
            },
          },
        ],
      ];
      for (const [name, emission] of attemptForgeries) {
        try {
          await attempt.emit(emission as never);
        } catch {
          rejected.add(`attempt:${name}`);
        }
      }
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    await runtime.create(createInput("adversarial-emission"));
    expect([...rejected].sort()).toEqual([
      "attempt:approval",
      "attempt:precommit-participant",
      "attempt:response-participant",
      "coordinator:approval-operation",
      "coordinator:operation",
      "coordinator:state",
      "coordinator:terminal",
    ]);
    const authority = (runtime as unknown as { runtime: object }).runtime;
    expect(["append", "appendDerived", "appendControl"].filter((key) => key in authority)).toEqual(
      [],
    );
    const events = await runtime.events("conversation-1", 0);
    expect(events?.some((event) => event.event.type === "approval_resolved")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed terminal records carry the last folded consensus score", async () => {
  const assessment = {
    agreement: { value: true, evidence: "agree" },
    conflict_resolution: { value: true, evidence: "resolved" },
    evidence_quality: { value: true, evidence: "strong" },
    convergence: { value: "not_applicable" as const, evidence: "round one" },
  };
  const policy: ConversationPolicy = {
    name: "debate",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await context.emit({
        idempotency_key: "round:start",
        event: { type: "round_boundary", payload: { round_id: "round-1", phase: "start" } },
      });
      const participants: Array<{
        participantId: string;
        attempt: ReturnType<ConversationContext["launchAttempt"]>;
      }> = [];
      for (let index = 0; index < 2; index++) {
        const participantId = `participant-${index + 1}`;
        const attempt = context.launchAttempt({
          participantId,
          bindingIndex: index,
          purpose: "participant",
          promptInput: participantId,
        });
        await attempt.completion;
        await attempt.emit({
          idempotency_key: `round:precommit:${participantId}`,
          event: {
            type: "precommit",
            payload: {
              round_id: "round-1",
              participant_id: participantId,
              answer: "a",
              evidence: [],
            },
          },
        });
        participants.push({ participantId, attempt });
      }
      const evaluator = context.launchAttempt({
        participantId: "participant-3",
        bindingIndex: 2,
        purpose: "evaluator",
        promptInput: "evaluate",
      });
      await evaluator.completion;
      await evaluator.emit({
        idempotency_key: "round:assessment:blind",
        event: {
          type: "evaluator_assessment",
          payload: { round_id: "round-1", stage: "blind", assessment },
        },
      });
      for (const { participantId, attempt } of participants) {
        await attempt.emit({
          idempotency_key: `round:response:${participantId}`,
          event: {
            type: "agent_response_delta",
            payload: {
              round_id: "round-1",
              participant_id: participantId,
              content_delta: "answer",
              final_claim: "answer",
              final_evidence: [],
              completes_response: true,
            },
          },
        });
      }
      await evaluator.emit({
        idempotency_key: "round:assessment:full",
        event: {
          type: "evaluator_assessment",
          payload: { round_id: "round-1", stage: "full", assessment },
        },
      });
      await context.emit({
        idempotency_key: "round:consensus",
        event: {
          type: "consensus_update",
          payload: { round_id: "round-1", decision: { outcome: "consensus", score: 1 } },
        },
      });
      await context.emit({
        idempotency_key: "round:end",
        event: { type: "round_boundary", payload: { round_id: "round-1", phase: "end" } },
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    await runtime.create(
      createInput("debate", 3, false, {
        roles: ["brainstorm-participant", "brainstorm-skeptic", "brainstorm-evaluator"],
      }),
    );
    const terminal = (await runtime.events("conversation-1", 0))?.find(
      (event) => event.event.type === "conversation_terminal",
    );
    expect(terminal?.event).toMatchObject({
      type: "conversation_terminal",
      payload: { lifecycle: "COMPLETED", final_score: 1 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriber replay/live race is ascending, deduped, and delivered only after durable append", async () => {
  let release!: () => void;
  let context!: ConversationContext;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "held",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      await gate;
      return {
        operation_id: value.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy);
  try {
    const create = runtime.create(createInput("held"));
    await waitFor(() => context !== undefined);
    const delivered: number[] = [];
    const durable: Promise<boolean>[] = [];
    const unsubscribe = runtime.subscribe(
      "conversation-1",
      (event) => {
        delivered.push(event.seq);
        durable.push(
          traceStore
            .readConversation("conversation-1")
            .then((records) => records.some((record) => record.stored_event.seq === event.seq)),
        );
      },
      0,
    );
    expect(unsubscribe).not.toBeNull();
    await runtime.message("conversation-1", { content: "live", target_participants: "all" });
    release();
    await create;
    await waitFor(() => delivered.length > 0 && delivered.at(-1) === Math.max(...delivered));
    expect(delivered).toEqual([...new Set(delivered)].sort((a, b) => a - b));
    expect((await Promise.all(durable)).every(Boolean)).toBe(true);
    unsubscribe?.();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an admitted message completes before a concurrent STOPPED terminal pair", async () => {
  let context!: ConversationContext;
  let messageStarted = false;
  let releaseMessage!: () => void;
  const messageGate = new Promise<void>((resolve) => {
    releaseMessage = resolve;
  });
  const policy: ConversationPolicy = {
    name: "message-stop-race",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      await new Promise<void>((resolve) =>
        value.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { operation_id: value.correlation.operation_id, status: "aborted", artifact_refs: [] };
    },
  };
  const { root, runtime, traceStore } = await harness(policy, new FakeAdapter(), (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: async (correlation, emission, native) => {
      if (emission.event.type === "user_message") {
        messageStarted = true;
        await messageGate;
      }
      return store.append(correlation, emission, native);
    },
  }));
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await waitFor(() => context !== undefined);
    const message = runtime.message(accepted.conversation_id, {
      content: "admitted before stop",
      target_participants: "all",
    });
    await waitFor(() => messageStarted);
    const stopped = runtime.stop(accepted.conversation_id);
    releaseMessage();
    await Promise.all([message, stopped, accepted.completion]);
    const records = await traceStore.readConversation(accepted.conversation_id);
    const types = records.map(({ stored_event: stored }) => stored.event.type);
    const messageIndex = types.indexOf("user_message");
    const stateIndex = types.lastIndexOf("state_change");
    expect(messageIndex).toBeGreaterThan(-1);
    expect(messageIndex).toBeLessThan(stateIndex);
    expect(types.slice(stateIndex)).toEqual(["state_change", "conversation_terminal"]);
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("STOPPED");
  } finally {
    releaseMessage();
    await rm(root, { recursive: true, force: true });
  }
});

test("operation cancel validates identity, journals once, then aborts only its operation", async () => {
  let context!: ConversationContext;
  const policy: ConversationPolicy = {
    name: "cancel",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      value.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "wait",
      });
      await new Promise<void>((resolve) =>
        value.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { operation_id: value.correlation.operation_id, status: "aborted", artifact_refs: [] };
    },
  };
  const adapter = new TerminateLifecycleAdapter();
  const { root, runtime, traceStore } = await harness(policy, adapter);
  try {
    const creating = runtime.create(createInput("cancel"));
    await waitFor(() => context !== undefined);
    expect(
      await runtime.cancelOperation({
        conversation_id: "other",
        operation_id: context.correlation.operation_id,
        actor: "user",
        reason: null,
      }),
    ).toEqual({ status: 409, body: { code: "operation_conversation_mismatch" } });
    const command = {
      conversation_id: "conversation-1",
      operation_id: context.correlation.operation_id,
      actor: "user",
      reason: "stop attempt",
    };
    const canonicalCommand = { ...command };
    const cancelling = runtime.cancelOperation(command);
    Reflect.set(command, "conversation_id", "forged-conversation");
    Reflect.set(command, "reason", "forged reason");
    expect(await cancelling).toEqual({
      status: 202,
      body: { operation_id: context.correlation.operation_id, cancelled: true },
    });
    expect(await runtime.cancelOperation(canonicalCommand)).toEqual({
      status: 409,
      body: { code: "operation_not_cancellable" },
    });
    await creating;
    const records = await traceStore.readConversation("conversation-1");
    expect(
      records.filter((record) => record.stored_event.event.type === "caller_cancelled"),
    ).toHaveLength(1);
    expect(adapter.terminated).toEqual(["attempt-1:stop attempt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed operations release attempts and reject post-terminal cancellation", async () => {
  const adapter = new FakeAdapter();
  const { root, runtime, traceStore } = await harness(new DirectConversationPolicy(), adapter);
  try {
    const created = await runtime.create(createInput("direct"));
    expect(
      await runtime.cancelOperation({
        conversation_id: created.conversation_id,
        operation_id: created.result.operation_id,
        actor: "user",
        reason: "too late",
      }),
    ).toEqual({ status: 409, body: { code: "operation_not_cancellable" } });
    expect(adapter.terminated).toEqual([]);
    expect(
      (await traceStore.readConversation(created.conversation_id)).filter(
        (record) => record.stored_event.event.type === "caller_cancelled",
      ),
    ).toEqual([]);
    expect((await runtime.snapshot(created.conversation_id))?.lifecycle).toBe("COMPLETED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("STOPPED terminal closes attempt emissions before terminate reports ambiguous", async () => {
  let context!: ConversationContext;
  const policy: ConversationPolicy = {
    name: "stop-lifecycle-race",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      value.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "wait for stop",
      });
      await new Promise<void>((resolve) =>
        value.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { operation_id: value.correlation.operation_id, status: "aborted", artifact_refs: [] };
    },
  };
  const adapter = new TerminateLifecycleAdapter();
  const { root, runtime, traceStore } = await harness(policy, adapter);
  try {
    const creating = runtime.create(createInput("stop-lifecycle-race"));
    await waitFor(() => context !== undefined && adapter.starts.length === 1);
    expect(await runtime.stop("conversation-1")).toEqual({
      stopped: true,
      terminal_state: "STOPPED",
    });
    await creating;
    const stopped = await traceStore.readConversation("conversation-1");
    const length = stopped.length;
    expect(stopped.at(-1)?.stored_event.event).toMatchObject({
      type: "conversation_terminal",
      payload: { lifecycle: "STOPPED" },
    });
    adapter.reportTerminationLifecycle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await traceStore.readConversation("conversation-1")).length).toBe(length);
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("STOPPED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("captured policy authority cannot start an orphan attempt after terminal", async () => {
  let captured!: ConversationContext;
  const policy: ConversationPolicy = {
    name: "captured-terminal-context",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      captured = context;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  const { root, runtime } = await harness(policy, adapter);
  try {
    await runtime.create(createInput("captured-terminal-context"));
    expect(() =>
      captured.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "must not start",
      }),
    ).toThrow("closed");
    expect(adapter.starts).toHaveLength(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal settlement terminates an unawaited live attempt exactly once", async () => {
  const policy: ConversationPolicy = {
    name: "unawaited-attempt",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "orphan candidate",
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new TerminateLifecycleAdapter();
  const { root, runtime, traceStore } = await harness(policy, adapter);
  try {
    await runtime.create(createInput("unawaited-attempt"));
    expect(adapter.terminated).toHaveLength(1);
    const before = (await traceStore.readConversation("conversation-1")).length;
    adapter.reportTerminationLifecycle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.terminated).toHaveLength(1);
    expect((await traceStore.readConversation("conversation-1")).length).toBe(before);
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("COMPLETED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy receives an immutable binding snapshot distinct from launch authority", async () => {
  const policy: ConversationPolicy = {
    name: "immutable-policy-binding",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      const exposed = context.bindings[0] as unknown as {
        engine: string;
        role: { resolved_hash: string; spec: { name: string } };
      };
      Reflect.set(exposed, "engine", "claude");
      Reflect.set(exposed.role, "resolved_hash", "c".repeat(64));
      Reflect.set(exposed.role.spec, "name", "forged-role");
      const attempt = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "canonical authority",
      });
      await attempt.completion;
      await attempt.emit({
        idempotency_key: "immutable-binding:tool",
        event: {
          type: "tool_action",
          payload: {
            tool: "read",
            action: "inspect",
            status: "completed",
            input_ref: null,
            output_ref: null,
          },
        },
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  const { root, runtime } = await harness(policy, adapter);
  try {
    const created = await runtime.create(createInput("immutable-policy-binding"));
    expect(created.result.status).toBe("completed");
    expect(adapter.starts[0]?.spawn.engine).toBe("codex");
    const tool = (await runtime.events("conversation-1", 0))?.find(
      (event) => event.event.type === "tool_action",
    );
    expect(tool).toMatchObject({
      role_ref: "direct",
      role_resolved_hash: ROLE_HASH,
      engine: "codex",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approval resolution is byte-idempotent and conflicting decisions return 409", async () => {
  let release!: () => void;
  let context!: ConversationContext;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "approval",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      await value.emit({
        idempotency_key: "approval-request",
        event: {
          type: "approval_requested",
          payload: {
            token: {
              approval_id: "approval-1",
              operation_id: value.correlation.operation_id,
              actor: "reviewer",
            },
            description: "Approve plan",
          },
        },
      });
      await gate;
      return {
        operation_id: value.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy);
  try {
    const creating = runtime.create(createInput("approval"));
    await waitFor(() => context !== undefined);
    const decision = {
      approval_id: "approval-1",
      operation_id: context.correlation.operation_id,
      actor: "reviewer",
      outcome: "approve" as const,
      reason: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    };
    const canonicalDecision = { ...decision };
    const firstPending = runtime.resolveApproval("conversation-1", decision);
    Reflect.set(decision, "operation_id", "forged-operation");
    Reflect.set(decision, "reason", "mutated reason");
    const first = await firstPending;
    expect(await runtime.resolveApproval("conversation-1", canonicalDecision)).toEqual(first);
    expect(first).toEqual({ status: 202, body: { ...canonicalDecision, resolved: true } });
    expect(
      await runtime.resolveApproval("conversation-1", {
        ...canonicalDecision,
        reason: "ghp_zyxwvutsrqponmlkjihgfedcba0987654321",
      }),
    ).toEqual({ status: 409, body: { code: "approval_conflict" } });
    release();
    await creating;
    const records = await traceStore.readConversation("conversation-1");
    expect(
      records.filter((record) => record.stored_event.event.type === "approval_resolved"),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first approval starts one background continuation and returns 202 before it completes", async () => {
  let release!: () => void;
  let continuationCalls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "approval-continuation",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await context.emit({
        idempotency_key: "policy:approval:continue:request",
        event: {
          type: "approval_requested",
          payload: {
            token: {
              approval_id: "approval-continue",
              operation_id: context.correlation.operation_id,
              actor: "reviewer",
            },
            description: "continue",
          },
        },
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      continuationCalls += 1;
      await gate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  let approval: Promise<unknown> | undefined;
  try {
    const created = await runtime.create(createInput("approval-continuation"));
    expect(created.result.status).toBe("awaiting_approval");
    const decision = {
      approval_id: "approval-continue",
      operation_id: created.result.operation_id,
      actor: "reviewer",
      outcome: "approve" as const,
      reason: null,
    };
    await runtime.pause(created.conversation_id);
    expect(await runtime.resolveApproval(created.conversation_id, decision)).toEqual({
      status: 409,
      body: { code: "approval_conflict" },
    });
    await runtime.resume(created.conversation_id);
    let returned = false;
    approval = runtime.resolveApproval(created.conversation_id, decision).then((result) => {
      returned = true;
      return result;
    });
    await waitFor(() => continuationCalls === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(returned).toBe(true);
    expect(await approval).toEqual({ status: 202, body: { ...decision, resolved: true } });
    expect(await runtime.resolveApproval(created.conversation_id, decision)).toEqual({
      status: 202,
      body: { ...decision, resolved: true },
    });
    expect(continuationCalls).toBe(1);
    release();
    let lifecycle: string | undefined;
    for (let index = 0; index < 100; index++) {
      lifecycle = (await runtime.snapshot(created.conversation_id))?.lifecycle;
      if (lifecycle === "COMPLETED") break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(lifecycle).toBe("COMPLETED");
  } finally {
    release();
    await approval?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["completed", "ABORTED"],
  ["failed", "FAILED"],
  ["aborted", "ABORTED"],
  ["throw", "FAILED"],
] as const)(
  "approval continuation %s observed while PAUSED terminalizes as %s",
  async (outcome, expectedLifecycle) => {
    let release!: () => void;
    let continuing = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy: ConversationPolicy = {
      name: `paused-continuation-${outcome}`,
      async dryRun() {
        return {
          participants: [],
          evaluator_auto_added: false,
          engines_available: [],
          models_valid: true,
        };
      },
      async execute(context) {
        await context.emit({
          idempotency_key: `policy:approval:${outcome}:request`,
          event: {
            type: "approval_requested",
            payload: {
              token: {
                approval_id: `approval-${outcome}`,
                operation_id: context.correlation.operation_id,
                actor: "reviewer",
              },
              description: "continue",
            },
          },
        });
        return {
          operation_id: context.correlation.operation_id,
          status: "awaiting_approval",
          artifact_refs: [],
        };
      },
      async continueAfterApproval(context) {
        continuing = true;
        await gate;
        if (outcome === "throw") throw new Error("continuation failed");
        return {
          operation_id: context.correlation.operation_id,
          status: outcome,
          artifact_refs: [],
        };
      },
    };
    const { root, runtime } = await harness(policy);
    try {
      const created = await runtime.create(createInput(policy.name));
      await runtime.resolveApproval(created.conversation_id, {
        approval_id: `approval-${outcome}`,
        operation_id: created.result.operation_id,
        actor: "reviewer",
        outcome: "approve",
        reason: null,
      });
      await waitFor(() => continuing);
      await runtime.pause(created.conversation_id);
      release();
      let lifecycle: string | undefined;
      for (let index = 0; index < 100; index++) {
        lifecycle = (await runtime.snapshot(created.conversation_id).catch(() => null))?.lifecycle;
        if (lifecycle === expectedLifecycle) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(lifecycle).toBe(expectedLifecycle);
      expect(
        await runtime.cancelOperation({
          conversation_id: created.conversation_id,
          operation_id: created.result.operation_id,
          actor: "user",
          reason: null,
        }),
      ).toEqual({ status: 409, body: { code: "operation_not_cancellable" } });
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("STOPPED gate rejects every deferred approval continuation effect", async () => {
  let release!: () => void;
  let continued = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "stopped-continuation",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await context.emit({
        idempotency_key: "stopped-continuation:request",
        event: {
          type: "approval_requested",
          payload: {
            token: {
              approval_id: "approval-stop",
              operation_id: context.correlation.operation_id,
              actor: "reviewer",
            },
            description: "continue later",
          },
        },
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      await gate;
      await context.emit({
        idempotency_key: "stopped-continuation:late",
        event: {
          type: "baseline_result",
          payload: { status: "skipped", answer: null, confidence: null, skip_reason: "late" },
        },
      });
      continued = true;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy);
  try {
    const created = await runtime.create(createInput("stopped-continuation"));
    const decision = {
      approval_id: "approval-stop",
      operation_id: created.result.operation_id,
      actor: "reviewer",
      outcome: "approve" as const,
      reason: null,
    };
    expect(await runtime.resolveApproval(created.conversation_id, decision)).toMatchObject({
      status: 202,
    });
    expect(await runtime.stop(created.conversation_id)).toEqual({
      stopped: true,
      terminal_state: "STOPPED",
    });
    const stoppedLength = (await traceStore.readConversation(created.conversation_id)).length;
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(continued).toBe(false);
    expect((await traceStore.readConversation(created.conversation_id)).length).toBe(stoppedLength);
    expect((await runtime.snapshot(created.conversation_id))?.lifecycle).toBe("STOPPED");
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("background continuation failure durably terminalizes FAILED before settling", async () => {
  const policy: ConversationPolicy = {
    name: "approval-failure",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await context.emit({
        idempotency_key: "policy:approval:failure:request",
        event: {
          type: "approval_requested",
          payload: {
            token: {
              approval_id: "approval-failure",
              operation_id: context.correlation.operation_id,
              actor: "reviewer",
            },
            description: "continue",
          },
        },
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  let injected = false;
  const { root, runtime } = await harness(policy, new FakeAdapter(), (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: (correlation, input, native) => {
      if (
        !injected &&
        input.event.type === "state_change" &&
        input.event.payload.lifecycle === "COMPLETED"
      ) {
        injected = true;
        return Promise.reject(new Error("injected continuation terminal failure"));
      }
      return store.append(correlation, input, native);
    },
  }));
  try {
    const created = await runtime.create(createInput("approval-failure"));
    const decision = {
      approval_id: "approval-failure",
      operation_id: created.result.operation_id,
      actor: "reviewer",
      outcome: "approve" as const,
      reason: null,
    };
    expect(await runtime.resolveApproval(created.conversation_id, decision)).toEqual({
      status: 202,
      body: { ...decision, resolved: true },
    });
    let lifecycle: string | undefined;
    for (let index = 0; index < 100; index++) {
      lifecycle = (await runtime.snapshot(created.conversation_id))?.lifecycle;
      if (lifecycle === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect({ injected, lifecycle }).toEqual({ injected: true, lifecycle: "FAILED" });
    expect(
      await runtime.cancelOperation({
        conversation_id: created.conversation_id,
        operation_id: created.result.operation_id,
        actor: "user",
        reason: null,
      }),
    ).toEqual({ status: 409, body: { code: "operation_not_cancellable" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal publication never exposes or notifies a half-terminal prefix", async () => {
  let firstTerminalDurable = false;
  let releaseSuffix!: () => void;
  const suffixGate = new Promise<void>((resolve) => {
    releaseSuffix = resolve;
  });
  const { root, runtime } = await harness(
    new DirectConversationPolicy(),
    new FakeAdapter(),
    (store) => ({
      readConversation: (id) => store.readConversation(id),
      append: async (correlation, emission, native) => {
        if (emission.event.type === "conversation_terminal") await suffixGate;
        const stored = await store.append(correlation, emission, native);
        if (emission.event.type === "state_change" && emission.event.payload.terminal) {
          firstTerminalDurable = true;
        }
        return stored;
      },
    }),
  );
  try {
    const accepted = await runtime.start(createInput("direct"));
    const observed: string[] = [];
    runtime.subscribe(accepted.conversation_id, (event) => observed.push(event.event.type));
    await waitFor(() => firstTerminalDurable);
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ACTIVE");
    expect(observed).not.toContain("conversation_terminal");
    expect(observed.filter((type) => type === "state_change").length).toBe(1);
    releaseSuffix();
    await accepted.completion;
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("COMPLETED");
    expect(observed.slice(-2)).toEqual(["state_change", "conversation_terminal"]);
  } finally {
    releaseSuffix();
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovery removes a crash-torn terminal batch before public replay", async () => {
  const { root, runtime, traceStore } = await harness(
    new DirectConversationPolicy(),
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  const realWrite = fs.writeSync;
  const write = spyOn(fs, "writeSync");
  try {
    const accepted = await runtime.start(createInput("direct"));
    let injected = false;
    write.mockImplementation(((
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      const bytes = Buffer.from(buffer).subarray(offset, offset + length);
      if (!injected && bytes.includes(Buffer.from('"conversation_terminal"'))) {
        injected = true;
        const firstRecord = bytes.indexOf(10) + 1;
        realWrite(fd, buffer, offset, firstRecord, position);
        throw new Error("simulated process crash during terminal batch");
      }
      return realWrite(fd, buffer, offset, length, position);
    }) as typeof fs.writeSync);
    const authority = (
      runtime as unknown as {
        runtime: {
          terminal(
            id: string,
            lifecycle: "COMPLETED" | "FAILED",
            health: "healthy",
            reason: string | null,
            score: null,
          ): Promise<"COMPLETED" | "FAILED">;
        };
      }
    ).runtime;
    await expect(
      authority.terminal(accepted.conversation_id, "COMPLETED", "healthy", null, null),
    ).rejects.toThrow("simulated process crash");
    write.mockRestore();
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ACTIVE");
    expect(
      (await traceStore.readConversation(accepted.conversation_id)).some(
        ({ stored_event: stored }) =>
          stored.event.type === "state_change" && stored.event.payload.terminal,
      ),
    ).toBe(false);
    await expect(
      authority.terminal(accepted.conversation_id, "FAILED", "healthy", "recovered", null),
    ).resolves.toBe("FAILED");
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("FAILED");
  } finally {
    write.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial terminal prefix retries only the same lifecycle to a complete pair", async () => {
  let failedSecondAppend = false;
  const { root, runtime, traceStore } = await harness(
    new DirectConversationPolicy(),
    new FakeAdapter(),
    (store) => ({
      readConversation: (id) => store.readConversation(id),
      append: (correlation, input, native) => {
        if (!failedSecondAppend && input.event.type === "conversation_terminal") {
          failedSecondAppend = true;
          return Promise.reject(new Error("injected terminal suffix failure"));
        }
        return store.append(correlation, input, native);
      },
    }),
  );
  try {
    const created = await runtime.create(createInput("direct"));
    expect({ failedSecondAppend, status: created.result.status }).toEqual({
      failedSecondAppend: true,
      status: "completed",
    });
    const terminalRecords = (await traceStore.readConversation(created.conversation_id)).filter(
      ({ stored_event: stored }) =>
        stored.event.type === "conversation_terminal" ||
        (stored.event.type === "state_change" && stored.event.payload.terminal),
    );
    expect(terminalRecords.map(({ stored_event: stored }) => stored.event.type)).toEqual([
      "state_change",
      "conversation_terminal",
    ]);
    expect((await runtime.snapshot(created.conversation_id))?.lifecycle).toBe("COMPLETED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a zero-prefix terminal write failure falls back to durable FAILED and settles", async () => {
  let injected = false;
  const { root, runtime } = await harness(
    new DirectConversationPolicy(),
    new FakeAdapter(),
    (store) => ({
      readConversation: (id) => store.readConversation(id),
      append: (correlation, emission, native) => {
        if (
          !injected &&
          emission.event.type === "state_change" &&
          emission.event.payload.terminal
        ) {
          injected = true;
          return Promise.reject(new Error("injected first terminal write failure"));
        }
        return store.append(correlation, emission, native);
      },
    }),
  );
  try {
    const created = await runtime.create(createInput("direct"));
    expect({ injected, status: created.result.status }).toEqual({
      injected: true,
      status: "failed",
    });
    expect((await runtime.snapshot(created.conversation_id))?.lifecycle).toBe("FAILED");
    expect(
      await runtime.cancelOperation({
        conversation_id: created.conversation_id,
        operation_id: created.result.operation_id,
        actor: "user",
        reason: null,
      }),
    ).toEqual({ status: 409, body: { code: "operation_not_cancellable" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh service restores durable ACTIVE authority before pause, resume, and stop", async () => {
  const policy = new DirectConversationPolicy();
  const { root, runtime, traceStore } = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  try {
    const accepted = await runtime.start(createInput("direct"));
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ACTIVE");
    const restarted = new ConversationOrchestrator({
      traceStore,
      artifactRegistry: new DurableArtifactRegistry({ dir: join(root, "opaque") }),
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `restart-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    expect(await restarted.pause(accepted.conversation_id)).toEqual({
      paused: true,
      lifecycle: "PAUSED",
    });
    expect(await restarted.resume(accepted.conversation_id)).toEqual({
      resumed: true,
      active_state: "ACTIVE",
    });
    expect(await restarted.stop(accepted.conversation_id)).toEqual({
      stopped: true,
      terminal_state: "STOPPED",
    });
    expect((await restarted.snapshot(accepted.conversation_id))?.lifecycle).toBe("STOPPED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh message, pause, and stop controls never require binding rehydration or engine replay", async () => {
  const policy = new DirectConversationPolicy();
  const { root, runtime, traceStore } = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  try {
    const accepted = await runtime.start(createInput("direct"));
    const restartAdapter = new FakeAdapter();
    const restarted = new ConversationOrchestrator({
      traceStore,
      artifactRegistry: new DurableArtifactRegistry({ dir: join(root, "opaque") }),
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: restartAdapter,
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `restart-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => {
        throw new Error("provider unavailable");
      },
    });
    await expect(
      restarted.message(accepted.conversation_id, {
        content: "durable restart message",
        target_participants: ["participant-1"],
      }),
    ).resolves.toMatchObject({ accepted: true });
    expect(restartAdapter.starts).toHaveLength(0);
    expect(
      (await restarted.events(accepted.conversation_id, 0))?.find(
        ({ event }) => event.type === "user_message",
      )?.event,
    ).toMatchObject({
      type: "user_message",
      payload: {
        content: "durable restart message",
        target_participants: ["participant-1"],
      },
    });
    await expect(restarted.pause(accepted.conversation_id)).resolves.toEqual({
      paused: true,
      lifecycle: "PAUSED",
    });
    await expect(restarted.stop(accepted.conversation_id)).resolves.toEqual({
      stopped: true,
      terminal_state: "STOPPED",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh service restores the matching durable operation before cancellation without replay", async () => {
  const policy = new DirectConversationPolicy();
  const { root, runtime, traceStore } = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  try {
    const accepted = await runtime.start(createInput("direct"));
    const restartAdapter = new FakeAdapter();
    const restarted = new ConversationOrchestrator({
      traceStore,
      artifactRegistry: new DurableArtifactRegistry({ dir: join(root, "opaque") }),
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: restartAdapter,
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `restart-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    const command = {
      conversation_id: accepted.conversation_id,
      operation_id: accepted.operation_id,
      actor: "user" as const,
      reason: "cancel after restart",
    };
    await expect(restarted.cancelOperation(command)).resolves.toEqual({
      status: 202,
      body: { operation_id: accepted.operation_id, cancelled: true },
    });
    expect(restartAdapter.starts).toHaveLength(0);
    await expect(restarted.cancelOperation(command)).resolves.toEqual({
      status: 409,
      body: { code: "operation_not_cancellable" },
    });
    await expect(
      restarted.cancelOperation({ ...command, operation_id: "unknown-operation" }),
    ).resolves.toEqual({ status: 404, body: { code: "operation_not_found" } });
    await expect(
      restarted.cancelOperation({ ...command, conversation_id: "wrong-conversation" }),
    ).resolves.toEqual({ status: 409, body: { code: "operation_conversation_mismatch" } });
    expect(
      (await restarted.events(accepted.conversation_id, 0))?.filter(
        ({ event }) => event.type === "caller_cancelled",
      ),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cold message preserves the durable operation and cancellation reaches its live owner", async () => {
  let releasePolicy!: () => void;
  const policyGate = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  let policyStarted = false;
  let ownerSignal: AbortSignal | null = null;
  const policy: ConversationPolicy = {
    name: "cross-store-cancel",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      ownerSignal = context.signal;
      await context.emit({
        idempotency_key: "cross-store-cancel:approval",
        event: {
          type: "approval_requested",
          payload: {
            token: {
              approval_id: "cross-store-approval",
              operation_id: context.correlation.operation_id,
              actor: "reviewer",
            },
            description: "must close after cancellation",
          },
        },
      });
      context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "wait for cancellation",
      });
      policyStarted = true;
      await policyGate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const ownerAdapter = new TerminateLifecycleAdapter();
  const { root, runtime } = await harness(policy, ownerAdapter);
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await waitFor(() => policyStarted);
    const coldService = (label: string) => {
      const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
      return new ConversationOrchestrator({
        traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: artifacts }),
        artifactRegistry: artifacts,
        artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
        sessionAdapter: new FakeAdapter(),
        policies: new ConversationPolicyRegistry([policy]),
        id: (kind) => `${label}-${kind}`,
        now: () => "2026-08-22T00:00:00.000Z",
        rehydrateBinding: async () => materialized(),
      });
    };
    const cold = coldService("cold");
    const duplicate = coldService("duplicate");

    for (const service of [cold, duplicate]) {
      await expect(
        service.message(accepted.conversation_id, {
          content: "message before cancel",
          target_participants: "all",
        }),
      ).resolves.toMatchObject({ accepted: true });
    }
    const command = {
      conversation_id: accepted.conversation_id,
      operation_id: accepted.operation_id,
      actor: "user" as const,
      reason: "cancel from another service",
    };
    const cancellations = await Promise.all([
      cold.cancelOperation(command),
      duplicate.cancelOperation(command),
    ]);
    expect(cancellations.map(({ status }) => status).sort()).toEqual([202, 409]);
    await expect(duplicate.cancelOperation(command)).resolves.toEqual({
      status: 409,
      body: { code: "operation_not_cancellable" },
    });
    expect((ownerSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(ownerAdapter.terminated).toEqual(["attempt-1:cancel from another service"]);
    const restored = coldService("restored");
    await expect(
      restored.message(accepted.conversation_id, {
        content: "too late",
        target_participants: "all",
      }),
    ).rejects.toBeInstanceOf(ConversationControlConflictError);
    await expect(
      restored.resolveApproval(accepted.conversation_id, {
        approval_id: "cross-store-approval",
        operation_id: accepted.operation_id,
        actor: "reviewer",
        outcome: "approve",
        reason: null,
      }),
    ).resolves.toEqual({ status: 409, body: { code: "approval_conflict" } });
    await expect(restored.pause(accepted.conversation_id)).rejects.toBeInstanceOf(
      ConversationControlConflictError,
    );
    await expect(restored.cancelOperation(command)).resolves.toEqual({
      status: 409,
      body: { code: "operation_not_cancellable" },
    });
    await expect(restored.stop(accepted.conversation_id)).rejects.toBeInstanceOf(
      ConversationControlConflictError,
    );
    expect((await restored.snapshot(accepted.conversation_id))?.lifecycle).toBe("ABORTED");

    releasePolicy();
    expect((await accepted.completion).result).toEqual({
      operation_id: accepted.operation_id,
      status: "aborted",
      artifact_refs: [],
    });
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ABORTED");
    const events = await runtime.events(accepted.conversation_id, 0);
    expect(events?.filter(({ event }) => event.type === "caller_cancelled")).toHaveLength(1);
    expect(
      events?.some(
        ({ event }) =>
          event.type === "conversation_terminal" && event.payload.lifecycle === "COMPLETED",
      ),
    ).toBe(false);
  } finally {
    releasePolicy();
    await rm(root, { recursive: true, force: true });
  }
});

test("a durable cancellation journal wins if its process exits before notifying the live owner", async () => {
  let releasePolicy!: () => void;
  const policyGate = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  let ownerContext: ConversationContext | null = null;
  const policy: ConversationPolicy = {
    name: "durable-cancel-cas",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      ownerContext = context;
      await policyGate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy, new FakeAdapter());
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await waitFor(() => ownerContext !== null);
    const captured = ownerContext as unknown as ConversationContext | null;
    if (!captured) throw new Error("owner context missing");
    const correlation = captured.correlation;
    await traceStore.append(
      { ...correlation, turn_id: "external-cancel-turn", attempt_id: "control" },
      {
        idempotency_key: `caller-cancelled:${accepted.operation_id}`,
        event: {
          type: "caller_cancelled",
          payload: {
            operation_id: accepted.operation_id,
            actor: "user",
            reason: "canceller exited after journal fsync",
          },
        },
      },
    );
    await expect(
      traceStore.append(
        { ...correlation, turn_id: "late-effect-turn", attempt_id: "control" },
        {
          idempotency_key: "late-effect-after-cancel",
          event: {
            type: "user_message",
            payload: { content: "must be rejected", target_participants: "all" },
          },
        },
      ),
    ).rejects.toThrow("trace lifecycle conflict");
    expect(correlation.operation_id).toBe(accepted.operation_id);
    expect(captured.signal.aborted).toBe(false);

    releasePolicy();
    expect((await accepted.completion).result.status).toBe("aborted");
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ABORTED");
    expect(
      (await runtime.events(accepted.conversation_id, 0))?.some(
        ({ event }) =>
          event.type === "conversation_terminal" && event.payload.lifecycle === "COMPLETED",
      ),
    ).toBe(false);
  } finally {
    releasePolicy();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh retry adopts a caller cancellation journal left before marker commit", async () => {
  let releasePolicy!: () => void;
  const policyGate = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  let ownerContext: ConversationContext | null = null;
  const policy: ConversationPolicy = {
    name: "cancel-adoption",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      ownerContext = context;
      await policyGate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy, new FakeAdapter());
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await waitFor(() => ownerContext !== null);
    const captured = ownerContext as unknown as ConversationContext | null;
    if (!captured) throw new Error("owner context missing");
    const command = {
      conversation_id: accepted.conversation_id,
      operation_id: accepted.operation_id,
      actor: "user" as const,
      reason: "durable before marker",
    };
    await traceStore.append(
      { ...captured.correlation, turn_id: "crashed-cancel-turn", attempt_id: "control" },
      {
        idempotency_key: `caller-cancelled:${accepted.operation_id}`,
        event: {
          type: "caller_cancelled",
          payload: {
            operation_id: command.operation_id,
            actor: command.actor,
            reason: command.reason,
          },
        },
      },
    );
    const retryArtifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const retry = new ConversationOrchestrator({
      traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: retryArtifacts }),
      artifactRegistry: retryArtifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `retry-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });

    await expect(retry.cancelOperation(command)).resolves.toEqual({
      status: 409,
      body: { code: "operation_not_cancellable" },
    });
    expect(captured.signal.aborted).toBe(true);
    await expect(retry.cancelOperation(command)).resolves.toEqual({
      status: 409,
      body: { code: "operation_not_cancellable" },
    });
    expect(
      (await runtime.events(accepted.conversation_id, 0))?.filter(
        ({ event }) => event.type === "caller_cancelled",
      ),
    ).toHaveLength(1);

    releasePolicy();
    expect((await accepted.completion).result.status).toBe("aborted");
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("ABORTED");
  } finally {
    releasePolicy();
    await rm(root, { recursive: true, force: true });
  }
});

test("the durable cancellation writer keeps the sole acknowledgement when a mismatched observer heals its marker", async () => {
  let releasePolicy!: () => void;
  const policyGate = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  let policyStarted = false;
  const policy: ConversationPolicy = {
    name: "cancel-ack-owner",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      policyStarted = true;
      await policyGate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy, new FakeAdapter());
  let releaseWriter!: () => void;
  const writerGate = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  let durableWriter!: () => void;
  const writerStored = new Promise<void>((resolve) => {
    durableWriter = resolve;
  });
  const append = traceStore.append.bind(traceStore);
  const appendSpy = spyOn(traceStore, "append").mockImplementation(
    async (correlation: TraceCorrelation, input: TraceAppendInput, native?: string | null) => {
      const stored = await append(correlation, input, native);
      if (input.event.type === "caller_cancelled") {
        durableWriter();
        await writerGate;
      }
      return stored;
    },
  );
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await waitFor(() => policyStarted);
    const winner = runtime.cancelOperation({
      conversation_id: accepted.conversation_id,
      operation_id: accepted.operation_id,
      actor: "user",
      reason: "writer reason",
    });
    await writerStored;

    const joiningArtifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const joining = new ConversationOrchestrator({
      traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: joiningArtifacts }),
      artifactRegistry: joiningArtifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `joining-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    await expect(
      joining.cancelOperation({
        conversation_id: accepted.conversation_id,
        operation_id: accepted.operation_id,
        actor: "user",
        reason: "writer reason",
      }),
    ).resolves.toEqual({ status: 409, body: { code: "operation_not_cancellable" } });

    const observerArtifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const observerStore = new ConversationArtifactStore({ dir: join(root, "manifests") });
    const authority = observerStore.operationAuthority();
    spyOn(observerStore, "operationAuthority").mockReturnValue({
      scopeKey: `${authority.scopeKey}:simulated-process`,
      commitCancellation: (conversationId, operationId) =>
        authority.commitCancellation(conversationId, operationId),
      isCancellationClaimed: (conversationId, operationId) =>
        authority.isCancellationClaimed(conversationId, operationId),
    });
    const observer = new ConversationOrchestrator({
      traceStore: new TraceStore({
        dir: join(root, "trace"),
        artifactRegistry: observerArtifacts,
      }),
      artifactRegistry: observerArtifacts,
      artifactStore: observerStore,
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `observer-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    await expect(
      observer.cancelOperation({
        conversation_id: accepted.conversation_id,
        operation_id: accepted.operation_id,
        actor: "user",
        reason: "observer reason",
      }),
    ).resolves.toEqual({ status: 409, body: { code: "operation_not_cancellable" } });

    releaseWriter();
    await expect(winner).resolves.toEqual({
      status: 202,
      body: { operation_id: accepted.operation_id, cancelled: true },
    });
    expect(
      (await runtime.events(accepted.conversation_id, 0))?.filter(
        ({ event }) => event.type === "caller_cancelled",
      ),
    ).toHaveLength(1);
    releasePolicy();
    expect((await accepted.completion).result.status).toBe("aborted");
  } finally {
    appendSpy.mockRestore();
    releaseWriter();
    releasePolicy();
    await rm(root, { recursive: true, force: true });
  }
});

test("remote STOPPED closes a shared paused gate and rejects its deferred attempt", async () => {
  let releasePolicy!: () => void;
  const policyGate = new Promise<void>((resolve) => {
    releasePolicy = resolve;
  });
  let attemptRequested = false;
  const policy: ConversationPolicy = {
    name: "remote-stop-deferred",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await policyGate;
      const attempt = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "must never start",
      });
      attemptRequested = true;
      await attempt.completion;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  const { root, runtime } = await harness(policy, adapter);
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await runtime.pause(accepted.conversation_id);
    releasePolicy();
    await waitFor(() => attemptRequested);
    expect(adapter.starts).toHaveLength(0);
    const remoteArtifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const remote = new ConversationOrchestrator({
      traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: remoteArtifacts }),
      artifactRegistry: remoteArtifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `remote-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    await expect(remote.stop(accepted.conversation_id)).resolves.toEqual({
      stopped: true,
      terminal_state: "STOPPED",
    });
    await expect(
      Promise.race([
        accepted.completion,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("deferred attempt hung after remote stop")), 1000),
        ),
      ]),
    ).resolves.toMatchObject({ result: { status: "aborted" } });
    expect(adapter.starts).toHaveLength(0);
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("STOPPED");
  } finally {
    releasePolicy();
    await rm(root, { recursive: true, force: true });
  }
});

test("fresh cancellation rejects terminal operations and preserves the resumed durable operation", async () => {
  const policy = new DirectConversationPolicy();
  const makeRestarted = (root: string, label: string) => {
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    return new ConversationOrchestrator({
      traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: artifacts }),
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `${label}-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
  };
  const terminalHarness = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  const staleHarness = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  try {
    const terminal = await terminalHarness.runtime.start(createInput("direct"));
    await terminalHarness.runtime.stop(terminal.conversation_id);
    const terminalRestart = makeRestarted(terminalHarness.root, "terminal");
    await expect(
      terminalRestart.cancelOperation({
        conversation_id: terminal.conversation_id,
        operation_id: terminal.operation_id,
        actor: "user",
        reason: null,
      }),
    ).resolves.toEqual({ status: 409, body: { code: "operation_not_cancellable" } });
    await expect(
      terminalRestart.cancelOperation({
        conversation_id: terminal.conversation_id,
        operation_id: "unknown-operation",
        actor: "user",
        reason: null,
      }),
    ).resolves.toEqual({ status: 404, body: { code: "operation_not_found" } });

    const stale = await staleHarness.runtime.start(createInput("direct"));
    const transitioner = makeRestarted(staleHarness.root, "transitioner");
    await transitioner.pause(stale.conversation_id);
    await transitioner.resume(stale.conversation_id);
    const staleRestart = makeRestarted(staleHarness.root, "stale");
    await expect(
      staleRestart.cancelOperation({
        conversation_id: stale.conversation_id,
        operation_id: stale.operation_id,
        actor: "user",
        reason: null,
      }),
    ).resolves.toEqual({
      status: 202,
      body: { operation_id: stale.operation_id, cancelled: true },
    });
  } finally {
    await rm(terminalHarness.root, { recursive: true, force: true });
    await rm(staleHarness.root, { recursive: true, force: true });
  }
});

test("cold cancellation distinguishes another conversation's durable operation from unknown", async () => {
  const policy = new DirectConversationPolicy();
  const { root, runtime } = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  try {
    const first = await runtime.start(createInput("direct"));
    const second = await runtime.start(createInput("direct"));
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const restarted = new ConversationOrchestrator({
      traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: artifacts }),
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `cold-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    await expect(
      restarted.cancelOperation({
        conversation_id: second.conversation_id,
        operation_id: first.operation_id,
        actor: "user",
        reason: null,
      }),
    ).resolves.toEqual({
      status: 409,
      body: { code: "operation_conversation_mismatch" },
    });
    await expect(
      restarted.cancelOperation({
        conversation_id: second.conversation_id,
        operation_id: "unknown-operation",
        actor: "user",
        reason: null,
      }),
    ).resolves.toEqual({ status: 404, body: { code: "operation_not_found" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart preserves the durable operation id for an unresolved approval", async () => {
  let continuationOperation = "";
  const policy: ConversationPolicy = {
    name: "restart-approval",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await context.emit({
        idempotency_key: "policy:restart-approval:request",
        event: {
          type: "approval_requested",
          payload: {
            token: {
              approval_id: "approval-restart",
              operation_id: context.correlation.operation_id,
              actor: "reviewer",
            },
            description: "continue after restart",
          },
        },
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      continuationOperation = context.correlation.operation_id;
      const attempt = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "continue after restart",
      });
      await attempt.completion;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy);
  try {
    const created = await runtime.create(createInput(policy.name));
    new ConversationArtifactStore({ dir: join(root, "manifests") }).recordResumeBinding(
      created.conversation_id,
      "participant-1",
      {
        attemptId: "persisted-attempt",
        engine: "codex",
        nativeSessionId: "00000000-0000-4000-8000-000000000777",
      },
    );
    const adapter = new OrderedResumeAdapter();
    const restarted = new ConversationOrchestrator({
      traceStore,
      artifactRegistry: new DurableArtifactRegistry({ dir: join(root, "opaque") }),
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: adapter,
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `restart-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    const decision = {
      approval_id: "approval-restart",
      operation_id: created.result.operation_id,
      actor: "reviewer",
      outcome: "approve" as const,
      reason: null,
    };
    await expect(restarted.resolveApproval(created.conversation_id, decision)).resolves.toEqual({
      status: 202,
      body: { ...decision, resolved: true },
    });
    await waitFor(() => adapter.starts.length === 1);
    expect(adapter.reconciliations).toEqual([
      {
        engine: "codex",
        nativeSessionId: "00000000-0000-4000-8000-000000000777",
      },
    ]);
    expect(adapter.starts[0]?.nativeSessionId).toBe("00000000-0000-4000-8000-000000000777");
    adapter.complete(adapter.starts[0]?.attemptId ?? "");
    await waitFor(
      async () => (await restarted.snapshot(created.conversation_id))?.lifecycle === "COMPLETED",
    );
    expect(continuationOperation).toBe(created.result.operation_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeat durable approval does not require provider rehydration", async () => {
  let continuationStarted = false;
  let releaseContinuation!: () => void;
  const continuationGate = new Promise<void>((resolve) => {
    releaseContinuation = resolve;
  });
  const policy: ConversationPolicy = {
    name: "repeat-approval",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await context.emit({
        idempotency_key: "policy:repeat-approval:request",
        event: {
          type: "approval_requested",
          payload: {
            token: {
              approval_id: "approval-repeat",
              operation_id: context.correlation.operation_id,
              actor: "reviewer",
            },
            description: "continue once",
          },
        },
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      continuationStarted = true;
      await continuationGate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  let conversationId: string | undefined;
  try {
    const created = await runtime.create(createInput(policy.name));
    conversationId = created.conversation_id;
    const decision = {
      approval_id: "approval-repeat",
      operation_id: created.result.operation_id,
      actor: "reviewer",
      outcome: "approve" as const,
      reason: null,
    };
    await expect(runtime.resolveApproval(created.conversation_id, decision)).resolves.toEqual({
      status: 202,
      body: { ...decision, resolved: true },
    });
    await waitFor(() => continuationStarted);
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const cold = new ConversationOrchestrator({
      traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: artifacts }),
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `cold-repeat-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => {
        throw new Error("provider unavailable during idempotent repeat");
      },
    });
    await expect(cold.resolveApproval(created.conversation_id, decision)).resolves.toEqual({
      status: 202,
      body: { ...decision, resolved: true },
    });
  } finally {
    releaseContinuation();
    if (conversationId) {
      await waitFor(async () =>
        ["COMPLETED", "FAILED", "ABORTED"].includes(
          (await runtime.snapshot(conversationId as string))?.lifecycle ?? "",
        ),
      ).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("two restored services use the durable approval record as the sole continuation claim", async () => {
  let continuationCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "shared-restart-approval",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await context.emit({
        idempotency_key: "policy:shared-approval:request",
        event: {
          type: "approval_requested",
          payload: {
            token: {
              approval_id: "approval-shared",
              operation_id: context.correlation.operation_id,
              actor: "reviewer",
            },
            description: "continue once",
          },
        },
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      continuationCalls += 1;
      await gate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  const makeService = (label: string) => {
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    return new ConversationOrchestrator({
      traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: artifacts }),
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `${label}-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
  };
  try {
    const created = await runtime.create(createInput(policy.name));
    const decision = {
      approval_id: "approval-shared",
      operation_id: created.result.operation_id,
      actor: "reviewer",
      outcome: "approve" as const,
      reason: null,
    };
    const left = makeService("same");
    const right = makeService("same");
    const responses = await Promise.all([
      left.resolveApproval(created.conversation_id, decision),
      right.resolveApproval(created.conversation_id, decision),
    ]);
    expect(responses).toEqual([
      { status: 202, body: { ...decision, resolved: true } },
      { status: 202, body: { ...decision, resolved: true } },
    ]);
    await waitFor(() => continuationCalls > 0);
    expect(continuationCalls).toBe(1);
    expect(
      (await left.events(created.conversation_id, 0))?.filter(
        ({ event }) => event.type === "approval_resolved",
      ),
    ).toHaveLength(1);
    release();
    await waitFor(
      async () => (await left.snapshot(created.conversation_id))?.lifecycle === "COMPLETED",
    );
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("two restored services converge on one durable terminal winner", async () => {
  const policy = new DirectConversationPolicy();
  const { root, runtime } = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  const makeService = (label: string) => {
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    return new ConversationOrchestrator({
      traceStore: new TraceStore({
        dir: join(root, "trace"),
        artifactRegistry: artifacts,
        now: () => "2026-08-22T00:00:00.000Z",
      }),
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `${label}-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
  };
  try {
    const accepted = await runtime.start(createInput("direct"));
    const left = makeService("left");
    const right = makeService("right");
    type RuntimeAuthority = {
      restore(id: string): Promise<void>;
      terminal(
        id: string,
        lifecycle: "STOPPED" | "COMPLETED",
        health: "healthy",
        reason: null,
        score: null,
      ): Promise<"STOPPED" | "COMPLETED">;
    };
    const leftAuthority = (left as unknown as { runtime: RuntimeAuthority }).runtime;
    const rightAuthority = (right as unknown as { runtime: RuntimeAuthority }).runtime;
    await Promise.all([
      leftAuthority.restore(accepted.conversation_id),
      rightAuthority.restore(accepted.conversation_id),
    ]);
    const winners = await Promise.all([
      leftAuthority.terminal(accepted.conversation_id, "STOPPED", "healthy", null, null),
      rightAuthority.terminal(accepted.conversation_id, "COMPLETED", "healthy", null, null),
    ]);
    expect(new Set(winners).size).toBe(1);
    const events = await left.events(accepted.conversation_id, 0);
    expect(
      events?.filter(({ event }) => event.type === "state_change" && event.payload.terminal),
    ).toHaveLength(1);
    expect(events?.filter(({ event }) => event.type === "conversation_terminal")).toHaveLength(1);
    expect((await left.snapshot(accepted.conversation_id))?.lifecycle).toBe(winners[0]);
    expect((await right.snapshot(accepted.conversation_id))?.lifecycle).toBe(winners[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a durable PAUSED winner remaps a stale cross-service completion to ABORTED", async () => {
  let releaseExecution!: () => void;
  const executionGate = new Promise<void>((resolve) => {
    releaseExecution = resolve;
  });
  const policy: ConversationPolicy = {
    name: "cross-service-pause",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await executionGate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  try {
    const accepted = await runtime.start(createInput(policy.name));
    const authority = (
      runtime as unknown as {
        runtime: { snapshot(id: string): ReturnType<ConversationOrchestrator["snapshot"]> };
      }
    ).runtime;
    const snapshot = authority.snapshot.bind(authority);
    let captured = false;
    authority.snapshot = async (id) => {
      const state = await snapshot(id);
      if (!captured && state?.lifecycle === "ACTIVE") {
        captured = true;
        await snapshotGate;
      }
      return state;
    };
    releaseExecution();
    await waitFor(() => captured);
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const pausing = new ConversationOrchestrator({
      traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: artifacts }),
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `pausing-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    await pausing.pause(accepted.conversation_id);
    releaseSnapshot();
    await expect(accepted.completion).resolves.toMatchObject({ result: { status: "aborted" } });
    expect((await pausing.snapshot(accepted.conversation_id))?.lifecycle).toBe("ABORTED");
  } finally {
    releaseExecution();
    releaseSnapshot();
    await rm(root, { recursive: true, force: true });
  }
});

test("same-service concurrent pause loser surfaces a typed public conflict", async () => {
  let appendStarted!: () => void;
  let releaseAppend!: () => void;
  const started = new Promise<void>((resolve) => {
    appendStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  const { root, runtime } = await harness(
    new DirectConversationPolicy(),
    new FakeAdapter(),
    (store) => ({
      readConversation: (id) => store.readConversation(id),
      append: async (correlation, emission, native) => {
        if (
          emission.event.type === "state_change" &&
          emission.event.payload.lifecycle === "PAUSED"
        ) {
          appendStarted();
          await gate;
        }
        return store.append(correlation, emission, native);
      },
    }),
    async () => materialized(),
    { schedule: () => {} },
  );
  let winner: ReturnType<ConversationOrchestrator["pause"]> | undefined;
  try {
    const accepted = await runtime.start(createInput("direct"));
    winner = runtime.pause(accepted.conversation_id);
    await started;
    await expect(runtime.pause(accepted.conversation_id)).rejects.toBeInstanceOf(
      ConversationControlConflictError,
    );
    releaseAppend();
    await expect(winner).resolves.toEqual({ paused: true, lifecycle: "PAUSED" });
  } finally {
    releaseAppend();
    await winner?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("remote PAUSE suspends every live member and drains owner effects before its journal", async () => {
  let context!: ConversationContext;
  const policy: ConversationPolicy = {
    name: "cross-service-pause-barrier",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      return {
        operation_id: value.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(value) {
      return {
        operation_id: value.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  let releaseEffect!: () => void;
  const effectGate = new Promise<void>((resolve) => {
    releaseEffect = resolve;
  });
  let effectStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    effectStarted = resolve;
  });
  const adapter = new FakeAdapter();
  const { root, runtime } = await harness(policy, adapter, (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: async (correlation, emission, native) => {
      if (emission.idempotency_key === "owner:effect-before-pause") {
        effectStarted();
        await effectGate;
      }
      return store.append(correlation, emission, native);
    },
  }));
  type RuntimeAuthority = {
    restoreControl(id: string): Promise<string>;
    transition(id: string, lifecycle: "ACTIVE" | "PAUSED", health: "healthy"): Promise<void>;
  };
  let pausing: Promise<void> | undefined;
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await accepted.completion;
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const remote = new ConversationOrchestrator({
      traceStore: new TraceStore({ dir: join(root, "trace"), artifactRegistry: artifacts }),
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `barrier-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    const authority = (remote as unknown as { runtime: RuntimeAuthority }).runtime;
    await authority.restoreControl(accepted.conversation_id);
    const ownerEffect = context.emit({
      idempotency_key: "owner:effect-before-pause",
      event: {
        type: "baseline_result",
        payload: { status: "skipped", answer: null, confidence: null, skip_reason: "barrier" },
      },
    });
    await started;
    const ownerArtifact = context.createArtifact({
      artifact_type: "synthesis",
      content: "must commit before pause",
      idempotency_key: "owner:artifact-before-pause",
    });

    let pauseSettled = false;
    pausing = authority.transition(accepted.conversation_id, "PAUSED", "healthy").finally(() => {
      pauseSettled = true;
    });
    const contenderArtifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const contender = new ConversationOrchestrator({
      traceStore: new TraceStore({
        dir: join(root, "trace"),
        artifactRegistry: contenderArtifacts,
      }),
      artifactRegistry: contenderArtifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `barrier-contender-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    await expect(
      contender.message(accepted.conversation_id, {
        content: "must conflict while PAUSE owns the broker",
        target_participants: "all",
      }),
    ).rejects.toBeInstanceOf(ConversationControlConflictError);
    const deferredEffect = context.emit({
      idempotency_key: "owner:effect-after-prepare",
      event: {
        type: "baseline_result",
        payload: { status: "skipped", answer: null, confidence: null, skip_reason: "deferred" },
      },
    });
    const deferredAttempt = context.launchAttempt({
      participantId: "participant-1",
      bindingIndex: 0,
      purpose: "direct",
      promptInput: "start only after resume",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pauseSettled).toBe(false);
    expect(adapter.starts).toHaveLength(0);

    releaseEffect();
    await Promise.all([ownerEffect, ownerArtifact, pausing]);
    const pausedEvents = await runtime.events(accepted.conversation_id, 0);
    const effectIndex = pausedEvents?.findIndex(
      ({ event }) => event.type === "baseline_result" && event.payload.skip_reason === "barrier",
    );
    const artifactIndex = pausedEvents?.findIndex(({ event }) => event.type === "artifact_created");
    const pauseIndex = pausedEvents?.findIndex(
      ({ event }) => event.type === "state_change" && event.payload.lifecycle === "PAUSED",
    );
    expect(effectIndex).toBeGreaterThanOrEqual(0);
    expect(artifactIndex).toBeGreaterThan(effectIndex ?? -1);
    expect(pauseIndex).toBeGreaterThan(artifactIndex ?? -1);
    expect(adapter.starts).toHaveLength(0);

    await authority.transition(accepted.conversation_id, "ACTIVE", "healthy");
    await Promise.all([deferredEffect, deferredAttempt.completion]);
    expect(adapter.starts).toHaveLength(1);
    await expect(
      contender.message(accepted.conversation_id, {
        content: "retry after resume",
        target_participants: "all",
      }),
    ).resolves.toMatchObject({ accepted: true });
    await remote.stop(accepted.conversation_id);
  } finally {
    releaseEffect();
    await pausing?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent durable PAUSE and RESUME losers recover the durable winner authority", async () => {
  const policy = new DirectConversationPolicy();
  const { root, runtime } = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  const makeService = (label: string, blockLifecycle: "PAUSED" | "ACTIVE", gate: Promise<void>) => {
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const store = new TraceStore({ dir: join(root, "trace"), artifactRegistry: artifacts });
    const artifactStore = new ConversationArtifactStore({ dir: join(root, "manifests") });
    const authority = artifactStore.operationAuthority();
    spyOn(artifactStore, "operationAuthority").mockReturnValue({
      scopeKey: `${authority.scopeKey}:${label}:simulated-process`,
      commitCancellation: (conversationId, operationId) =>
        authority.commitCancellation(conversationId, operationId),
      isCancellationClaimed: (conversationId, operationId) =>
        authority.isCancellationClaimed(conversationId, operationId),
    });
    let started!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new ConversationOrchestrator({
      traceStore: {
        readConversation: (id) => store.readConversation(id),
        recoverConversation: (id) => store.recoverConversation?.(id) as Promise<never>,
        append: async (correlation, emission, native) => {
          if (
            emission.event.type === "state_change" &&
            emission.event.payload.lifecycle === blockLifecycle &&
            !emission.event.payload.terminal
          ) {
            started();
            await gate;
          }
          return store.append(correlation, emission, native);
        },
        appendBatch: (entries) => store.appendBatch?.(entries) as Promise<never>,
      },
      artifactRegistry: artifacts,
      artifactStore,
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `${label}-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    return { service, appendStarted };
  };
  let releasePause!: () => void;
  let releaseResume!: () => void;
  const pauseGate = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  try {
    const accepted = await runtime.start(createInput("direct"));
    const blockedPause = makeService("blocked-pause", "PAUSED", pauseGate);
    const pauseWinner = makeService("pause-winner", "ACTIVE", Promise.resolve()).service;
    const losingPause = blockedPause.service.pause(accepted.conversation_id);
    await blockedPause.appendStarted;
    await pauseWinner.pause(accepted.conversation_id);
    releasePause();
    await expect(losingPause).rejects.toBeInstanceOf(ConversationControlConflictError);
    await expect(blockedPause.service.resume(accepted.conversation_id)).resolves.toEqual({
      resumed: true,
      active_state: "ACTIVE",
    });
    await expect(blockedPause.service.pause(accepted.conversation_id)).resolves.toEqual({
      paused: true,
      lifecycle: "PAUSED",
    });

    const blockedResume = makeService("blocked-resume", "ACTIVE", resumeGate);
    const resumeWinner = makeService("resume-winner", "PAUSED", Promise.resolve()).service;
    const losingResume = blockedResume.service.resume(accepted.conversation_id);
    await blockedResume.appendStarted;
    await resumeWinner.resume(accepted.conversation_id);
    releaseResume();
    await expect(losingResume).rejects.toBeInstanceOf(ConversationControlConflictError);
    await expect(
      blockedResume.service.message(accepted.conversation_id, {
        content: "durable ACTIVE is usable after losing resume",
        target_participants: "all",
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(blockedResume.service.pause(accepted.conversation_id)).resolves.toEqual({
      paused: true,
      lifecycle: "PAUSED",
    });
    expect((await runtime.snapshot(accepted.conversation_id))?.lifecycle).toBe("PAUSED");
  } finally {
    releasePause();
    releaseResume();
    await rm(root, { recursive: true, force: true });
  }
});

test("public stop reports conflict when another service durably completes first", async () => {
  const policy = new DirectConversationPolicy();
  const { root, runtime } = await harness(
    policy,
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  let stopAppendStarted!: () => void;
  let releaseStopAppend!: () => void;
  const stopStarted = new Promise<void>((resolve) => {
    stopAppendStarted = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    releaseStopAppend = resolve;
  });
  try {
    const accepted = await runtime.start(createInput("direct"));
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const stopStore = new TraceStore({ dir: join(root, "trace"), artifactRegistry: artifacts });
    const completingStore = new TraceStore({
      dir: join(root, "trace"),
      artifactRegistry: artifacts,
    });
    const serviceOptions = {
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: new FakeAdapter(),
      policies: new ConversationPolicyRegistry([policy]),
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    };
    const stopping = new ConversationOrchestrator({
      ...serviceOptions,
      traceStore: {
        readConversation: (id) => stopStore.readConversation(id),
        recoverConversation: (id) => stopStore.recoverConversation?.(id) as Promise<never>,
        append: (correlation, emission, native) => stopStore.append(correlation, emission, native),
        appendBatch: async (entries) => {
          stopAppendStarted();
          await stopGate;
          return (await stopStore.appendBatch?.(entries)) ?? [];
        },
      },
      id: (kind) => `stopping-${kind}`,
    });
    const completing = new ConversationOrchestrator({
      ...serviceOptions,
      traceStore: completingStore,
      id: (kind) => `completing-${kind}`,
    });
    type RuntimeAuthority = {
      restore(id: string): Promise<void>;
      terminal(
        id: string,
        lifecycle: "COMPLETED",
        health: "healthy",
        reason: null,
        score: null,
      ): Promise<"COMPLETED">;
    };
    const completingAuthority = (completing as unknown as { runtime: RuntimeAuthority }).runtime;
    await Promise.all([
      (stopping as unknown as { runtime: RuntimeAuthority }).runtime.restore(
        accepted.conversation_id,
      ),
      completingAuthority.restore(accepted.conversation_id),
    ]);
    const stop = stopping.stop(accepted.conversation_id);
    await stopStarted;
    await completingAuthority.terminal(
      accepted.conversation_id,
      "COMPLETED",
      "healthy",
      null,
      null,
    );
    releaseStopAppend();
    await expect(stop).rejects.toBeInstanceOf(ConversationControlConflictError);
    expect((await stopping.snapshot(accepted.conversation_id))?.lifecycle).toBe("COMPLETED");
  } finally {
    releaseStopAppend();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["approval", "message", "cancel"] as const)(
  "a remote STOPPED winner maps a stale %s control append to its public conflict",
  async (lane) => {
    const policy: ConversationPolicy = {
      name: `remote-stop-${lane}`,
      async dryRun() {
        return {
          participants: [],
          evaluator_auto_added: false,
          engines_available: [],
          models_valid: true,
        };
      },
      async execute(context) {
        await context.emit({
          idempotency_key: `policy:remote-stop:${lane}:request`,
          event: {
            type: "approval_requested",
            payload: {
              token: {
                approval_id: `approval-${lane}`,
                operation_id: context.correlation.operation_id,
                actor: "reviewer",
              },
              description: "remote stop race",
            },
          },
        });
        return {
          operation_id: context.correlation.operation_id,
          status: "awaiting_approval",
          artifact_refs: [],
        };
      },
      async continueAfterApproval(context) {
        return {
          operation_id: context.correlation.operation_id,
          status: "completed",
          artifact_refs: [],
        };
      },
    };
    const { root, runtime } = await harness(policy);
    let markAppendStarted!: () => void;
    let releaseAppend!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      markAppendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    try {
      const created = await runtime.create(createInput(policy.name));
      const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
      const blockedStore = new TraceStore({
        dir: join(root, "trace"),
        artifactRegistry: artifacts,
      });
      const terminalStore = new TraceStore({
        dir: join(root, "trace"),
        artifactRegistry: artifacts,
      });
      let blocked = false;
      const serviceOptions = {
        artifactRegistry: artifacts,
        artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
        sessionAdapter: new FakeAdapter(),
        policies: new ConversationPolicyRegistry([policy]),
        now: () => "2026-08-22T00:00:00.000Z",
        rehydrateBinding: async () => materialized(),
      };
      const stale = new ConversationOrchestrator({
        ...serviceOptions,
        traceStore: {
          readConversation: (id) => blockedStore.readConversation(id),
          recoverConversation: (id) => blockedStore.recoverConversation?.(id) as Promise<never>,
          append: async (correlation, emission, native) => {
            if (
              !blocked &&
              ((lane === "approval" && emission.event.type === "approval_resolved") ||
                (lane === "message" && emission.event.type === "user_message") ||
                (lane === "cancel" && emission.event.type === "caller_cancelled"))
            ) {
              blocked = true;
              markAppendStarted();
              await appendGate;
            }
            return blockedStore.append(correlation, emission, native);
          },
          appendBatch: (entries) => blockedStore.appendBatch?.(entries) as Promise<never>,
        },
        id: (kind) => `stale-${lane}-${kind}`,
      });
      const stopping = new ConversationOrchestrator({
        ...serviceOptions,
        traceStore: terminalStore,
        id: (kind) => `stopping-${lane}-${kind}`,
      });
      const decision = {
        approval_id: `approval-${lane}`,
        operation_id: created.result.operation_id,
        actor: "reviewer",
        outcome: "approve" as const,
        reason: null,
      };
      const action =
        lane === "approval"
          ? stale.resolveApproval(created.conversation_id, decision)
          : lane === "message"
            ? stale.message(created.conversation_id, { content: "stale message" })
            : stale.cancelOperation({
                conversation_id: created.conversation_id,
                operation_id: created.result.operation_id,
                actor: "user",
                reason: "stale cancel",
              });
      const observed = action.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await appendStarted;
      await stopping.stop(created.conversation_id);
      releaseAppend();
      const outcome = await observed;
      if (lane === "approval") {
        expect(outcome).toEqual({
          value: { status: 409, body: { code: "approval_conflict" } },
        });
      } else if (lane === "message") {
        expect("error" in outcome && outcome.error).toBeInstanceOf(
          ConversationControlConflictError,
        );
      } else {
        expect(outcome).toEqual({
          value: { status: 409, body: { code: "operation_not_cancellable" } },
        });
      }
      expect((await stopping.snapshot(created.conversation_id))?.lifecycle).toBe("STOPPED");
    } finally {
      releaseAppend();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("pause preserves attempts; restart resume rehydrates exact binding and never replays ambiguous work", async () => {
  let context!: ConversationContext;
  const policy: ConversationPolicy = {
    name: "resume",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      value.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "ambiguous",
      });
      await new Promise<void>((resolve) =>
        value.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { operation_id: value.correlation.operation_id, status: "aborted", artifact_refs: [] };
    },
  };
  const adapter = new FakeAdapter();
  adapter.ambiguous = true;
  const { root, runtime, traceStore } = await harness(policy, adapter);
  try {
    const creating = runtime.create(createInput("resume"));
    await waitFor(() => context !== undefined);
    expect(await runtime.pause("conversation-1")).toEqual({ paused: true, lifecycle: "PAUSED" });
    await expect(runtime.pause("conversation-1")).rejects.toThrow("pause requires ACTIVE");
    expect(adapter.terminated).toEqual([]);
    let pausedEffectSettled = false;
    const pausedEffect = context
      .emit({
        idempotency_key: "paused:forged-effect",
        event: {
          type: "baseline_result",
          payload: { status: "skipped", answer: null, confidence: null, skip_reason: "paused" },
        },
      })
      .then(
        () => {
          pausedEffectSettled = true;
        },
        () => {
          pausedEffectSettled = true;
        },
      );
    const startsWhilePaused = adapter.starts.length;
    const deferred = context.launchAttempt({
      participantId: "participant-1",
      bindingIndex: 0,
      purpose: "direct",
      promptInput: "must remain paused",
    });
    void deferred.completion.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pausedEffectSettled).toBe(false);
    expect(adapter.starts).toHaveLength(startsWhilePaused);

    const restartAdapter = new FakeAdapter();
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    let rehydrated = 0;
    const restarted = new ConversationOrchestrator({
      traceStore,
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: restartAdapter,
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => `restart-${kind}`,
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => {
        rehydrated += 1;
        return materialized();
      },
    });
    expect(await restarted.resume("conversation-1")).toEqual({
      resumed: true,
      active_state: "ACTIVE",
    });
    await expect(restarted.resume("conversation-1")).rejects.toThrow("resume requires PAUSED");
    expect(rehydrated).toBe(1);
    expect(restartAdapter.starts).toHaveLength(0);
    await runtime.stop("conversation-1");
    await pausedEffect;
    await deferred.completion.catch(() => undefined);
    await creating;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy effects suspend while PAUSED and continue only after durable resume", async () => {
  let release!: () => void;
  let emitted = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "pause-policy-effect",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await gate;
      const emission = {
        idempotency_key: "pause-policy-effect:baseline",
        event: {
          type: "baseline_result" as const,
          payload: {
            status: "skipped" as const,
            answer: null,
            confidence: null,
            skip_reason: "test",
          },
        },
      };
      const pending = context.emit(emission);
      Reflect.set(emission.event.payload, "skip_reason", "mutated after admission");
      await pending;
      emitted = true;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await runtime.pause(accepted.conversation_id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).toBe(false);
    expect(
      (await runtime.events(accepted.conversation_id, 0))?.some(
        (event) => event.event.type === "baseline_result",
      ),
    ).toBe(false);
    await runtime.resume(accepted.conversation_id);
    expect((await accepted.completion).result.status).toBe("completed");
    expect(emitted).toBe(true);
    expect(
      (await runtime.events(accepted.conversation_id, 0))?.find(
        (event) => event.event.type === "baseline_result",
      )?.event,
    ).toMatchObject({ type: "baseline_result", payload: { skip_reason: "test" } });
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("launchAttempt requested while PAUSED defers adapter start until durable resume", async () => {
  let release!: () => void;
  let requested = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const policy: ConversationPolicy = {
    name: "deferred-pause-attempt",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await gate;
      const request: PolicyAttemptRequest = {
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "after resume",
      };
      const attempt = context.launchAttempt(request);
      Reflect.set(request, "participantId", "forged-participant");
      Reflect.set(request, "promptInput", "forged prompt");
      requested = true;
      await attempt.completion;
      const emission = {
        idempotency_key: "deferred-pause-attempt:tool",
        event: {
          type: "tool_action" as const,
          payload: {
            tool: "read",
            action: "canonical action",
            status: "completed" as const,
            input_ref: null,
            output_ref: null,
          },
        },
      };
      const appended = attempt.emit(emission);
      Reflect.set(emission.event.payload, "action", "forged action");
      await appended;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  const { root, runtime } = await harness(policy, adapter);
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await runtime.pause(accepted.conversation_id);
    release();
    await waitFor(() => requested);
    expect(adapter.starts).toHaveLength(0);
    await runtime.resume(accepted.conversation_id);
    expect((await accepted.completion).result.status).toBe("completed");
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.starts[0]?.spawn.rendered_prompt).toContain("after resume");
    expect(adapter.starts[0]?.spawn.rendered_prompt).not.toContain("forged prompt");
    expect(
      (await runtime.events(accepted.conversation_id, 0))?.find(
        (event) => event.event.type === "tool_action",
      )?.event,
    ).toMatchObject({ type: "tool_action", payload: { action: "canonical action" } });
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("attempt chunks and lifecycle callbacks during PAUSED flush once after same-process resume", async () => {
  const adapter = new OrderedResumeAdapter();
  const { root, runtime, traceStore } = await harness(new DirectConversationPolicy(), adapter);
  try {
    const accepted = await runtime.start(createInput("direct"));
    await waitFor(() => adapter.starts.length === 1);
    await runtime.pause(accepted.conversation_id);
    const before = (await traceStore.readConversation(accepted.conversation_id)).length;
    adapter.starts[0]?.onChunk?.({ stream: "stdout", content: "paused chunk" });
    adapter.starts[0]?.onLifecycle?.("acknowledged");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await traceStore.readConversation(accepted.conversation_id)).length).toBe(before);
    await runtime.resume(accepted.conversation_id);
    expect(adapter.starts).toHaveLength(1);
    expect(adapter.reconciliations).toEqual([]);
    adapter.complete("attempt-1");
    expect((await accepted.completion).result.status).toBe("completed");
    const events = await runtime.events(accepted.conversation_id, 0);
    const pausedDeltas = events?.filter(
      (event) =>
        event.event.type === "agent_response_delta" &&
        event.event.payload.content_delta === "paused chunk",
    );
    const acknowledged = events?.filter(
      (event) =>
        event.event.type === "operation_lifecycle" && event.event.payload.state === "acknowledged",
    );
    expect(pausedDeltas).toHaveLength(1);
    expect(acknowledged).toHaveLength(1);
    expect(
      (pausedDeltas?.[0]?.seq ?? Number.POSITIVE_INFINITY) < (acknowledged?.[0]?.seq ?? 0),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("callbacks arriving during a PAUSED flush join one FIFO without stranding", async () => {
  const adapter = new OrderedResumeAdapter();
  let dispatchedStarted = false;
  let releaseDispatched!: () => void;
  const dispatchedGate = new Promise<void>((resolve) => {
    releaseDispatched = resolve;
  });
  const { root, runtime, traceStore } = await harness(
    new DirectConversationPolicy(),
    adapter,
    (store) => ({
      readConversation: (id) => store.readConversation(id),
      append: async (correlation, emission, native) => {
        if (
          emission.event.type === "operation_lifecycle" &&
          emission.event.payload.state === "dispatched" &&
          !dispatchedStarted
        ) {
          dispatchedStarted = true;
          await dispatchedGate;
        }
        return store.append(correlation, emission, native);
      },
    }),
  );
  try {
    const accepted = await runtime.start(createInput("direct"));
    await waitFor(() => adapter.starts.length === 1);
    await runtime.pause(accepted.conversation_id);
    adapter.starts[0]?.onLifecycle?.("dispatched");
    adapter.starts[0]?.onLifecycle?.("acknowledged");
    const resumed = runtime.resume(accepted.conversation_id);
    await waitFor(() => dispatchedStarted);
    adapter.starts[0]?.onLifecycle?.("completed");
    releaseDispatched();
    await resumed;
    adapter.complete("attempt-1");
    await accepted.completion;
    const ordered = (await traceStore.readConversation(accepted.conversation_id))
      .filter(({ stored_event: stored }) => stored.event.type === "operation_lifecycle")
      .map(({ stored_event: stored }) =>
        stored.event.type === "operation_lifecycle" ? stored.event.payload.state : null,
      )
      .filter(
        (state) => state === "dispatched" || state === "acknowledged" || state === "completed",
      );
    expect(ordered).toEqual(["dispatched", "acknowledged", "completed"]);
  } finally {
    releaseDispatched();
    await rm(root, { recursive: true, force: true });
  }
});

test("an immediate attempt callback cannot cross a concurrently prepared PAUSE", async () => {
  const policy: ConversationPolicy = {
    name: "callback-pause-microtask",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new OrderedResumeAdapter();
  const { root, runtime, traceStore } = await harness(policy, adapter);
  type RuntimeAuthority = {
    context(id: string): Promise<ConversationContext>;
    transition(id: string, lifecycle: "ACTIVE" | "PAUSED", health: "healthy"): Promise<void>;
  };
  try {
    const accepted = await runtime.start(createInput(policy.name));
    const authority = (runtime as unknown as { runtime: RuntimeAuthority }).runtime;
    const context = await authority.context(accepted.conversation_id);
    const attempt = context.launchAttempt({
      participantId: "participant-1",
      bindingIndex: 0,
      purpose: "direct",
      promptInput: "callback must wait for resume",
    });

    await authority.transition(accepted.conversation_id, "PAUSED", "healthy");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      (await traceStore.readConversation(accepted.conversation_id)).filter(
        ({ stored_event: stored }) =>
          stored.event.type === "operation_lifecycle" && stored.event.payload.state === "requested",
      ),
    ).toHaveLength(0);

    await authority.transition(accepted.conversation_id, "ACTIVE", "healthy");
    await waitFor(async () =>
      (await traceStore.readConversation(accepted.conversation_id)).some(
        ({ stored_event: stored }) =>
          stored.event.type === "operation_lifecycle" && stored.event.payload.state === "requested",
      ),
    );
    const attemptId = adapter.starts[0]?.attemptId;
    expect(attemptId).toBeTruthy();
    adapter.complete(attemptId ?? "");
    await attempt.completion;
    await runtime.stop(accepted.conversation_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two pause and resume cycles append distinct monotonic transition epochs", async () => {
  const policy: ConversationPolicy = {
    name: "transition-cycles",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy);
  try {
    await runtime.create(createInput("transition-cycles"));
    await runtime.pause("conversation-1");
    await runtime.resume("conversation-1");
    await runtime.pause("conversation-1");
    await runtime.resume("conversation-1");
    const transitions = (await traceStore.readConversation("conversation-1")).filter(
      ({ stored_event: stored }) => stored.idempotency_key.startsWith("conversation:transition:"),
    );
    expect(transitions.map(({ stored_event: stored }) => stored.event)).toEqual([
      {
        type: "state_change",
        payload: { lifecycle: "PAUSED", health: "healthy", terminal: false, reason: null },
      },
      {
        type: "state_change",
        payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
      },
      {
        type: "state_change",
        payload: { lifecycle: "PAUSED", health: "healthy", terminal: false, reason: null },
      },
      {
        type: "state_change",
        payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
      },
    ]);
    expect(
      new Set(transitions.map(({ stored_event: stored }) => stored.idempotency_key)).size,
    ).toBe(4);
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("ACTIVE");
    await runtime.stop("conversation-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime health authority changes health independently while ACTIVE or PAUSED", async () => {
  const { root, runtime } = await harness(
    new DirectConversationPolicy(),
    new FakeAdapter(),
    (store) => store,
    async () => materialized(),
    { schedule: () => {} },
  );
  try {
    const accepted = await runtime.start(createInput("direct"));
    const authority = (
      runtime as unknown as {
        runtime: { health(id: string, value: "healthy" | "degraded"): Promise<void> };
      }
    ).runtime;
    await authority.health(accepted.conversation_id, "degraded");
    expect(await runtime.snapshot(accepted.conversation_id)).toMatchObject({
      lifecycle: "ACTIVE",
      health: "degraded",
    });
    await runtime.pause(accepted.conversation_id);
    await authority.health(accepted.conversation_id, "healthy");
    expect(await runtime.snapshot(accepted.conversation_id)).toMatchObject({
      lifecycle: "PAUSED",
      health: "healthy",
    });
    await runtime.stop(accepted.conversation_id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health mutation cannot steal or reopen an in-flight PAUSE authority", async () => {
  const policy: ConversationPolicy = {
    name: "health-pause-barrier",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  let markPauseStarted!: () => void;
  let releasePause!: () => void;
  const pauseStarted = new Promise<void>((resolve) => {
    markPauseStarted = resolve;
  });
  const pauseGate = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  const { root, runtime } = await harness(policy, new FakeAdapter(), (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: async (correlation, emission, native) => {
      if (
        emission.event.type === "state_change" &&
        emission.event.payload.lifecycle === "PAUSED" &&
        !emission.event.payload.terminal
      ) {
        markPauseStarted();
        await pauseGate;
      }
      return store.append(correlation, emission, native);
    },
  }));
  type RuntimeAuthority = {
    transition(id: string, lifecycle: "ACTIVE" | "PAUSED", health: "healthy"): Promise<void>;
    health(id: string, health: "healthy" | "degraded"): Promise<void>;
  };
  try {
    const accepted = await runtime.start(createInput(policy.name));
    const authority = (runtime as unknown as { runtime: RuntimeAuthority }).runtime;
    const pausing = authority.transition(accepted.conversation_id, "PAUSED", "healthy");
    await pauseStarted;

    await expect(authority.health(accepted.conversation_id, "degraded")).rejects.toBeInstanceOf(
      OperationTransitionReservedError,
    );
    releasePause();
    await pausing;
    expect(await runtime.snapshot(accepted.conversation_id)).toMatchObject({
      lifecycle: "PAUSED",
      health: "healthy",
    });

    await authority.health(accepted.conversation_id, "degraded");
    expect(await runtime.snapshot(accepted.conversation_id)).toMatchObject({
      lifecycle: "PAUSED",
      health: "degraded",
    });
    await runtime.resume(accepted.conversation_id);
    await runtime.stop(accepted.conversation_id);
  } finally {
    releasePause();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed PAUSE and RESUME appends restore the prior emission authority", async () => {
  const policy: ConversationPolicy = {
    name: "transition-retry",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  let failPause = true;
  let failResume = true;
  const { root, runtime } = await harness(policy, new FakeAdapter(), (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: (correlation, input, native) => {
      if (input.idempotency_key.startsWith("conversation:transition:")) {
        if (
          input.event.type === "state_change" &&
          input.event.payload.lifecycle === "PAUSED" &&
          failPause
        ) {
          failPause = false;
          return Promise.reject(new Error("injected pause failure"));
        }
        if (
          input.event.type === "state_change" &&
          input.event.payload.lifecycle === "ACTIVE" &&
          failResume
        ) {
          failResume = false;
          return Promise.reject(new Error("injected resume failure"));
        }
      }
      return store.append(correlation, input, native);
    },
  }));
  try {
    await runtime.create(createInput("transition-retry"));
    await expect(runtime.pause("conversation-1")).rejects.toThrow("injected pause failure");
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("ACTIVE");
    await runtime.pause("conversation-1");
    await expect(runtime.resume("conversation-1")).rejects.toThrow("injected resume failure");
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("PAUSED");
    await runtime.resume("conversation-1");
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("ACTIVE");
    await runtime.stop("conversation-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit resume reconciles one persisted native binding and exact attempts consume it", async () => {
  const nativeSessionId = "00000000-0000-4000-8000-000000000123";
  let context!: ConversationContext;
  const policy: ConversationPolicy = {
    name: "exact-resume",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      value.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "capture native",
      });
      await new Promise<void>((resolve) =>
        value.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { operation_id: value.correlation.operation_id, status: "aborted", artifact_refs: [] };
    },
  };
  const adapter = new FakeAdapter();
  adapter.nativeSessionId = nativeSessionId;
  const { root, runtime, traceStore } = await harness(policy, adapter);
  const creating = runtime.create(createInput("exact-resume"));
  try {
    await waitFor(() => context !== undefined);
    await waitFor(
      () =>
        new ConversationArtifactStore({ dir: join(root, "manifests") }).readRecord("conversation-1")
          ?.resume_bindings.length === 1,
    );
    await runtime.pause("conversation-1");

    const restartAdapter = new FakeAdapter();
    const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    const restartCounters = new Map<string, number>();
    const restarted = new ConversationOrchestrator({
      traceStore,
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: restartAdapter,
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => {
        const next = (restartCounters.get(kind) ?? 0) + 1;
        restartCounters.set(kind, next);
        return `restart-${kind}-${next}`;
      },
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    await restarted.resume("conversation-1");
    expect(restartAdapter.reconciliations).toEqual([{ engine: "codex", nativeSessionId }]);
    const restoredAuthority = (
      restarted as unknown as { runtime: { context(id: string): Promise<ConversationContext> } }
    ).runtime;
    const restoredContext = await restoredAuthority.context("conversation-1");
    const resumedAttempt = restoredContext.launchAttempt({
      participantId: "participant-1",
      bindingIndex: 0,
      purpose: "direct",
      promptInput: "resume exact",
    });
    await resumedAttempt.completion;
    expect(restartAdapter.starts).toHaveLength(1);
    expect(restartAdapter.starts[0]?.nativeSessionId).toBe(nativeSessionId);
    expect(restartAdapter.starts[0]?.spawn.sessionMode).toBe("exact");
    const history = (await restarted.events("conversation-1", 0))?.find(
      (event) => event.event.type === "native_history_reconciled",
    );
    expect(history?.event).toMatchObject({
      type: "native_history_reconciled",
      payload: { status: "unavailable", completeness_reason: "fake" },
    });
    expect(JSON.stringify(history)).not.toContain(nativeSessionId);
    const resumedEvents = await restarted.events("conversation-1", 0);
    expect(history).toMatchObject({
      operation_id: "operation-1",
      attempt_id: "restart-attempt-1",
      parent_attempt_id: "attempt-1",
    });
    const resumedLifecycle = resumedEvents?.find(
      (event) =>
        event.event.type === "operation_lifecycle" && event.attempt_id === "restart-attempt-2",
    );
    expect(resumedLifecycle).toMatchObject({
      operation_id: "operation-1",
      parent_attempt_id: "attempt-1",
    });
    const operationsByAttempt = new Map<string, Set<string>>();
    for (const event of resumedEvents ?? []) {
      if (event.attempt_id === "control" || event.attempt_id === "coordinator") continue;
      const operations =
        operationsByAttempt.get(event.attempt_id as unknown as string) ?? new Set();
      operations.add(event.operation_id as unknown as string);
      operationsByAttempt.set(event.attempt_id as unknown as string, operations);
    }
    expect([...operationsByAttempt.values()].every((operations) => operations.size === 1)).toBe(
      true,
    );
  } finally {
    await runtime.stop("conversation-1").catch(() => undefined);
    await creating.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile retry skips durable participants and reuses the failed participant attempt", async () => {
  const nativeIds = [
    "00000000-0000-4000-8000-000000000111",
    "00000000-0000-4000-8000-000000000222",
  ] as const;
  const policy: ConversationPolicy = {
    name: "reconcile-retry",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    },
    async continueAfterApproval(context) {
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime, traceStore } = await harness(policy);
  let restarted: ConversationOrchestrator | undefined;
  try {
    await runtime.create(createInput(policy.name, 2));
    const store = new ConversationArtifactStore({ dir: join(root, "manifests") });
    for (const [index, nativeSessionId] of nativeIds.entries()) {
      store.recordResumeBinding("conversation-1", `participant-${index + 1}`, {
        attemptId: `old-attempt-${index + 1}`,
        engine: "codex",
        nativeSessionId,
      });
    }
    await runtime.pause("conversation-1");

    const appendAttempts: Array<{ participant: string; attempt: string; key: string }> = [];
    let failSecond = true;
    const adapter = new FakeAdapter();
    const counters = new Map<string, number>();
    restarted = new ConversationOrchestrator({
      traceStore: {
        readConversation: (id) => traceStore.readConversation(id),
        append: async (correlation, emission, native) => {
          if (emission.event.type === "native_history_reconciled") {
            appendAttempts.push({
              participant: correlation.participant_id ?? "",
              attempt: correlation.attempt_id,
              key: emission.idempotency_key,
            });
            if (correlation.participant_id === "participant-2" && failSecond) {
              failSecond = false;
              throw new Error("injected second reconcile append failure");
            }
          }
          return traceStore.append(correlation, emission, native);
        },
      },
      artifactRegistry: new DurableArtifactRegistry({ dir: join(root, "opaque") }),
      artifactStore: store,
      sessionAdapter: adapter,
      policies: new ConversationPolicyRegistry([policy]),
      id: (kind) => {
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        return `restart-${kind}-${next}`;
      },
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
    await expect(restarted.resume("conversation-1")).rejects.toThrow(
      "injected second reconcile append failure",
    );
    await restarted.resume("conversation-1");
    expect(appendAttempts).toEqual([
      {
        participant: "participant-1",
        attempt: "restart-attempt-1",
        key: "native-history:participant-1:restart-attempt-1",
      },
      {
        participant: "participant-2",
        attempt: "restart-attempt-2",
        key: "native-history:participant-2:restart-attempt-2",
      },
      {
        participant: "participant-2",
        attempt: "restart-attempt-2",
        key: "native-history:participant-2:restart-attempt-2",
      },
    ]);
    const reconciled = (await restarted.events("conversation-1", 0))?.filter(
      (event) => event.event.type === "native_history_reconciled",
    );
    expect(reconciled).toHaveLength(2);
    expect(adapter.reconciliations.map(({ nativeSessionId }) => nativeSessionId)).toEqual([
      nativeIds[0],
      nativeIds[1],
      nativeIds[1],
    ]);
  } finally {
    await restarted?.stop("conversation-1").catch(() => undefined);
    await runtime.stop("conversation-1").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a captured native binding authorizes the next same-participant attempt immediately", async () => {
  const nativeSessionId = "00000000-0000-4000-8000-000000000321";
  const policy: ConversationPolicy = {
    name: "sequential-native",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      const first = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "first",
      });
      await first.completion;
      const second = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "second",
      });
      await second.completion;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  adapter.nativeSessionId = nativeSessionId;
  const { root, runtime } = await harness(policy, adapter);
  try {
    await runtime.create(createInput("sequential-native"));
    expect(adapter.starts).toHaveLength(2);
    expect(adapter.starts[0]?.spawn.sessionMode).toBe("fresh");
    expect(adapter.starts[1]).toMatchObject({
      nativeSessionId,
      spawn: { sessionMode: "exact" },
    });
    const second = (await runtime.events("conversation-1", 0))?.find(
      (event) => event.attempt_id === "attempt-2" && event.event.type === "operation_lifecycle",
    );
    expect(second).toMatchObject({ parent_attempt_id: "attempt-1" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed admitted attempt append never publishes a native resume binding", async () => {
  let rejected = false;
  let injected = false;
  const policy: ConversationPolicy = {
    name: "failed-resume-capture",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      const attempt = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "must fail",
      });
      try {
        await attempt.completion;
      } catch {
        rejected = true;
      }
      return {
        operation_id: context.correlation.operation_id,
        status: "failed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  adapter.nativeSessionId = "00000000-0000-4000-8000-000000000444";
  const { root, runtime } = await harness(policy, adapter, (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: (correlation, emission, native) => {
      if (!injected && emission.event.type === "operation_lifecycle") {
        injected = true;
        return Promise.reject(new Error("injected lifecycle append failure"));
      }
      return store.append(correlation, emission, native);
    },
  }));
  try {
    const created = await runtime.create(createInput(policy.name));
    expect({ injected, rejected, status: created.result.status }).toEqual({
      injected: true,
      rejected: true,
      status: "failed",
    });
    expect(
      new ConversationArtifactStore({ dir: join(root, "manifests") }).readRecord("conversation-1")
        ?.resume_bindings,
    ).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent native captures retain the latest-launched participant authority", async () => {
  const adapter = new OrderedResumeAdapter();
  const policy: ConversationPolicy = {
    name: "concurrent-native",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      const first = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "first",
      });
      const second = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "second",
      });
      adapter.complete("attempt-2");
      await second.completion;
      adapter.complete("attempt-1");
      await first.completion;
      const third = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "third",
      });
      expect(adapter.starts[2]).toMatchObject({
        nativeSessionId: "00000000-0000-4000-8000-000000000002",
        spawn: { sessionMode: "exact" },
      });
      adapter.complete("attempt-3");
      await third.completion;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy, adapter);
  try {
    await runtime.create(createInput("concurrent-native"));
    const third = (await runtime.events("conversation-1", 0))?.find(
      (event) => event.attempt_id === "attempt-3" && event.event.type === "operation_lifecycle",
    );
    expect(third).toMatchObject({ parent_attempt_id: "attempt-2" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ACTIVE message injects; COMPLETED message creates one idempotent child revision", async () => {
  let release!: () => void;
  let childRehydrateCalls = 0;
  let activeContext!: ConversationContext;
  const observedMessages = new Map<string, string[]>();
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: ConversationPolicy = {
    name: "held-message",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      if (value.correlation.conversation_id === "conversation-1") {
        activeContext = value;
        await gate;
      }
      observedMessages.set(
        value.correlation.conversation_id,
        (await value.messages()).map(({ content }) => content),
      );
      return {
        operation_id: value.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const activeHarness = await harness(
    held,
    new FakeAdapter(),
    (store) => store,
    async () => {
      childRehydrateCalls += 1;
      return materialized();
    },
  );
  try {
    const creating = activeHarness.runtime.create(createInput("held-message"));
    await waitFor(() => activeContext !== undefined);
    const activeRequest = {
      content: "new constraint",
      target_participants: ["participant-1"],
    };
    const activePending = activeHarness.runtime.message("conversation-1", activeRequest);
    Reflect.set(activeRequest, "content", "mutated constraint");
    activeRequest.target_participants[0] = "forged-participant";
    const activeResponse = await activePending;
    expect(activeResponse).toMatchObject({ accepted: true });
    expect(activeResponse.child_conversation_id).toBeUndefined();
    expect(
      (await activeHarness.runtime.events("conversation-1", 0))?.find(
        (event) => event.event.type === "user_message",
      )?.event,
    ).toMatchObject({ type: "user_message", payload: { content: "new constraint" } });
    release();
    await creating;
    expect(observedMessages.get("conversation-1")).toEqual(["new constraint"]);

    const request = { content: "revise it", target_participants: "all" as const };
    const unknownRequest = { content: "unknown target", target_participants: ["missing"] };
    const unknownChild = conversationChildId("conversation-1", unknownRequest);
    await expect(activeHarness.runtime.message("conversation-1", unknownRequest)).rejects.toThrow(
      "unknown target participant",
    );
    expect(await activeHarness.runtime.events(unknownChild, 0)).toBeNull();
    expect(
      new ConversationArtifactStore({ dir: join(activeHarness.root, "manifests") }).readRecord(
        "conversation-1",
      )?.child_revisions,
    ).toEqual({});
    const authority = (
      activeHarness.runtime as unknown as {
        runtime: { snapshot(id: string): ReturnType<ConversationOrchestrator["snapshot"]> };
      }
    ).runtime;
    const snapshot = authority.snapshot.bind(authority);
    let completedSnapshots = 0;
    let releaseSnapshots!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshots = resolve;
    });
    authority.snapshot = async (id) => {
      const value = await snapshot(id);
      if (id === "conversation-1" && value?.lifecycle === "COMPLETED") {
        completedSnapshots += 1;
        if (completedSnapshots === 2) releaseSnapshots();
        await snapshotGate;
      }
      return value;
    };
    const firstMessage = activeHarness.runtime.message("conversation-1", request);
    const repeatMessage = activeHarness.runtime.message("conversation-1", request);
    const [first, repeat] = await Promise.all([firstMessage, repeatMessage]);
    expect(childRehydrateCalls).toBe(1);
    expect(repeat).toEqual(first);
    expect(first.child_conversation_id).toBeTruthy();
    expect(first.location).toBe(`/api/conversations/${first.child_conversation_id}`);
    expect((await activeHarness.runtime.snapshot("conversation-1"))?.lifecycle).toBe("COMPLETED");
    const childId = first.child_conversation_id;
    if (!childId) throw new Error("child conversation was not created");
    await waitFor(() => observedMessages.has(childId));
    expect(observedMessages.get(childId)).toEqual(["revise it"]);
    await waitFor(
      async () => (await activeHarness.runtime.snapshot(childId))?.lifecycle === "COMPLETED",
    );
    const child = await activeHarness.runtime.events(childId, 0);
    expect(child?.[0]?.event.type).toBe("conversation_configured");
    expect(child?.some((event) => event.event.type === "user_message")).toBe(true);
    expect(child?.some((event) => event.event.type === "participant_bound")).toBe(true);
    expect(child?.some((event) => event.event.type === "state_change")).toBe(true);
    expect(child?.[0]?.revision_id).not.toBe(
      (await activeHarness.runtime.events("conversation-1", 0))?.[0]?.revision_id,
    );
    expect(await activeHarness.runtime.message("conversation-1", { content: "revise it" })).toEqual(
      first,
    );
    const targeted = await activeHarness.runtime.message("conversation-1", {
      content: "targeted revision",
      target_participants: ["participant-1", "participant-1"],
    });
    expect(
      await activeHarness.runtime.message("conversation-1", {
        content: "targeted revision",
        target_participants: ["participant-1"],
      }),
    ).toEqual(targeted);
    const targetedChildId = targeted.child_conversation_id;
    if (!targetedChildId) throw new Error("targeted child conversation was not created");
    const targetedEvents = await activeHarness.runtime.events(targetedChildId, 0);
    expect(
      targetedEvents?.find((event) => event.event.type === "user_message")?.event
        .payload as unknown,
    ).toEqual({ content: "targeted revision", target_participants: ["participant-1"] });
  } finally {
    await rm(activeHarness.root, { recursive: true, force: true });
  }
});

test("a failed child configuration is never linked and a retry completes the same child", async () => {
  let failChild = true;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const { root, runtime } = await harness(
    new DirectConversationPolicy(),
    new FakeAdapter(),
    (store) => ({
      readConversation: (id) => store.readConversation(id),
      append: (correlation, emission, native) => {
        if (
          failChild &&
          correlation.conversation_id !== "conversation-1" &&
          emission.event.type === "participant_bound"
        ) {
          failChild = false;
          return Promise.reject(new Error("injected child configure failure"));
        }
        return store.append(correlation, emission, native);
      },
    }),
  );
  const request = { content: "retry child", target_participants: "all" as const };
  try {
    await runtime.create(createInput("direct"));
    await expect(runtime.message("conversation-1", request)).rejects.toThrow(
      "injected child configure failure",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    const retry = await runtime.message("conversation-1", request);
    const childId = retry.child_conversation_id;
    expect(childId).toBeTruthy();
    if (!childId) throw new Error("child was not recovered");
    const events = await runtime.events(childId, 0);
    expect(events?.[0]?.event.type).toBe("conversation_configured");
    expect(events?.some((event) => event.event.type === "participant_bound")).toBe(true);
    expect(events?.some((event) => event.event.type === "state_change")).toBe(true);
    expect(events?.some((event) => event.event.type === "user_message")).toBe(true);
    await waitFor(async () => (await runtime.snapshot(childId))?.lifecycle === "COMPLETED");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await rm(root, { recursive: true, force: true });
  }
});

test("two services converge on one durable child execution for the same completed revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-shared-child-"));
  const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
  let event = 0;
  const makeService = (label: string, adapter: FakeAdapter) => {
    const traceStore = new TraceStore({
      dir: join(root, "trace"),
      artifactRegistry: artifacts,
      eventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, "0")}`,
      now: () => "2026-08-22T00:00:00.000Z",
    });
    const counters = new Map<string, number>();
    return new ConversationOrchestrator({
      traceStore,
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: adapter,
      policies: new ConversationPolicyRegistry([new DirectConversationPolicy()]),
      id: (kind) => {
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        return kind === "conversation" ? `conversation-${next}` : `${label}-${kind}-${next}`;
      },
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
  };
  const firstAdapter = new FakeAdapter();
  const secondAdapter = new FakeAdapter();
  const firstService = makeService("first", firstAdapter);
  const secondService = makeService("second", secondAdapter);
  try {
    await firstService.create(createInput("direct"));
    const left = {
      content: "shared revision",
      target_participants: ["participant-1", "participant-1"],
    };
    const right = { content: "shared revision", target_participants: ["participant-1"] };
    const [first, second] = await Promise.all([
      firstService.message("conversation-1", left),
      secondService.message("conversation-1", right),
    ]);
    expect(second).toEqual(first);
    const childId = first.child_conversation_id;
    if (!childId) throw new Error("shared child conversation was not created");
    await waitFor(async () => (await firstService.snapshot(childId))?.lifecycle === "COMPLETED");
    expect(firstAdapter.starts.length + secondAdapter.starts.length).toBe(2);
    const events = await firstService.events(childId, 0);
    expect(events?.filter((item) => item.event.type === "user_message")).toHaveLength(1);
    expect(
      events?.find((item) => item.event.type === "user_message")?.event.payload as unknown,
    ).toEqual({ content: "shared revision", target_participants: ["participant-1"] });
    expect(events?.filter((item) => item.event.type === "conversation_terminal")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("racing child revisions keep one durable operation chain and cancellable owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-child-operation-race-"));
  const artifacts = new DurableArtifactRegistry({ dir: join(root, "opaque") });
  let releaseActive!: () => void;
  let activeWritten!: () => void;
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const activeStored = new Promise<void>((resolve) => {
    activeWritten = resolve;
  });
  let event = 0;
  const makeService = (label: string, adapter: EngineSessionAdapter, blockChildActive = false) => {
    const store = new TraceStore({
      dir: join(root, "trace"),
      artifactRegistry: artifacts,
      eventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, "0")}`,
      now: () => "2026-08-22T00:00:00.000Z",
    });
    const traceStore = blockChildActive
      ? {
          readConversation: (id: string) => store.readConversation(id),
          append: async (...args: Parameters<TraceStore["append"]>) => {
            const stored = await store.append(...args);
            if (
              args[0].conversation_id !== "conversation-1" &&
              args[1].idempotency_key === "conversation:active"
            ) {
              activeWritten();
              await activeGate;
            }
            return stored;
          },
        }
      : store;
    const counters = new Map<string, number>();
    return new ConversationOrchestrator({
      traceStore,
      artifactRegistry: artifacts,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: adapter,
      policies: new ConversationPolicyRegistry([new DirectConversationPolicy()]),
      id: (kind) => {
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        return kind === "conversation" ? `conversation-${next}` : `${label}-${kind}-${next}`;
      },
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async () => materialized(),
    });
  };
  const first = makeService("first-race", new FakeAdapter(), true);
  const winningAdapter = new OrderedResumeAdapter();
  const second = makeService("second-race", winningAdapter);
  let childId: string | undefined;
  try {
    await first.create(createInput("direct"));
    const request = { content: "racing child operation", target_participants: "all" as const };
    const losing = first.message("conversation-1", request);
    await activeStored;
    const winner = await second.message("conversation-1", request);
    childId = winner.child_conversation_id;
    if (!childId) throw new Error("child conversation was not created");
    await waitFor(() => winningAdapter.starts.length === 1);
    releaseActive();
    await expect(losing).resolves.toEqual(winner);
    const events = await second.events(childId, 0);
    const attemptId = winningAdapter.starts[0]?.attemptId;
    const operationId = events?.find((item) => item.attempt_id === attemptId)?.operation_id;
    expect(operationId).toBeTruthy();
    if (!operationId) throw new Error("child attempt operation was not recorded");
    expect(new Set(events?.map((item) => item.operation_id))).toEqual(new Set([operationId]));
    const cold = makeService("cold-race", new FakeAdapter());
    await expect(
      cold.cancelOperation({
        conversation_id: childId,
        operation_id: operationId,
        actor: "user",
        reason: "cancel raced child",
      }),
    ).resolves.toEqual({
      status: 202,
      body: { operation_id: operationId, cancelled: true },
    });
  } finally {
    releaseActive();
    for (const started of winningAdapter.starts) winningAdapter.complete(started.attemptId);
    if (childId) {
      await waitFor(async () =>
        ["COMPLETED", "FAILED", "ABORTED"].includes(
          (await second.snapshot(childId as string))?.lifecycle ?? "",
        ),
      ).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("subscriber replay failure deactivates the cursor instead of delivering a gapful live tail", async () => {
  let release!: () => void;
  let failRead = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  const policy: ConversationPolicy = {
    name: "replay-failure",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      await gate;
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy, new FakeAdapter(), (store) => ({
    append: (correlation, emission, native) => store.append(correlation, emission, native),
    readConversation: (id) =>
      failRead ? Promise.reject(new Error("injected replay failure")) : store.readConversation(id),
  }));
  process.on("unhandledRejection", onUnhandled);
  try {
    const accepted = await runtime.start(createInput("replay-failure"));
    failRead = true;
    const observed: string[] = [];
    runtime.subscribe(accepted.conversation_id, (event) => observed.push(event.event.type));
    await new Promise((resolve) => setTimeout(resolve, 0));
    failRead = false;
    await runtime.message(accepted.conversation_id, {
      content: "live",
      target_participants: "all",
    });
    expect(unhandled).toEqual([]);
    expect(observed).toEqual([]);
    release();
    await accepted.completion;
  } finally {
    process.off("unhandledRejection", onUnhandled);
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact content is durable, idempotent, opaque, updateable, and rejected after terminal", async () => {
  let context!: ConversationContext;
  let artifactId = "";
  let originalRef = "";
  let updatedRef = "";
  let conflict = false;
  const policy: ConversationPolicy = {
    name: "artifacts",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      context = value;
      const request = {
        artifact_type: "synthesis" as const,
        content: "version one",
        idempotency_key: "artifact:create",
      };
      const created = await value.createArtifact(request);
      artifactId = created.artifact_id;
      originalRef = created.ref;
      expect(await value.createArtifact(request)).toEqual(created);
      try {
        await value.createArtifact({ ...request, content: "conflicting content" });
      } catch {
        conflict = true;
      }
      const updated = await value.updateArtifact({
        ...request,
        artifact_id: created.artifact_id,
        previous_ref: created.ref,
        content: "version two",
        idempotency_key: "artifact:update",
      });
      updatedRef = updated.ref;
      return {
        operation_id: value.correlation.operation_id,
        status: "completed",
        artifact_refs: [updated.ref],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    const outcome = await runtime.create(createInput("artifacts"));
    expect(conflict).toBe(true);
    expect(outcome.result.artifact_refs).toEqual([artifactId]);
    expect(JSON.stringify(outcome.result)).not.toContain("vf-artifact-");
    const restarted = new ConversationArtifactStore({ dir: join(root, "manifests") });
    expect(new TextDecoder().decode(restarted.readArtifact("conversation-1", artifactId))).toBe(
      "version two",
    );
    expect(new TextDecoder().decode(restarted.readArtifactRef("conversation-1", originalRef))).toBe(
      "version one",
    );
    expect(new TextDecoder().decode(restarted.readArtifactRef("conversation-1", updatedRef))).toBe(
      "version two",
    );
    expect(restarted.readArtifactRef("another-conversation", updatedRef)).toBeNull();
    const artifacts = (await runtime.events("conversation-1", 0))?.filter(
      (event) => event.event.type === "artifact_created" || event.event.type === "artifact_updated",
    );
    expect(artifacts).toHaveLength(2);
    expect(JSON.stringify(artifacts)).not.toContain("vf-artifact-");
    await expect(
      context.createArtifact({
        artifact_type: "synthesis",
        content: "too late",
        idempotency_key: "artifact:late",
      }),
    ).rejects.toThrow("closed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("policy and artifact keys cannot poison reserved terminal authority", async () => {
  const rejected: string[] = [];
  const policy: ConversationPolicy = {
    name: "reserved-key-poisoning",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      try {
        await context.emit({
          idempotency_key: "conversation:terminal-state",
          event: {
            type: "baseline_result",
            payload: { status: "skipped", answer: null, confidence: null, skip_reason: "poison" },
          },
        });
      } catch (error) {
        rejected.push((error as Error).message);
      }
      try {
        await context.createArtifact({
          artifact_type: "synthesis",
          content: "must never reserve the terminal slot",
          idempotency_key: "conversation:terminal",
        });
      } catch (error) {
        rejected.push((error as Error).message);
      }
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    const outcome = await runtime.create(createInput(policy.name));
    expect(rejected).toEqual([
      "policy idempotency key uses reserved runtime authority",
      "policy idempotency key uses reserved runtime authority",
    ]);
    expect(outcome.result.status).toBe("completed");
    expect((await runtime.snapshot(outcome.conversation_id))?.lifecycle).toBe("COMPLETED");
    expect(
      new ConversationArtifactStore({ dir: join(root, "manifests") }).readRecord(
        outcome.conversation_id,
      )?.artifacts,
    ).toEqual([]);
    const events = await runtime.events(outcome.conversation_id, 0);
    expect(events?.filter(({ event }) => event.type === "conversation_terminal")).toHaveLength(1);
    expect(events?.some(({ event }) => event.type === "baseline_result")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["/tmp/private-artifact", `vf-artifact-${"f".repeat(64)}`])(
  "forged policy artifact ref %s fails closed",
  async (forged) => {
    const policy: ConversationPolicy = {
      name: `forged-artifact-${forged.length}`,
      async dryRun() {
        return {
          participants: [],
          evaluator_auto_added: false,
          engines_available: [],
          models_valid: true,
        };
      },
      async execute(context) {
        return {
          operation_id: context.correlation.operation_id,
          status: "completed",
          artifact_refs: [forged],
        };
      },
    };
    const { root, runtime } = await harness(policy);
    try {
      const outcome = await runtime.create(createInput(policy.name));
      expect(outcome.result).toEqual({
        operation_id: "operation-1",
        status: "failed",
        artifact_refs: [],
      });
      expect((await runtime.snapshot(outcome.conversation_id))?.lifecycle).toBe("FAILED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("artifact authority rolls back when its canonical trace append fails", async () => {
  let rejected = false;
  const policy: ConversationPolicy = {
    name: "artifact-append-failure",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      try {
        await context.createArtifact({
          artifact_type: "synthesis",
          content: "must not survive",
          idempotency_key: "artifact:rollback",
        });
      } catch (error) {
        rejected = (error as Error).message === "injected artifact append failure";
      }
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const { root, runtime } = await harness(policy, new FakeAdapter(), (store) => ({
    readConversation: (id) => store.readConversation(id),
    append: (correlation, input, native) =>
      input.event.type === "artifact_created"
        ? Promise.reject(new Error("injected artifact append failure"))
        : store.append(correlation, input, native),
  }));
  try {
    await runtime.create(createInput("artifact-append-failure"));
    expect(rejected).toBe(true);
    const restarted = new ConversationArtifactStore({ dir: join(root, "manifests") });
    expect(restarted.readRecord("conversation-1")?.artifacts).toEqual([]);
    expect(restarted.readArtifact("conversation-1", "artifact-1")).toBeNull();
    expect(readdirSync(join(root, "manifests", "content"))).toEqual([]);
    expect(
      (await runtime.events("conversation-1", 0))?.some(
        (event) => event.event.type === "artifact_created",
      ),
    ).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill provenance and attempt evidence stay on the exact correlated emission", async () => {
  const policy: ConversationPolicy = {
    name: "evidence",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(value) {
      const attempt = value.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "verify",
        promptInput: "collect evidence",
      });
      await attempt.completion;
      await attempt.emit({
        idempotency_key: "evidence:tool",
        event: {
          type: "tool_action",
          payload: {
            tool: "read",
            action: "inspect",
            status: "completed",
            input_ref: null,
            output_ref: null,
          },
        },
      });
      return {
        operation_id: value.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const adapter = new FakeAdapter();
  adapter.evidenceRef = "/private/runtime/attempt-evidence.json";
  const { root, runtime } = await harness(policy, adapter);
  try {
    await runtime.create(createInput("evidence", 1, true));
    const events = await runtime.events("conversation-1", 0);
    const skill = events?.find((event) => event.event.type === "skill_injected");
    expect(skill).toMatchObject({
      participant_id: "participant-1",
      role_ref: "direct",
      skill_refs: ["runtime-portability"],
      skill_resolved_hashes: [SKILL_HASH],
    });
    const tool = events?.find((event) => event.event.type === "tool_action");
    expect(tool?.evidence_refs).toHaveLength(1);
    expect(JSON.stringify(tool)).not.toContain(adapter.evidenceRef);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous direct attempts persist a partial response but never claim completion", async () => {
  const adapter = new FakeAdapter();
  adapter.ambiguous = true;
  const { root, runtime } = await harness(new DirectConversationPolicy(), adapter);
  try {
    const created = await runtime.create(createInput("direct"));
    expect(created.result.status).toBe("failed");
    const response = (await runtime.events("conversation-1", 0))?.find(
      (event) => event.event.type === "agent_response_delta",
    );
    expect(response?.event).toMatchObject({
      type: "agent_response_delta",
      payload: { completes_response: false, final_claim: null },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct policy persists ordered engine chunks once before an empty completion marker", async () => {
  const adapter = new FakeAdapter();
  adapter.chunks = ["first ", "second"];
  adapter.output = "first second";
  const { root, runtime } = await harness(new DirectConversationPolicy(), adapter);
  try {
    await runtime.create(createInput("direct"));
    const deltas = (await runtime.events("conversation-1", 0))?.filter(
      (event) => event.event.type === "agent_response_delta",
    );
    expect(
      deltas?.map((event) =>
        event.event.type === "agent_response_delta"
          ? [String(event.event.payload.content_delta), event.event.payload.completes_response]
          : null,
      ),
    ).toEqual([
      ["first ", false],
      ["second", false],
      ["", true],
    ]);
    expect(
      (await runtime.snapshot("conversation-1"))?.rounds[0]?.participant_responses[0]?.content,
    ).toBe("first second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forged policy operation result fails closed and terminal controls reject illegal lifecycle", async () => {
  const policy: ConversationPolicy = {
    name: "forged-result",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute() {
      return { operation_id: "forged", status: "completed", artifact_refs: [] };
    },
  };
  const { root, runtime } = await harness(policy);
  try {
    const created = await runtime.create(createInput("forged-result"));
    expect(created.result).toEqual({
      operation_id: "operation-1",
      status: "failed",
      artifact_refs: [],
    });
    expect((await runtime.snapshot("conversation-1"))?.lifecycle).toBe("FAILED");
    await expect(runtime.pause("conversation-1")).rejects.toThrow("pause requires ACTIVE");
    await expect(runtime.resume("conversation-1")).rejects.toThrow("resume requires PAUSED");
    await expect(runtime.stop("conversation-1")).rejects.toThrow("terminal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listener exceptions are contained and unsubscribe suppresses queued replay", async () => {
  const { root, runtime } = await harness(new DirectConversationPolicy());
  try {
    await runtime.create(createInput("direct"));
    let safeCalls = 0;
    runtime.subscribe("conversation-1", () => {
      throw new Error("listener failure");
    });
    runtime.subscribe("conversation-1", () => {
      safeCalls += 1;
    });
    let removedCalls = 0;
    const unsubscribe = runtime.subscribe("conversation-1", () => {
      removedCalls += 1;
    });
    unsubscribe?.();
    await waitFor(() => safeCalls > 0);
    expect(removedCalls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deferred start failure cannot authorize a child attempt parent", async () => {
  let policyReady = false;
  let deferredCreated = false;
  let childRejected = false;
  let releaseLaunch!: () => void;
  const launchGate = new Promise<void>((resolve) => {
    releaseLaunch = resolve;
  });
  const policy: ConversationPolicy = {
    name: "failed-deferred-parent",
    async dryRun() {
      return {
        participants: [],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      };
    },
    async execute(context) {
      policyReady = true;
      await launchGate;
      const failed = context.launchAttempt({
        participantId: "participant-1",
        bindingIndex: 0,
        purpose: "direct",
        promptInput: "fails after resume",
      });
      deferredCreated = true;
      await failed.completion.catch(() => undefined);
      try {
        const child = context.launchAttempt({
          participantId: "participant-1",
          bindingIndex: 0,
          purpose: "direct",
          promptInput: "must not inherit failed authority",
          parent: failed.ref,
        });
        await child.completion;
      } catch {
        childRejected = true;
      }
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [],
      };
    },
  };
  const starts: EngineSessionRequest[] = [];
  const adapter: EngineSessionAdapter = {
    start(request) {
      starts.push(request);
      if (starts.length === 1) throw new Error("injected deferred start failure");
      request.onLifecycle?.("requested");
      return {
        attemptId: request.attemptId,
        completion: Promise.resolve(completed(request.attemptId)),
        terminate: async () => {},
        readResumeBinding: () => undefined,
        readEvidenceBinding: () => undefined,
      };
    },
    async reconcileHistory() {
      return {
        status: "unavailable",
        imported_turn_count: 0,
        imported_tool_count: 0,
        completeness_reason: "not used",
      };
    },
  };
  const { root, runtime } = await harness(policy, adapter);
  try {
    const accepted = await runtime.start(createInput(policy.name));
    await waitFor(() => policyReady);
    await runtime.pause(accepted.conversation_id);
    releaseLaunch();
    await waitFor(() => deferredCreated);
    await runtime.resume(accepted.conversation_id);
    expect((await accepted.completion).result.status).toBe("completed");
    expect(childRejected).toBe(true);
    expect(starts).toHaveLength(1);
    expect(
      (await runtime.events(accepted.conversation_id, 0))?.some(
        (event) => event.parent_attempt_id !== undefined,
      ),
    ).toBe(false);
  } finally {
    releaseLaunch();
    await rm(root, { recursive: true, force: true });
  }
});
