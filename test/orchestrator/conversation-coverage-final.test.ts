import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedAgentBinding } from "../../src/agents/binding.js";
import type { EngineSessionResult } from "../../src/dispatch/session-types.js";
import type { EvaluatorOutput } from "../../src/orchestrator/consensus.js";
import {
  type ConversationDurableRecord,
  assertConversationDurableRecord,
  assertConversationManifest,
} from "../../src/orchestrator/conversation/artifact-validation.js";
import { AttemptRuntime } from "../../src/orchestrator/conversation/attempt-runtime.js";
import {
  persistBaselineResult,
  projectBaselineComparison,
} from "../../src/orchestrator/conversation/baseline.js";
import {
  createConversationBootstrap,
  createConversationService,
  defaultConversationReadiness,
} from "../../src/orchestrator/conversation/bootstrap.js";
import {
  assertChildManifestAuthority,
  createChildManifest,
  projectDryRunResult,
  projectOrchestrationResult,
  projectRuntimePreviewRequest,
} from "../../src/orchestrator/conversation/boundary-projection.js";
import { ControlRuntime } from "../../src/orchestrator/conversation/control-runtime.js";
import { DebateConversationPolicy } from "../../src/orchestrator/conversation/debate-policy.js";
import { projectDecisionMatrix } from "../../src/orchestrator/conversation/debate-projection.js";
import {
  assertAttemptEmission,
  assertCoordinatorEmission,
  previewAgentPolicyContext,
} from "../../src/orchestrator/conversation/emission-authority.js";
import { validateTerminalScore } from "../../src/orchestrator/conversation/fold-validation.js";
import { foldConversation } from "../../src/orchestrator/conversation/fold.js";
import { ConversationEmissionGate } from "../../src/orchestrator/conversation/lifecycle-gate.js";
import { directMessagePrompt } from "../../src/orchestrator/conversation/message-delivery.js";
import { reserveOperationCancellation } from "../../src/orchestrator/conversation/operation-cancellation-reservation.js";
import type { OperationEntry } from "../../src/orchestrator/conversation/operation-registry-types.js";
import { OperationRegistry } from "../../src/orchestrator/conversation/operation-registry.js";
import { registeredOperation } from "../../src/orchestrator/conversation/registered-operation.js";
import { configurationEnvelope } from "../../src/orchestrator/conversation/restart-authority.js";
import { ReviewConversationPolicy } from "../../src/orchestrator/conversation/review-policy.js";
import { policyDryRun } from "../../src/orchestrator/conversation/services.js";
import type {
  AttemptRef,
  ConversationArtifactRef,
  ConversationContext,
  ConversationManifest,
  PolicyAttemptRequest,
} from "../../src/orchestrator/conversation/types.js";
import { VerifyConversationPolicy } from "../../src/orchestrator/conversation/verify-policy.js";
import { TraceIdempotencyConflictError } from "../../src/orchestrator/trace/store.js";
import type {
  InternalTraceStoreRecord,
  PolicyEmission,
  PublicStoredTraceEvent,
  StoredTraceEvent,
  TraceCorrelation,
  TraceEvent,
} from "../../src/orchestrator/trace/types.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REF_A = `vf-artifact-${HASH_A}`;
const REF_B = `vf-artifact-${HASH_B}`;

const correlation: TraceCorrelation = {
  workflow_id: "workflow-a",
  conversation_id: "conversation-a",
  revision_id: "revision-a",
  run_id: "run-a",
  turn_id: "turn-a",
  operation_id: "operation-a",
  attempt_id: "attempt-a",
};

