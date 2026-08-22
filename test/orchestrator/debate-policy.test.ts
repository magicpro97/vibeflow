import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBinding,
  MaterializedAgentBinding,
  ResolvedAgentBinding,
} from "../../src/agents/binding.js";
import { conversationEnvPolicy } from "../../src/dispatch/env-filter.js";
import {
  type EngineSessionAdapter,
  type EngineSessionRequest,
  type EngineSessionResult,
  createSpawnOptionsProjection,
} from "../../src/dispatch/session-types.js";
import type { EvaluatorOutput, RoundDecision } from "../../src/orchestrator/consensus.js";
import { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { DebateConversationPolicy } from "../../src/orchestrator/conversation/debate-policy.js";
import { ConversationPolicyRegistry } from "../../src/orchestrator/conversation/policy-registry.js";
import { ConversationOrchestrator } from "../../src/orchestrator/conversation/service.js";
import type {
  ArtifactCreateRequest,
  AttemptRef,
  ConversationArtifactRef,
  ConversationContext,
  PolicyAttemptRequest,
} from "../../src/orchestrator/conversation/types.js";
import { DurableArtifactRegistry } from "../../src/orchestrator/trace/artifacts.js";
import { TraceStore } from "../../src/orchestrator/trace/store.js";
import type {
  PolicyEmission,
  StoredTraceEvent,
  TraceCorrelation,
} from "../../src/orchestrator/trace/types.js";
import { validInput } from "../../src/orchestrator/trace/validation.js";

const allTrue: EvaluatorOutput = {
  agreement: { value: true, evidence: "yes" },
  conflict_resolution: { value: true, evidence: "yes" },
  evidence_quality: { value: true, evidence: "yes" },
  convergence: { value: true, evidence: "yes" },
};
const allFalse: EvaluatorOutput = {
  agreement: { value: false, evidence: "no" },
  conflict_resolution: { value: false, evidence: "no" },
  evidence_quality: { value: false, evidence: "no" },
  convergence: { value: false, evidence: "no" },
};

const participant = (answer: string, claim: string, evidence: string[] = []) =>
  JSON.stringify({ answer, content: `analysis:${claim}`, claim, evidence });
const evaluator = (value: EvaluatorOutput) => JSON.stringify(value);

const binding = (role: string, engine: "claude" | "codex" = "claude") =>
  ({
    role: { spec: { name: role }, resolved_hash: `${role}-hash` },
    skills: [],
    engine,
    model: null,
    sessionMode: "fresh",
  }) as unknown as ResolvedAgentBinding;

const roleHash = "a".repeat(64);

function materializedDebateBinding(roleName: string): MaterializedAgentBinding {
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
          body: "Canonical debate role",
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
      rendered_prompt: "Canonical debate role\n\n## Assigned Topic\n\nChoose\n",
      rendered_tools: ["read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

class QueueAdapter implements EngineSessionAdapter {
  readonly starts: EngineSessionRequest[] = [];

  constructor(private readonly outputs: string[]) {}

  start(request: EngineSessionRequest) {
    const output = this.outputs.shift();
    if (output === undefined) throw new Error("missing integration engine output");
    this.starts.push(request);
    for (const state of ["requested", "dispatched", "acknowledged", "completed"] as const) {
      request.onLifecycle?.(state);
    }
    const completed: EngineSessionResult = {
      attemptId: request.attemptId,
      engine: "codex",
      ok: true,
      state: "completed",
      lifecycle: ["requested", "dispatched", "acknowledged", "completed"],
      output,
      evidenceStatus: "persisted",
      nativeSessionStatus: "unavailable",
    };
    return {
      attemptId: request.attemptId,
      completion: Promise.resolve(completed),
      terminate: async () => undefined,
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

interface Harness {
  context: ConversationContext;
  attempts: PolicyAttemptRequest[];
  timeline: string[];
  keys: string[];
  records: StoredTraceEvent[];
  artifacts: ArtifactCreateRequest[];
}

const consensusDecisions = (records: readonly StoredTraceEvent[]): RoundDecision[] =>
  records.flatMap(({ event }) =>
    event.type === "consensus_update" ? [event.payload.decision] : [],
  );

function harness(
  outputs: readonly (string | EngineSessionResult)[],
  options: {
    maxRounds?: number;
    bindings?: readonly ResolvedAgentBinding[];
    participantIds?: readonly string[];
    baselineEnabled?: boolean;
    evaluatorAutoAdded?: boolean;
    readiness?: readonly { engine_available: boolean; model_valid: boolean }[];
  } = {},
): Harness {
  const attempts: PolicyAttemptRequest[] = [];
  const timeline: string[] = [];
  const keys: string[] = [];
  const records: StoredTraceEvent[] = [];
  const artifacts: ArtifactCreateRequest[] = [];
  const queue = [...outputs];
  let sequence = 0;
  const correlation: TraceCorrelation = {
    workflow_id: "workflow",
    conversation_id: "conversation",
    revision_id: "revision",
    run_id: "run",
    turn_id: "turn",
    operation_id: "operation",
    attempt_id: "coordinator",
  };
  const bindings = options.bindings ?? [
    binding("brainstorm-participant"),
    binding("brainstorm-skeptic", "codex"),
    binding("brainstorm-evaluator"),
  ];
  const participantIds = options.participantIds ?? ["p1", "p2", "eval"];
  const append = (
    emission: PolicyEmission,
    patch: Partial<TraceCorrelation> = {},
  ): Promise<StoredTraceEvent> => {
    sequence += 1;
    timeline.push(emission.event.type);
    keys.push(emission.idempotency_key);
    const record: StoredTraceEvent = {
      ...correlation,
      ...patch,
      event_id: `event-${sequence}`,
      seq: sequence,
      ts: `2026-08-22T00:00:${String(sequence).padStart(2, "0")}.000Z`,
      idempotency_key: emission.idempotency_key,
      event: structuredClone(emission.event),
    };
    records.push(record);
    return Promise.resolve(record);
  };
  const context = {
    correlation,
    topic: "Choose a storage design",
    policy: "debate",
    maxRounds: options.maxRounds ?? 1,
    baselineEnabled: options.baselineEnabled ?? true,
    evaluatorAutoAdded: options.evaluatorAutoAdded ?? true,
    bindings,
    participantIds,
    bindingReadiness:
      options.readiness ?? bindings.map(() => ({ engine_available: true, model_valid: true })),
    signal: new AbortController().signal,
    messages: () => Promise.resolve([]),
    emit: (emission: PolicyEmission) => append(emission),
    launchAttempt: (request: PolicyAttemptRequest) => {
      attempts.push(structuredClone(request));
      const supplied = queue.shift();
      if (supplied === undefined) throw new Error(`missing output for ${request.purpose}`);
      const output = typeof supplied === "string" ? supplied : supplied.output;
      const result: EngineSessionResult =
        typeof supplied === "string"
          ? {
              attemptId: `attempt-${attempts.length}`,
              engine: bindings[request.bindingIndex]?.engine ?? "claude",
              ok: true,
              state: "completed",
              lifecycle: ["requested", "dispatched", "completed"],
              output,
              evidenceStatus: "persisted",
              nativeSessionStatus: "unavailable",
            }
          : supplied;
      return Object.freeze({
        ref: `attempt-ref-${attempts.length}` as AttemptRef,
        completion: Promise.resolve(result),
        emit: (emission: PolicyEmission) =>
          append(emission, {
            attempt_id: result.attemptId,
            participant_id: request.participantId,
            role_ref: bindings[request.bindingIndex]?.role.spec.name,
            engine: bindings[request.bindingIndex]?.engine,
          }),
        onChunk: () => () => undefined,
      });
    },
    createArtifact: (request: ArtifactCreateRequest) => {
      artifacts.push(structuredClone(request));
      timeline.push(`artifact:${request.artifact_type}`);
      keys.push(request.idempotency_key);
      const ordinal = artifacts.length;
      return Promise.resolve({
        artifact_id: `artifact-${ordinal}`,
        ref: `internal/artifact-${ordinal}.json` as ConversationArtifactRef,
      });
    },
    updateArtifact: () => Promise.reject(new Error("not used")),
  } as unknown as ConversationContext;
  return { context, attempts, timeline, keys, records, artifacts };
}

test("dry run reports the canonical evaluator auto-add and ready engines", async () => {
  const policy = new DebateConversationPolicy();
  const run = harness([], {
    evaluatorAutoAdded: true,
    readiness: [
      { engine_available: true, model_valid: true },
      { engine_available: false, model_valid: true },
      { engine_available: true, model_valid: true },
    ],
  });
  expect(await policy.dryRun(run.context)).toEqual({
    participants: [
      {
        participant_id: "p1",
        role_ref: "brainstorm-participant",
        engine: "claude",
        model: null,
        engine_available: true,
        model_valid: true,
      },
      {
        participant_id: "p2",
        role_ref: "brainstorm-skeptic",
        engine: "codex",
        model: null,
        engine_available: false,
        model_valid: true,
      },
      {
        participant_id: "eval",
        role_ref: "brainstorm-evaluator",
        engine: "claude",
        model: null,
        engine_available: true,
        model_valid: true,
      },
    ],
    evaluator_auto_added: true,
    engines_available: ["claude"],
    models_valid: true,
  });
});

test("policy uses one evaluator and preserves the frozen event/artifact order", async () => {
  const run = harness([
    "baseline answer",
    participant("public precommit one", "secret claim one", ["e1"]),
    participant("public precommit two", "secret claim two", ["e2"]),
    evaluator(allTrue),
    evaluator(allTrue),
  ]);
  const result = await new DebateConversationPolicy().execute(run.context);
  expect(result.status).toBe("completed");
  expect(result.artifact_refs).toHaveLength(4);
  expect(run.timeline).toEqual([
    "baseline_result",
    "round_boundary",
    "precommit",
    "precommit",
    "evaluator_assessment",
    "agent_response_delta",
    "agent_response_delta",
    "evaluator_assessment",
    "consensus_update",
    "round_boundary",
    "artifact:decision_matrix",
    "artifact:synthesis",
    "artifact:transcript",
    "artifact:synthesis",
    "synthesis_completed",
  ]);
  expect(run.artifacts.map((item) => item.artifact_type)).toEqual([
    "decision_matrix",
    "synthesis",
    "transcript",
    "synthesis",
  ]);
  const evaluatorAttempts = run.attempts.filter((attempt) => attempt.purpose === "evaluator");
  expect(evaluatorAttempts).toHaveLength(2);
  expect(evaluatorAttempts[0]?.promptInput).toContain("public precommit one");
  expect(evaluatorAttempts[0]?.promptInput).not.toContain("secret claim one");
  expect(evaluatorAttempts[1]?.promptInput).toContain("secret claim one");
  expect(evaluatorAttempts[1]?.promptInput).toContain('"option":"option-1"');
  expect(evaluatorAttempts[1]?.promptInput).not.toContain('"participant_id"');
  expect(run.attempts[0]).toMatchObject({
    purpose: "baseline",
    participantId: "p1",
    bindingIndex: 0,
    promptInput: "Choose a storage design",
  });
  expect(run.keys.every((key) => key.startsWith("debate:"))).toBe(true);
  for (const {
    event_id: _id,
    seq: _seq,
    ts: _ts,
    idempotency_key,
    event,
    ...stored
  } of run.records) {
    expect(validInput(stored, { idempotency_key, event }, null)).toBe(true);
  }
});

test("disabled baseline persists its skip without launching a baseline attempt", async () => {
  const run = harness(
    [participant("p1", "same"), participant("p2", "same"), evaluator(allTrue), evaluator(allTrue)],
    { baselineEnabled: false },
  );
  expect((await new DebateConversationPolicy().execute(run.context)).status).toBe("completed");
  expect(run.attempts.some(({ purpose }) => purpose === "baseline")).toBe(false);
  expect(run.records[0]?.event).toEqual({
    type: "baseline_result",
    payload: { status: "skipped", answer: null, confidence: null, skip_reason: "disabled" },
  });
});

test("real runtime accepts the complete debate journal and folds a terminal conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-debate-policy-"));
  try {
    const opaque = new DurableArtifactRegistry({ dir: join(root, "opaque") });
    let eventOrdinal = 0;
    const traceStore = new TraceStore({
      dir: join(root, "trace"),
      artifactRegistry: opaque,
      eventId: () => `00000000-0000-4000-8000-${String(++eventOrdinal).padStart(12, "0")}`,
      now: () => "2026-08-22T00:00:00.000Z",
    });
    const materialized = [
      materializedDebateBinding("brainstorm-participant"),
      materializedDebateBinding("brainstorm-skeptic"),
      materializedDebateBinding("brainstorm-evaluator"),
    ];
    const adapter = new QueueAdapter([
      "baseline",
      participant("p1 precommit", "shared winner", ["e1"]),
      participant("p2 precommit", "shared winner", ["e2"]),
      evaluator(allTrue),
      evaluator(allTrue),
    ]);
    const counters = new Map<string, number>();
    const runtime = new ConversationOrchestrator({
      traceStore,
      artifactRegistry: opaque,
      artifactStore: new ConversationArtifactStore({ dir: join(root, "manifests") }),
      sessionAdapter: adapter,
      policies: new ConversationPolicyRegistry([new DebateConversationPolicy()]),
      id: (kind) => {
        const next = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, next);
        return `${kind}-${next}`;
      },
      now: () => "2026-08-22T00:00:00.000Z",
      rehydrateBinding: async (persisted) => {
        const index = [
          "brainstorm-participant",
          "brainstorm-skeptic",
          "brainstorm-evaluator",
        ].indexOf(persisted.input.roleRef);
        return materialized[index] as MaterializedAgentBinding;
      },
    });
    const inputs: AgentBinding[] = [
      { roleRef: "brainstorm-participant", engine: "codex", sessionMode: "fresh" },
      { roleRef: "brainstorm-skeptic", engine: "codex", sessionMode: "fresh" },
      { roleRef: "brainstorm-evaluator", engine: "codex", sessionMode: "fresh" },
    ];
    const created = await runtime.create({
      topic: "Choose",
      policy: "debate",
      maxRounds: 1,
      baselineEnabled: true,
      evaluatorAutoAdded: true,
      repoRoot: process.cwd(),
      phase: 1,
      bindings: materialized.map((item, index) => ({
        participantId: ["p1", "p2", "eval"][index] as string,
        input: inputs[index] as AgentBinding,
        materialized: item,
      })),
    });
    expect(created.result).toMatchObject({ status: "completed" });
    expect(created.result.artifact_refs).toHaveLength(4);
    expect(adapter.starts).toHaveLength(5);
    expect(adapter.starts[0]?.spawn.rendered_prompt).not.toContain("## Policy Attempt");
    const snapshot = await runtime.snapshot(created.conversation_id);
    expect(snapshot).toMatchObject({
      lifecycle: "COMPLETED",
      consensus_score: 1,
      rounds: [{ complete: true, decision: { outcome: "consensus", score: 1 } }],
    });
    const events = await runtime.events(created.conversation_id, 0);
    expect(
      events
        ?.filter(({ event }) => event.type === "artifact_created")
        .map(({ event }) =>
          event.type === "artifact_created" ? String(event.payload.artifact_type) : null,
        ),
    ).toEqual(["decision_matrix", "synthesis", "transcript", "synthesis"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed evaluator output fails closed without throwing or publishing artifacts", async () => {
  const run = harness([
    "baseline",
    participant("p1", "claim one"),
    participant("p2", "claim two"),
    '{"agreement":"yes"}',
  ]);
  const result = await new DebateConversationPolicy().execute(run.context);
  expect(result).toMatchObject({ status: "failed", artifact_refs: [] });
  expect(run.records.at(-1)?.event).toEqual({
    type: "error",
    payload: {
      agent_id: null,
      code: "invalid_assessment",
      message: "evaluator returned an invalid blind assessment",
    },
  });
  expect(run.artifacts).toHaveLength(0);
});

test("all-true gates on the final round resolve as consensus before exhaustion", async () => {
  const run = harness([
    "baseline",
    participant("p1", "same"),
    participant("p2", "same"),
    evaluator(allTrue),
    evaluator(allTrue),
  ]);
  await new DebateConversationPolicy().execute(run.context);
  expect(consensusDecisions(run.records)[0]).toEqual({ outcome: "consensus", score: 1 });
});

test("non-consensus runs exactly maxRounds and exhausts deterministically", async () => {
  const outputs = [
    "baseline",
    participant("r1 p1", "alpha"),
    participant("r1 p2", "beta"),
    evaluator(allFalse),
    evaluator(allFalse),
    participant("r2 p1", "alpha"),
    participant("r2 p2", "beta"),
    evaluator(allFalse),
    evaluator(allFalse),
  ];
  const first = harness(outputs, { maxRounds: 2 });
  const second = harness(outputs, { maxRounds: 2 });
  const policy = new DebateConversationPolicy();
  expect((await policy.execute(first.context)).status).toBe("completed");
  expect((await policy.execute(second.context)).status).toBe("completed");
  const decisions = consensusDecisions(first.records);
  expect(decisions).toEqual([
    { outcome: "continue", score: 0 },
    { outcome: "exhausted", score: 0 },
  ]);
  expect(first.keys).toEqual(second.keys);
  expect(first.attempts.filter(({ purpose }) => purpose === "participant")).toHaveLength(4);
});

test("baseline disagreement is a comparison signal and cannot override consensus", async () => {
  const run = harness([
    "opposite baseline",
    participant("precommit one", "debate winner"),
    participant("precommit two", "debate winner"),
    evaluator(allTrue),
    evaluator(allTrue),
  ]);
  const result = await new DebateConversationPolicy().execute(run.context);
  expect(result.status).toBe("completed");
  expect(consensusDecisions(run.records)[0]).toEqual({ outcome: "consensus", score: 1 });
  const comparison = JSON.parse(String(run.artifacts[1]?.content));
  expect(comparison).toMatchObject({
    status: "success",
    baseline_answer: "opposite baseline",
    debate_answer: "debate winner",
  });
  expect(comparison.divergence).toBeGreaterThan(0);
});

test("invalid evaluator cardinality fails before any engine launch", async () => {
  const run = harness([], {
    bindings: [binding("brainstorm-participant"), binding("brainstorm-skeptic")],
    participantIds: ["p1", "p2"],
  });
  const result = await new DebateConversationPolicy().execute(run.context);
  expect(result.status).toBe("failed");
  expect(run.attempts).toHaveLength(0);
  expect(run.records.at(-1)?.event).toMatchObject({
    type: "error",
    payload: { code: "invalid_evaluator_count" },
  });
});