function manifest(overrides: Partial<ConversationManifest> = {}): ConversationManifest {
  return {
    version: "1.0",
    conversation_id: "conversation-a",
    workflow_id: "workflow-a",
    revision_id: "revision-a",
    run_id: "run-a",
    parent_conversation_id: null,
    parent_revision_id: null,
    topic: "Choose safely",
    policy: "debate",
    max_rounds: 2,
    baseline_enabled: true,
    evaluator_auto_added: true,
    repo_root: process.cwd(),
    phase: 3,
    task_text: "Choose safely",
    bindings: [
      {
        participant_id: "p1",
        input: { roleRef: "brainstorm-participant", engine: "codex", sessionMode: "fresh" },
      },
    ],
    created_at: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

function durable(overrides: Partial<ConversationDurableRecord> = {}): ConversationDurableRecord {
  return {
    manifest: manifest(),
    binding_authorities: [
      {
        participant_id: "p1",
        engine: "codex",
        model: null,
        session_mode: "fresh",
        role_source: "builtin",
        role_hash: HASH_A,
        skill_hashes: [],
      },
    ],
    resume_bindings: [],
    child_revisions: {},
    artifacts: [],
    artifact_reservations: {},
    ...overrides,
  };
}

function stored(
  seq: number,
  event: TraceEvent,
  patch: Record<string, unknown> = {},
): StoredTraceEvent {
  return {
    ...correlation,
    event_id: `event-${seq}`,
    seq,
    ts: `2026-08-23T00:00:${String(seq).padStart(2, "0")}.000Z`,
    idempotency_key: `key-${seq}`,
    event,
    ...patch,
  } as StoredTraceEvent;
}

function internal(event: StoredTraceEvent): InternalTraceStoreRecord {
  return { stored_event: event, native_session_id: null } as InternalTraceStoreRecord;
}

const allTrue: EvaluatorOutput = {
  agreement: { value: true, evidence: "yes" },
  conflict_resolution: { value: true, evidence: "yes" },
  evidence_quality: { value: true, evidence: "yes" },
  convergence: { value: true, evidence: "yes" },
};

function publicEvent(
  seq: number,
  event: TraceEvent,
  patch: Record<string, unknown> = {},
): PublicStoredTraceEvent {
  return {
    ...correlation,
    event_id: `public-${seq}`,
    seq,
    ts: `2026-08-23T01:00:${String(seq).padStart(2, "0")}.000Z`,
    public_session_ref: null,
    event,
    ...patch,
  } as PublicStoredTraceEvent;
}

function configured(seq = 1, policy = "debate"): PublicStoredTraceEvent {
  return publicEvent(seq, {
    type: "conversation_configured",
    payload: {
      topic: "Choose safely",
      policy,
      max_rounds: 2,
      participants: [
        { participant_id: "p1", role_ref: "believer", engine: "claude", model: "sonnet" },
        { participant_id: "p2", role_ref: "skeptic", engine: "codex", model: "gpt-5.4" },
        {
          participant_id: "eval",
          role_ref: "brainstorm-evaluator",
          engine: "claude",
          model: "sonnet",
        },
      ],
    },
  });
}

function state(seq: number, lifecycle: "ACTIVE" | "STOPPED"): PublicStoredTraceEvent {
  return publicEvent(seq, {
    type: "state_change",
    payload: {
      lifecycle,
      health: "healthy",
      terminal: lifecycle === "STOPPED",
      reason: null,
    },
  });
}

function roundBoundary(
  seq: number,
  phase: "start" | "end",
  roundId = "round-1",
): PublicStoredTraceEvent {
  return publicEvent(seq, {
    type: "round_boundary",
    payload: { round_id: roundId, phase },
  });
}

function participantPatch(id: "p1" | "p2") {
  return id === "p1"
    ? { participant_id: id, role_ref: "believer", engine: "claude" }
    : { participant_id: id, role_ref: "skeptic", engine: "codex" };
}

function precommit(seq: number, id: "p1" | "p2"): PublicStoredTraceEvent {
  return publicEvent(
    seq,
    {
      type: "precommit",
      payload: { round_id: "round-1", participant_id: id, answer: id, evidence: [] },
    },
    participantPatch(id),
  );
}

function response(seq: number, id: "p1" | "p2"): PublicStoredTraceEvent {
  return publicEvent(
    seq,
    {
      type: "agent_response_delta",
      payload: {
        round_id: "round-1",
        participant_id: id,
        content_delta: id,
        final_claim: id,
        final_evidence: [],
        completes_response: true,
      },
    },
    participantPatch(id),
  );
}

function assessment(seq: number, stage: "blind" | "full"): PublicStoredTraceEvent {
  return publicEvent(
    seq,
    {
      type: "evaluator_assessment",
      payload: { round_id: "round-1", stage, assessment: structuredClone(allTrue) },
    },
    { participant_id: "eval", role_ref: "brainstorm-evaluator", engine: "claude" },
  );
}

function resolvedBinding(
  roleName = "brainstorm-participant",
  engine: "claude" | "codex" = "codex",
): ResolvedAgentBinding {
  return {
    role: { spec: { name: roleName }, resolved_hash: HASH_A },
    skills: [],
    engine,
    model: null,
    sessionMode: "fresh",
  } as unknown as ResolvedAgentBinding;
}

function policyContext(overrides: Record<string, unknown> = {}): ConversationContext {
  return {
    correlation,
    topic: "Choose safely",
    policy: "debate",
    maxRounds: 1,
    baselineEnabled: true,
    evaluatorAutoAdded: true,
    bindings: [resolvedBinding(), resolvedBinding("brainstorm-skeptic", "claude")],
    participantIds: ["p1", "p2"],
    bindingReadiness: [
      { engine_available: true, model_valid: true },
      { engine_available: true, model_valid: true },
    ],
    signal: new AbortController().signal,
    messages: async () => [],
    emit: async (emission: PolicyEmission) => stored(1, emission.event),
    launchAttempt: () => {
      throw new Error("not used");
    },
    createArtifact: async () => ({
      artifact_id: "artifact-a",
      ref: REF_A as ConversationArtifactRef,
    }),
    updateArtifact: async () => ({
      artifact_id: "artifact-a",
      ref: REF_B as ConversationArtifactRef,
    }),
    ...overrides,
  } as unknown as ConversationContext;
}

describe("conversation final validation and projection coverage", () => {
  test("rejects invalid nested manifest and artifact entries plus orphan ancestry", () => {
    const invalidBinding = durable();
    invalidBinding.manifest.bindings = [
      { participant_id: "p1", input: { roleRef: "", engine: "codex", sessionMode: "fresh" } },
    ];
    expect(() => assertConversationManifest(invalidBinding.manifest)).toThrow("invalid manifest");

    const invalidArtifact = durable({ artifacts: [{ invalid: true } as never] });
    expect(() => assertConversationDurableRecord(invalidArtifact)).toThrow("invalid manifest");

    const orphan = durable({
      artifacts: [
        {
          artifact_id: "plan-a",
          artifact_type: "plan",
          ref: REF_A,
          previous_ref: REF_B,
          idempotency_key: "artifact:update",
          content_hash: HASH_A,
        },
      ],
    });
    expect(() => assertConversationDurableRecord(orphan)).toThrow("invalid manifest");
  });

  test("projects skipped baseline results and persists every unavailable/failure outcome", async () => {
    const decisionMatrix = {
      method: "weighted_sum" as const,
      generated_at: "2026-08-23T00:00:00.000Z",
      rows: [
        {
          option: "winner",
          scores: {
            responses: 1,
            evidence: 1,
            agreement: 1,
            conflict_resolution: 1,
            evidence_quality: 1,
            convergence: 1,
          },
          aggregate: 1,
          rank: 1,
        },
      ],
    };
    expect(
      projectBaselineComparison({
        enabled: true,
        nonEvaluatorParticipantCount: 2,
        selectedEngineAvailable: true,
        decisionMatrix,
        records: [
          stored(1, {
            type: "baseline_result",
            payload: {
              status: "skipped",
              answer: null,
              confidence: null,
              skip_reason: "maintenance",
            },
          }),
        ],
      }),
    ).toMatchObject({ status: "skipped", skip_reason: "maintenance" });

    const emitted: TraceEvent[] = [];
    const run = async (context: ConversationContext) => {
      const value = await persistBaselineResult(context, 0);
      return value.event.type === "baseline_result" ? value.event.payload : null;
    };
    const base = {
      ...policyContext(),
      participantIds: ["p1", "p2"],
      emit: async (emission: PolicyEmission) => {
        emitted.push(emission.event);
        return stored(emitted.length, emission.event);
      },
    } as ConversationContext;

    expect(
      await run({ ...base, bindings: [resolvedBinding()] } as ConversationContext),
    ).toMatchObject({ status: "skipped", skip_reason: "single_participant" });
    expect(
      await run({
        ...base,
        bindingReadiness: [
          { engine_available: false, model_valid: true },
          { engine_available: true, model_valid: true },
        ],
      } as ConversationContext),
    ).toMatchObject({ status: "skipped", skip_reason: "engine_unavailable" });
    expect(
      await run({
        ...base,
        launchAttempt: () => ({
          completion: Promise.resolve({ ok: false, state: "failed", reason: null }),
        }),
      } as unknown as ConversationContext),
    ).toMatchObject({ status: "failed", skip_reason: "baseline_failed" });
    expect(
      await run({
        ...base,
        launchAttempt: () => {
          throw new Error("start failed");
        },
      } as unknown as ConversationContext),
    ).toMatchObject({ status: "failed", skip_reason: "baseline_start_failed" });
  });

  test("hands delayed attempt chunks and unsubscribe authority across a reopened gate", async () => {
    let open!: () => void;
    const pending = new Promise<void>((resolve) => {
      open = resolve;
    });
    let innerListener: ((chunk: { stream: "stdout"; content: string }) => void) | undefined;
    let innerUnsubscribes = 0;
    const runtime = new AttemptRuntime({
      id: () => "attempt-a",
      sessionAdapter: {},
      artifactStore: {},
      correlation: () => correlation,
      append: async () =>
        stored(1, { type: "error", payload: { agent_id: null, code: "x", message: "x" } }),
      appendLifecycle: async () => undefined,
      appendRuntime: async () =>
        stored(1, { type: "error", payload: { agent_id: null, code: "x", message: "x" } }),
      isOpen: () => false,
      isRetained: () => true,
      awaitOpen: () => pending,
    } as never);
    Object.defineProperty(runtime, "launchNow", {
      value: () => ({
        ref: "inner-ref",
        completion: Promise.resolve({}),
        emit: async () =>
          stored(2, { type: "error", payload: { agent_id: null, code: "x", message: "x" } }),
        onChunk: (next: typeof innerListener) => {
          innerListener = next;
          return () => {
            innerUnsubscribes += 1;
          };
        },
      }),
    });
    const attempt = runtime.launch(
      { manifest: manifest(), operationId: "operation-a" } as never,
      { isLive: () => true } as never,
      { participantId: "p1", bindingIndex: 0, purpose: "participant", promptInput: "x" },
      new Map(),
    );
    const chunks: string[] = [];
    const unsubscribe = attempt.onChunk((chunk) => chunks.push(chunk.content));
    expect(() => attempt.onChunk(() => undefined)).toThrow("already consumed");
    open();
    await attempt.completion;
    innerListener?.({ stream: "stdout", content: "after-open" });
    expect(chunks).toEqual(["after-open"]);
    unsubscribe();
    expect(innerUnsubscribes).toBe(1);
  });

  test("fails closed on sparse/invalid dry-run DTOs and unowned runtime projections", () => {
    const sparse = new Array(1);
    expect(() =>
      projectDryRunResult({
        participants: sparse,
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      }),
    ).toThrow("invalid dry-run policy result");
    const participant = {
      participant_id: " ",
      role_ref: "role",
      engine: "codex",
      model: null,
      engine_available: true,
      model_valid: true,
    };
    expect(() =>
      projectDryRunResult({
        participants: [participant],
        evaluator_auto_added: false,
        engines_available: ["codex"],
        models_valid: true,
      }),
    ).toThrow("invalid dry-run policy result");
    expect(() =>
      projectDryRunResult({
        participants: [{ ...participant, participant_id: "p1", engine_available: "yes" }],
        evaluator_auto_added: false,
        engines_available: ["codex"],
        models_valid: true,
      }),
    ).toThrow("invalid dry-run policy result");
    expect(() =>
      projectDryRunResult({
        participants: [],
        evaluator_auto_added: "false",
        engines_available: [],
        models_valid: true,
      }),
    ).toThrow("invalid dry-run policy result");
    expect(() =>
      projectDryRunResult({
        participants: [{ ...participant, participant_id: "p1" }],
        evaluator_auto_added: false,
        engines_available: [],
        models_valid: true,
      }),
    ).toThrow("invalid dry-run policy result");
    expect(() =>
      projectRuntimePreviewRequest(
        {
          topic: "topic",
          policy: "direct",
          maxRounds: 1,
          evaluatorAutoAdded: false,
          repoRoot: process.cwd(),
          phase: 3,
          bindings: [],
        },
        {},
      ),
    ).toThrow("invalid preview binding authority");
    expect(
      projectOrchestrationResult(
        { operation_id: "operation-a", status: "failed", artifact_refs: [REF_A] },
        "operation-a",
        "conversation-a",
        {} as never,
      ),
    ).toEqual({ operation_id: "operation-a", status: "failed", artifact_refs: [] });
  });

  test("walks the full child authority comparison before rejecting changed bindings", () => {
    const parent = manifest();
    const childId = "conversation-child";
    const child = createChildManifest(parent, childId, "run-child", "2026-08-23T00:01:00.000Z");
    child.bindings = [
      {
        participant_id: "changed",
        input: { roleRef: "brainstorm-participant", engine: "codex", sessionMode: "fresh" },
      },
    ];
    expect(() => assertChildManifestAuthority(child, parent, childId)).toThrow(
      "persisted child revision authority changed",
    );
    const valid = createChildManifest(parent, childId, "run-child", "2026-08-23T00:01:00.000Z");
    expect(assertChildManifestAuthority(valid, parent, childId)).toBe(valid);
  });
});

describe("conversation final runtime authority coverage", () => {
  test("re-reads an idempotent approval conflict through the durable journal", async () => {
    const decision = {
      approval_id: "approval-a",
      operation_id: "operation-a",
      actor: "human",
      outcome: "approve" as const,
      reason: null,
    };
    const requested = stored(1, {
      type: "approval_requested",
      payload: {
        token: { approval_id: "approval-a", operation_id: "operation-a", actor: "human" },
        description: "approve",
      },
    });
    const resolved = stored(2, {
      type: "approval_resolved",
      payload: { decision },
    });
    let reads = 0;
    const runtime = new ControlRuntime({
      operations: { get: () => ({}) },
      manifest: () => manifest(),
      authority: () => null,
      read: async () =>
        reads++ === 0 ? [internal(requested)] : [internal(requested), internal(resolved)],
      correlation: () => correlation,
      appendActive: async () => {
        throw new TraceIdempotencyConflictError("raced");
      },
      appendCancellation: async () => stored(1, requested.event),
      appendTransition: async () => stored(1, requested.event),
      appendTerminal: async () => [],
    } as never);
    await expect(runtime.resolveApproval("conversation-a", decision, true)).resolves.toEqual({
      response: { status: 202, body: { ...decision, resolved: true } },
      fresh: false,
    });
  });

  test("keeps coordinator and attempt emission identities within their authority lanes", async () => {
    expect(() =>
      assertCoordinatorEmission(
        {
          idempotency_key: "policy:error",
          event: { type: "error", payload: { agent_id: "p1", code: "x", message: "x" } },
        },
        "operation-a",
      ),
    ).toThrow("cannot forge participant identity");
    const evaluatorAlias = {
      toString: () => "evaluator",
    } as unknown as Parameters<typeof assertAttemptEmission>[2];
    expect(() =>
      assertAttemptEmission(
        {
          idempotency_key: "policy:assessment",
          event: {
            type: "evaluator_assessment",
            payload: { round_id: "round-1", stage: "full", assessment: allTrue },
          },
        },
        "p1",
        evaluatorAlias,
      ),
    ).toThrow("assessment lacks evaluator authority");
    expect(() =>
      assertAttemptEmission(
        {
          idempotency_key: "policy:error",
          event: { type: "error", payload: { agent_id: "p2", code: "x", message: "x" } },
        },
        "p1",
        "participant",
      ),
    ).toThrow("attempt error participant mismatch");

    const preview = previewAgentPolicyContext(
      manifest(),
      [
        {
          resolved: resolvedBinding(),
          engineAvailable: true,
          modelValid: true,
        },
      ] as never,
      correlation,
    );
    expect(() =>
      preview.launchAttempt({
        participantId: "p1",
        bindingIndex: 0,
        purpose: "participant",
        promptInput: "x",
      }),
    ).toThrow("dry-run context is read-only");
    await expect(preview.emit({} as never)).rejects.toThrow("dry-run context is read-only");
  });

  test("persists a participant failure through the failed attempt authority", async () => {
    const results: EngineSessionResult[] = [
      {
        attemptId: "baseline",
        engine: "codex",
        ok: true,
        state: "completed",
        lifecycle: ["requested", "dispatched", "completed"],
        output: "baseline",
        evidenceStatus: "persisted",
        nativeSessionStatus: "unavailable",
      },
      {
        attemptId: "failed",
        engine: "codex",
        ok: false,
        state: "ambiguous",
        lifecycle: ["requested", "ambiguous"],
        output: "",
        reason: "participant failed",
        evidenceStatus: "persisted",
        nativeSessionStatus: "unavailable",
      },
      {
        attemptId: "successful",
        engine: "claude",
        ok: true,
        state: "completed",
        lifecycle: ["requested", "completed"],
        output: JSON.stringify({ answer: "p2", content: "p2", claim: "p2", evidence: [] }),
        evidenceStatus: "persisted",
        nativeSessionStatus: "unavailable",
      },
    ];
    const coordinatorEvents: TraceEvent[] = [];
    const attemptEvents: Array<{
      attemptId: string;
      participantId: string;
      event: TraceEvent;
    }> = [];
    const context = policyContext({
      bindings: [
        resolvedBinding("brainstorm-participant", "codex"),
        resolvedBinding("brainstorm-skeptic", "claude"),
        resolvedBinding("brainstorm-evaluator", "codex"),
      ],
      participantIds: ["p1", "p2", "eval"],
      bindingReadiness: Array.from({ length: 3 }, () => ({
        engine_available: true,
        model_valid: true,
      })),
      emit: async (emission: PolicyEmission) => {
        coordinatorEvents.push(emission.event);
        return stored(coordinatorEvents.length, emission.event);
      },
      launchAttempt: (request: PolicyAttemptRequest) => {
        const result = results.shift();
        if (!result) throw new Error("attempt queue exhausted");
        return {
          ref: `ref-${result.attemptId}` as AttemptRef,
          completion: Promise.resolve(result),
          emit: async (emission: PolicyEmission) => {
            attemptEvents.push({
              attemptId: result.attemptId,
              participantId: request.participantId,
              event: emission.event,
            });
            return stored(attemptEvents.length, emission.event, {
              participant_id: request.participantId,
            });
          },
          onChunk: () => () => undefined,
        };
      },
    });
    const result = await new DebateConversationPolicy().execute(context);
    expect(result.status).toBe("failed");
    const participantError: TraceEvent = {
      type: "error",
      payload: {
        agent_id: "p1",
        code: "participant_attempt_failed",
        message: "participant failed",
      },
    };
    expect(coordinatorEvents).not.toContainEqual(participantError);
    expect(attemptEvents).toEqual([
      {
        attemptId: "failed",
        participantId: "p1",
        event: participantError,
      },
    ]);
  });

  test("invalidates duplicate completed responses and chooses the canonical code-point spelling", () => {
    const assessmentEvent = (seq: number) =>
      stored(seq, {
        type: "evaluator_assessment",
        payload: { round_id: "round-1", stage: "full", assessment: allTrue },
      });
    const decision = stored(5, {
      type: "consensus_update",
      payload: { round_id: "round-1", decision: { outcome: "consensus", score: 1 } },
    });
    const boundary = (seq: number, phase: "start" | "end") =>
      stored(seq, { type: "round_boundary", payload: { round_id: "round-1", phase } });
    const delta = (seq: number, participantId: string, claim: string) =>
      stored(seq, {
        type: "agent_response_delta",
        payload: {
          round_id: "round-1",
          participant_id: participantId,
          content_delta: claim,
          final_claim: claim,
          final_evidence: [],
          completes_response: true,
        },
      });
    expect(
      projectDecisionMatrix([
        boundary(1, "start"),
        delta(2, "p1", "alpha"),
        delta(3, "p1", "alpha"),
        assessmentEvent(4),
        decision,
        boundary(6, "end"),
      ]),
    ).toBeNull();
    expect(
      projectDecisionMatrix([
        boundary(1, "start"),
        delta(2, "p1", "alpha"),
        delta(3, "p2", "Alpha"),
        assessmentEvent(4),
        decision,
        boundary(6, "end"),
      ])?.rows[0]?.option,
    ).toBe("Alpha");
  });

  test("composes multiple direct messages in caller order", () => {
    const prompt = directMessagePrompt([
      { content: "first", target_participants: "all" },
      { content: "second", target_participants: ["p1"] },
    ]);
    expect(prompt).toContain("### Message 1\n\nfirst");
    expect(prompt).toContain("### Message 2\n\nsecond");
    expect(prompt.indexOf("### Message 1")).toBeLessThan(prompt.indexOf("### Message 2"));
  });
});

describe("conversation final lifecycle and cancellation coverage", () => {
  test("rejects every remaining invalid fold ordering at the public journal boundary", () => {
    const error = publicEvent(3, {
      type: "error",
      payload: { agent_id: null, code: "late", message: "late" },
    });
    expect(() => foldConversation([configured(), state(2, "STOPPED"), error])).toThrow(
      "terminal lifecycle is immutable until its terminal record",
    );
    expect(() => foldConversation([configured(), configured(2)])).toThrow(
      "duplicate conversation configuration",
    );
    expect(() =>
      foldConversation([
        configured(),
        publicEvent(
          2,
          {
            type: "native_history_reconciled",
            payload: {
              public_session_ref: "session-b",
              status: "partial",
              imported_turn_count: 0,
              imported_tool_count: 0,
              provenance_refs: [],
              evidence_refs: [],
              completeness_reason: "partial history",
            },
          },
          {
            participant_id: "p1",
            role_ref: "believer",
            engine: "claude",
            public_session_ref: "session-a",
          },
        ),
      ]),
    ).toThrow("public session projection mismatch");
    expect(() =>
      foldConversation([configured(1, "direct"), state(2, "ACTIVE"), roundBoundary(3, "start")]),
    ).toThrow("invalid round boundary");
    expect(() =>
      foldConversation([
        configured(),
        state(2, "ACTIVE"),
        roundBoundary(3, "start"),
        roundBoundary(4, "start"),
      ]),
    ).toThrow("round is already active or duplicated");
    expect(() =>
      foldConversation([configured(), state(2, "ACTIVE"), roundBoundary(3, "end")]),
    ).toThrow("round end lacks active round");
    expect(() =>
      foldConversation([
        configured(),
        state(2, "ACTIVE"),
        roundBoundary(3, "start"),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        response(7, "p1"),
        response(8, "p2"),
        roundBoundary(9, "end"),
      ]),
    ).toThrow("ended round lacks blind/full assessment");
    expect(() =>
      foldConversation([
        configured(),
        state(2, "ACTIVE"),
        roundBoundary(3, "start"),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        response(7, "p1"),
        precommit(8, "p1"),
      ]),
    ).toThrow("invalid or late participant precommit");

    const malformedAssessment = assessment(4, "blind") as unknown as {
      event: { payload: Record<string, unknown> };
    };
    malformedAssessment.event.payload = {};
    expect(() =>
      foldConversation([
        configured(),
        state(2, "ACTIVE"),
        roundBoundary(3, "start"),
        malformedAssessment as never,
      ]),
    ).toThrow("malformed evaluator assessment");
    expect(() =>
      foldConversation([configured(), state(2, "ACTIVE"), assessment(3, "blind")]),
    ).toThrow("assessment lacks active round");
    expect(() =>
      foldConversation([
        configured(),
        state(2, "ACTIVE"),
        roundBoundary(3, "start"),
        precommit(4, "p1"),
        assessment(5, "blind"),
      ]),
    ).toThrow("blind assessment requires every precommit before responses");
    expect(() =>
      foldConversation([
        configured(),
        state(2, "ACTIVE"),
        roundBoundary(3, "start"),
        precommit(4, "p1"),
        precommit(5, "p2"),
        assessment(6, "blind"),
        assessment(7, "full"),
      ]),
    ).toThrow("full assessment requires every completed participant response");
    expect(() =>
      foldConversation([
        configured(),
        state(2, "ACTIVE"),
        publicEvent(3, {
          type: "consensus_update",
          payload: { round_id: "round-1", decision: { outcome: "consensus", score: 1 } },
        }),
      ]),
    ).toThrow("consensus lacks active round");
    expect(() => validateTerminalScore("COMPLETED", "debate", null, null, null)).toThrow(
      "terminal score requires a completed debate decision",
    );
  });

  test("rejects closed waits, missing controls and throwing transition seams", async () => {
    const gate = new ConversationEmissionGate();
    gate.open("conversation-a", "operation-a");
    gate.adoptCancellation("conversation-a", "operation-a");
    await expect(gate.awaitOpen("conversation-a", "operation-a")).rejects.toThrow(
      "conversation emission authority is closed",
    );
    await expect(gate.cancel("missing", "operation-a", async () => undefined)).rejects.toThrow(
      "conversation cancellation authority is closed",
    );
    await expect(
      gate.transition("missing", "operation-a", "PAUSED", async () => undefined),
    ).rejects.toThrow("conversation transition authority missing");

    class ThrowCancelGate extends ConversationEmissionGate {
      override prepareCancellation(): Promise<void> {
        throw new Error("prepare cancel threw");
      }
    }
    const cancel = new ThrowCancelGate();
    cancel.open("conversation-a", "operation-a");
    await expect(
      cancel.cancel("conversation-a", "operation-a", async () => undefined),
    ).rejects.toThrow("prepare cancel threw");

    class ThrowTransitionGate extends ConversationEmissionGate {
      override prepareTransition(): Promise<void> {
        throw new Error("prepare transition threw");
      }
    }
    const transition = new ThrowTransitionGate();
    transition.open("conversation-a", "operation-a");
    await expect(
      transition.transition("conversation-a", "operation-a", "PAUSED", async () => undefined),
    ).rejects.toThrow("prepare transition threw");

    const closing = new ConversationEmissionGate();
    closing.open("conversation-a", "operation-a");
    closing.adoptClosure("conversation-a", "operation-a");
    closing.adoptCancellation("conversation-a", "operation-a");
    expect(closing.isOpen("conversation-a", "operation-a")).toBe(false);
  });

  test("rolls back synchronous/asynchronous reservation failures and still aborts on authority error", async () => {
    const entry = (): OperationEntry =>
      ({
        conversationId: "conversation-a",
        operationId: "operation-a",
        controller: new AbortController(),
        attempts: new Set(),
        effects: new Set(),
        brokerKey: null,
        members: new Set([{} as OperationRegistry, {} as OperationRegistry]),
        state: "live",
        cancelReserved: false,
        transitionReservation: null,
      }) as OperationEntry;
    const syncEntry = entry();
    let syncRollbacks = 0;
    expect(() =>
      reserveOperationCancellation({
        entry: syncEntry,
        prepare: () => {
          throw new Error("prepare failed");
        },
        rollback: () => {
          syncRollbacks += 1;
        },
        drain: async () => undefined,
        abort: async () => undefined,
      }),
    ).toThrow("prepare failed");
    expect(syncRollbacks).toBe(2);
    expect(syncEntry.cancelReserved).toBe(false);

    const asyncEntry = entry();
    let asyncRollbacks = 0;
    const rejected = reserveOperationCancellation({
      entry: asyncEntry,
      prepare: () => Promise.reject(new Error("drain failed")),
      rollback: () => {
        asyncRollbacks += 1;
      },
      drain: async () => undefined,
      abort: async () => undefined,
    });
    if (rejected.status !== "reserved") throw new Error("reservation was not created");
    await expect(rejected.ready).rejects.toThrow("drain failed");
    expect(asyncRollbacks).toBe(2);
    expect(asyncEntry.cancelReserved).toBe(false);

    const authorityEntry = entry();
    let aborts = 0;
    const authorityFailure = reserveOperationCancellation({
      entry: authorityEntry,
      authority: {
        scopeKey: "scope-a",
        commitCancellation() {
          throw new Error("authority failed");
        },
        isCancellationClaimed: () => false,
      },
      prepare: async () => undefined,
      rollback: () => undefined,
      drain: async () => undefined,
      abort: async () => {
        aborts += 1;
      },
    });
    if (authorityFailure.status !== "reserved") throw new Error("reservation was not created");
    await expect(authorityFailure.commit("cancel")).rejects.toThrow("authority failed");
    expect(aborts).toBe(1);
    expect(authorityEntry.cancelReserved).toBe(false);
  });

  test("reports ambiguous reservations and rejects malformed registered handles", () => {
    const registry = new OperationRegistry();
    registry.create("conversation-a", "operation-a");
    const reservation = registry.reserveCancel("conversation-a", "operation-a");
    expect(reservation.status).toBe("reserved");
    expect(registry.hasAmbiguous("conversation-a")).toBe(true);
    if (reservation.status === "reserved") reservation.rollback();
    expect(registry.hasAmbiguous("conversation-a")).toBe(false);

    const entry = {
      conversationId: "conversation-a",
      operationId: "operation-a",
      controller: new AbortController(),
      attempts: new Set(),
      effects: new Set(),
      brokerKey: null,
      members: new Set(),
      state: "live",
      cancelReserved: false,
      transitionReservation: null,
    } as OperationEntry;
    const operation = registeredOperation(entry, async () => undefined);
    expect(() => operation.addAttempt(null as never)).toThrow("invalid attempt handle");
  });
});

describe("conversation final restart and policy coverage", () => {
  test("rejects a durable configuration key owned by another event type", () => {
    const wrong = stored(1, {
      type: "error",
      payload: { agent_id: null, code: "wrong", message: "wrong" },
    });
    wrong.idempotency_key = "conversation:configured";
    expect(() => configurationEnvelope(durable(), [internal(wrong)], {} as never)).toThrow(
      "invalid durable configuration authority",
    );
  });

  test("uses the same behavioral dry-run projection for review and verify policies", async () => {
    const context = policyContext({
      policy: "review",
      evaluatorAutoAdded: false,
      bindingReadiness: [
        { engine_available: true, model_valid: true },
        { engine_available: false, model_valid: false },
      ],
    });
    const direct = policyDryRun(context);
    const review = await new ReviewConversationPolicy({} as never, async () => null).dryRun(
      context,
    );
    const verify = await new VerifyConversationPolicy({} as never, async () => null).dryRun(
      context,
    );
    expect(review).toEqual(direct);
    expect(verify).toEqual(direct);
    expect(direct).toMatchObject({
      evaluator_auto_added: false,
      engines_available: ["codex"],
      models_valid: false,
    });
  });

  test("composes the service facade and validates bootstrap requests before binding", async () => {
    expect(
      defaultConversationReadiness(process.cwd(), 1).every(
        ({ engine, admitted }) => admitted === (engine === "claude" || engine === "codex"),
      ),
    ).toBe(true);
    const root = await mkdtemp(join(tmpdir(), "vf-conversation-coverage-final-"));
    const libraries = {
      plan: {
        create: async () => ({ content: "plan" }),
        update: async () => ({ content: "plan" }),
      },
      review: {
        currentHead: async () => HASH_A.slice(0, 40),
        review: async () => ({
          reviewed_head: HASH_A.slice(0, 40),
          reviewer: "human:test",
          outcome: "approved" as const,
          evidence_refs: ["review.json"],
        }),
      },
      verify: { run: async () => ({}) },
      orchestrate: {
        dryRun: async () => ({
          participants: [],
          evaluator_auto_added: false,
          engines_available: [],
          models_valid: true,
        }),
        execute: async () => ({ units: [], reviews: [] }),
      },
    };
    let materializeCalls = 0;
    let previewCalls = 0;
    const options = {
      repoRoot: process.cwd(),
      stateDir: join(root, "state"),
      readiness: () => [{ engine: "codex" as const, ready: true, admitted: true }],
      bindingFactory: {
        materialize: () => {
          materializeCalls += 1;
          throw new Error("binding should not materialize");
        },
        preview: () => {
          previewCalls += 1;
          throw new Error("binding should not preview");
        },
      },
      libraries,
    };
    try {
      const bootstrap = createConversationBootstrap(options as never);
      await expect(bootstrap.service.dryRun({ topic: "   " })).rejects.toThrow("invalid topic");
      await expect(bootstrap.service.dryRun({ topic: "valid", max_rounds: 0 })).rejects.toThrow(
        "invalid max rounds",
      );
      await expect(
        bootstrap.services.orchestrate.cancel({
          conversation_id: "missing",
          operation_id: "missing",
          actor: "human",
          reason: null,
        }),
      ).resolves.toMatchObject({ status: 404 });

      const runtime = (bootstrap.service as unknown as { runtime: Record<string, unknown> })
        .runtime;
      const attempts = runtime.attempts as {
        options: {
          appendLifecycle(value: TraceCorrelation, emission: PolicyEmission): Promise<void>;
        };
      };
      await expect(
        attempts.options.appendLifecycle(correlation, {
          idempotency_key: "attempt:coverage:lifecycle:requested",
          event: {
            type: "operation_lifecycle",
            payload: {
              operation_id: "operation-a",
              attempt_id: "attempt-a",
              state: "requested",
            },
          },
        }),
      ).rejects.toThrow("conversation emission authority is closed");

      expect(
        createConversationService({
          ...options,
          stateDir: join(root, "service-state"),
        } as never),
      ).toBeTruthy();

      const notAdmitted = createConversationBootstrap({
        ...options,
        stateDir: join(root, "not-admitted"),
        readiness: () => [{ engine: "codex" as const, ready: true, admitted: false }],
      } as never);
      await expect(
        notAdmitted.service.dryRun({
          topic: "not admitted",
          policy: "direct",
        }),
      ).rejects.toThrow("no ready admitted engine");

      const unavailable = createConversationBootstrap({
        ...options,
        stateDir: join(root, "unavailable"),
        readiness: () => [{ engine: "codex" as const, ready: false, admitted: true }],
      } as never);
      await expect(
        unavailable.service.dryRun({
          topic: "unavailable engine",
          policy: "direct",
          participants: [{ role_ref: "direct", engine: "codex" }],
        }),
      ).rejects.toThrow("explicit_engine_unavailable");
      expect({ materializeCalls, previewCalls }).toEqual({
        materializeCalls: 0,
        previewCalls: 0,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
