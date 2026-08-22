import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptHandle, EngineSessionResult } from "../../src/dispatch/session-types.js";
import {
  type BindingAuthoritySnapshot,
  ConversationArtifactStore,
  conversationManifestPath,
  operationAuthorityPath,
} from "../../src/orchestrator/conversation/artifact-store.js";
import { ControlRuntime } from "../../src/orchestrator/conversation/control-runtime.js";
import { assertAttemptEmission } from "../../src/orchestrator/conversation/emission-authority.js";
import {
  ConversationAuthorityClosedError,
  ConversationEmissionGate,
} from "../../src/orchestrator/conversation/lifecycle-gate.js";
import { OperationRegistry } from "../../src/orchestrator/conversation/operation-registry.js";
import {
  ConversationSubscribers,
  projectOrchestrationResult,
} from "../../src/orchestrator/conversation/policy-registry.js";
import type {
  AttemptEmission,
  ConversationManifest,
  PolicyAttemptPurpose,
} from "../../src/orchestrator/conversation/types.js";
import type {
  InternalTraceStoreRecord,
  PublicStoredTraceEvent,
  TraceCorrelation,
} from "../../src/orchestrator/trace/types.js";

const ROLE_HASH = "a".repeat(64);
const manifestBinding = () => ({
  participant_id: "participant-1",
  input: { roleRef: "direct", engine: "codex" as const, sessionMode: "fresh" as const },
});
const bindingAuthority = (): BindingAuthoritySnapshot => ({
  participant_id: "participant-1",
  engine: "codex",
  model: "gpt-5.4",
  session_mode: "fresh",
  role_source: "builtin",
  role_hash: ROLE_HASH,
  skill_hashes: [],
});

const result = (attemptId: string): EngineSessionResult => ({
  attemptId,
  engine: "codex",
  ok: true,
  state: "completed",
  lifecycle: ["requested", "dispatched", "completed"],
  output: "ok",
  evidenceStatus: "persisted",
  nativeSessionStatus: "unavailable",
});

function handle(attemptId: string, calls: string[]): AttemptHandle {
  return {
    attemptId,
    completion: Promise.resolve(result(attemptId)),
    async terminate(reason) {
      calls.push(`terminate:${attemptId}:${reason ?? ""}`);
    },
    readResumeBinding: () => undefined,
    readEvidenceBinding: () => undefined,
  };
}

test("attempt purpose lanes admit only their frozen event families", () => {
  const participantId = "participant-1";
  const emissions: Record<AttemptEmission["event"]["type"], AttemptEmission> = {
    precommit: {
      idempotency_key: "lane:precommit",
      event: {
        type: "precommit",
        payload: { round_id: "round-1", participant_id: participantId, answer: "a", evidence: [] },
      },
    },
    agent_response_delta: {
      idempotency_key: "lane:delta",
      event: {
        type: "agent_response_delta",
        payload: {
          round_id: "round-1",
          participant_id: participantId,
          content_delta: "a",
          final_claim: null,
          final_evidence: [],
          completes_response: false,
        },
      },
    },
    tool_action: {
      idempotency_key: "lane:tool",
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
    },
    evaluator_assessment: {
      idempotency_key: "lane:assessment",
      event: {
        type: "evaluator_assessment",
        payload: {
          round_id: "round-1",
          stage: "blind",
          assessment: {
            agreement: { value: true, evidence: "" },
            conflict_resolution: { value: true, evidence: "" },
            evidence_quality: { value: true, evidence: "" },
            convergence: { value: "not_applicable", evidence: "" },
          },
        },
      },
    },
    error: {
      idempotency_key: "lane:error",
      event: { type: "error", payload: { agent_id: participantId, code: "failed", message: "x" } },
    },
  };
  const expected: Record<PolicyAttemptPurpose, AttemptEmission["event"]["type"][]> = {
    baseline: [],
    participant: ["precommit", "agent_response_delta", "tool_action", "error"],
    evaluator: ["evaluator_assessment", "tool_action", "error"],
    direct: ["agent_response_delta", "tool_action", "error"],
    plan: ["agent_response_delta", "tool_action", "error"],
    review: ["agent_response_delta", "tool_action", "error"],
    verify: ["agent_response_delta", "tool_action", "error"],
    orchestrate: ["agent_response_delta", "tool_action", "error"],
  };
  for (const [purpose, allowed] of Object.entries(expected) as Array<
    [PolicyAttemptPurpose, AttemptEmission["event"]["type"][]]
  >) {
    for (const [type, emission] of Object.entries(emissions) as Array<
      [AttemptEmission["event"]["type"], AttemptEmission]
    >) {
      const run = () => assertAttemptEmission(emission, participantId, purpose);
      if (allowed.includes(type)) expect(run, `${purpose}:${type}`).not.toThrow();
      else expect(run, `${purpose}:${type}`).toThrow(/purpose|authorized|authority/i);
    }
  }
});

const controlHarness = (closedLane: "approval" | "cancel", generic = false) => {
  const operations = new OperationRegistry();
  operations.create("conversation-1", "operation-1");
  const manifest = {} as ConversationManifest;
  const closed = () =>
    Promise.reject(
      generic
        ? new Error("injected durable store failure")
        : new ConversationAuthorityClosedError("conversation control authority is closed"),
    );
  const records = [
    {
      stored_event: {
        event: {
          type: "approval_requested",
          payload: {
            token: {
              approval_id: "approval-1",
              operation_id: "operation-1",
              actor: "reviewer",
            },
          },
        },
      },
    },
  ] as unknown as InternalTraceStoreRecord[];
  const runtime = new ControlRuntime({
    operations,
    manifest: () => manifest,
    authority: () => ({ manifest, operationId: "operation-1" }),
    read: async () => records,
    correlation: () => ({}) as TraceCorrelation,
    appendActive: () =>
      closedLane === "approval" ? closed() : Promise.reject(new Error("unexpected approval")),
    appendCancellation: () =>
      closedLane === "cancel" ? closed() : Promise.reject(new Error("unexpected cancel")),
    appendTransition: () => Promise.reject(new Error("unexpected transition")),
    appendTerminal: () => Promise.reject(new Error("unexpected terminal")),
  });
  return { operations, runtime };
};

test("approval/cancel races map only typed closed authority to stable 409 results", async () => {
  const approval = controlHarness("approval");
  await expect(
    approval.runtime.resolveApproval(
      "conversation-1",
      {
        approval_id: "approval-1",
        operation_id: "operation-1",
        actor: "reviewer",
        outcome: "approve",
        reason: null,
      },
      true,
    ),
  ).resolves.toEqual({
    response: { status: 409, body: { code: "approval_conflict" } },
    fresh: false,
  });

  const cancellation = controlHarness("cancel");
  await expect(
    cancellation.runtime.cancel({
      conversation_id: "conversation-1",
      operation_id: "operation-1",
      actor: "user",
      reason: null,
    }),
  ).resolves.toEqual({ status: 409, body: { code: "operation_not_cancellable" } });
  const retry = cancellation.operations.reserveCancel("conversation-1", "operation-1");
  expect(retry.status).toBe("reserved");
  if (retry.status === "reserved") retry.rollback();
});

test("closed gate lanes reject with the typed authority error", async () => {
  const gate = new ConversationEmissionGate();
  gate.open("conversation-1", "operation-1");
  await gate.terminal("conversation-1", "operation-1", "STOPPED", async () => {});
  await expect(
    gate.control("conversation-1", "operation-1", false, async () => undefined),
  ).rejects.toBeInstanceOf(ConversationAuthorityClosedError);
  await expect(
    gate.cancel("conversation-1", "operation-1", async () => undefined),
  ).rejects.toBeInstanceOf(ConversationAuthorityClosedError);
});

test("approval/cancel preserve genuine store failures", async () => {
  const approval = controlHarness("approval", true);
  await expect(
    approval.runtime.resolveApproval(
      "conversation-1",
      {
        approval_id: "approval-1",
        operation_id: "operation-1",
        actor: "reviewer",
        outcome: "approve",
        reason: null,
      },
      true,
    ),
  ).rejects.toThrow("injected durable store failure");
  const cancellation = controlHarness("cancel", true);
  await expect(
    cancellation.runtime.cancel({
      conversation_id: "conversation-1",
      operation_id: "operation-1",
      actor: "user",
      reason: null,
    }),
  ).rejects.toThrow("injected durable store failure");
});

test("a throwing manifest lookup rolls back cancellation preparation", async () => {
  const operations = new OperationRegistry();
  operations.create("conversation-1", "operation-1");
  const runtime = new ControlRuntime({
    operations,
    manifest: () => {
      throw new Error("injected manifest read failure");
    },
    authority: () => null,
    read: async () => [],
    correlation: () => ({}) as TraceCorrelation,
    appendActive: () => Promise.reject(new Error("unexpected active append")),
    appendCancellation: () => Promise.reject(new Error("unexpected cancel append")),
    appendTransition: () => Promise.reject(new Error("unexpected transition append")),
    appendTerminal: () => Promise.reject(new Error("unexpected terminal append")),
  });
  await expect(
    runtime.cancel({
      conversation_id: "conversation-1",
      operation_id: "operation-1",
      actor: "user",
      reason: null,
    }),
  ).rejects.toThrow("injected manifest read failure");
  const retry = operations.reserveCancel("conversation-1", "operation-1");
  expect(retry.status).toBe("reserved");
  if (retry.status === "reserved") retry.rollback();
});

test("terminal settlement dominates a prepared cancellation and drains shared handles", async () => {
  let releasePrepare!: () => void;
  const prepareGate = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });
  const authority = {
    scopeKey: "stop-dominates-cancel",
    commitCancellation: () => true,
    isCancellationClaimed: () => false,
  };
  let rollbacks = 0;
  const settled: string[] = [];
  const left = new OperationRegistry({
    authority,
    onCancelPrepare: () => prepareGate,
    onCancelRollback: () => {
      rollbacks += 1;
    },
    onSettled: (_id, _operationId, lifecycle) => settled.push(`left:${lifecycle}`),
  });
  const right = new OperationRegistry({
    authority,
    onCancelPrepare: async () => {},
    onCancelRollback: () => {
      rollbacks += 1;
    },
    onSettled: (_id, _operationId, lifecycle) => settled.push(`right:${lifecycle}`),
  });
  const operation = left.create("conversation-1", "operation-1");
  right.create("conversation-1", "operation-1");
  const calls: string[] = [];
  operation.addAttempt(handle("attempt-1", calls));
  const cancellation = left.reserveCancel("conversation-1", "operation-1");
  expect(cancellation.status).toBe("reserved");
  if (cancellation.status !== "reserved") throw new Error("cancellation was not prepared");

  await right.settleAndTerminate("conversation-1", "operation-1", "remote stop", "STOPPED");
  expect(operation.signal.aborted).toBe(true);
  expect(calls).toEqual(["terminate:attempt-1:remote stop"]);
  expect(settled.sort()).toEqual(["left:STOPPED", "right:STOPPED"]);
  expect(rollbacks).toBe(2);
  releasePrepare();
  await cancellation.ready;
  await expect(cancellation.commit("too late")).resolves.toBe(false);
  expect(left.reserveCancel("conversation-1", "operation-1").status).toBe("not_cancellable");
});

test("terminal rollback restores the lifecycle that was durably reached by an in-flight transition", async () => {
  const cases = [
    { fromPaused: false, lifecycle: "PAUSED" as const, transitionFails: true, expectedOpen: true },
    {
      fromPaused: false,
      lifecycle: "PAUSED" as const,
      transitionFails: false,
      expectedOpen: false,
    },
    { fromPaused: true, lifecycle: "ACTIVE" as const, transitionFails: true, expectedOpen: false },
    { fromPaused: true, lifecycle: "ACTIVE" as const, transitionFails: false, expectedOpen: true },
  ];
  for (const item of cases) {
    const gate = new ConversationEmissionGate();
    gate.open("conversation-1", "operation-1", item.fromPaused);
    const transition = gate.transition(
      "conversation-1",
      "operation-1",
      item.lifecycle,
      async () => {
        if (item.transitionFails) throw new Error("transition append failed");
      },
    );
    const terminal = gate.terminal("conversation-1", "operation-1", "FAILED", async () => {
      throw new Error("terminal append failed");
    });
    void terminal.catch(() => undefined);
    if (item.transitionFails) await expect(transition).rejects.toThrow("transition append failed");
    else await transition;
    await expect(terminal).rejects.toThrow("terminal append failed");
    gate.releaseFailedTerminal("conversation-1", "operation-1", "FAILED");
    expect(
      gate.isOpen("conversation-1", "operation-1"),
      `${item.lifecycle}:${item.transitionFails ? "failed" : "persisted"}`,
    ).toBe(item.expectedOpen);
    await expect(
      gate.control("conversation-1", "operation-1", true, async () => "admitted"),
    ).resolves.toBe("admitted");
  }
});

test("a competing terminal caller awaits and returns the already-reserved winner", async () => {
  const gate = new ConversationEmissionGate();
  gate.open("conversation-1", "operation-1");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let appends = 0;
  const stopping = gate.terminal("conversation-1", "operation-1", "STOPPED", async () => {
    appends += 1;
    await blocked;
  });
  const completing = gate.terminal("conversation-1", "operation-1", "COMPLETED", async () => {
    appends += 1;
  });
  release();
  await expect(stopping).resolves.toBe("STOPPED");
  await expect(completing).resolves.toBe("STOPPED");
  expect(appends).toBe(1);
});

test("a failed terminal reservation never masquerades as a committed winner", async () => {
  const gate = new ConversationEmissionGate();
  gate.open("conversation-1", "operation-1");
  const failed = gate.terminal("conversation-1", "operation-1", "STOPPED", async () => {
    throw new Error("terminal append failed");
  });
  await expect(failed).rejects.toThrow("terminal append failed");
  await Promise.resolve();
  let fallbackAppends = 0;
  await expect(
    gate.terminal("conversation-1", "operation-1", "FAILED", async () => {
      fallbackAppends += 1;
    }),
  ).rejects.toThrow("terminal append failed");
  expect(fallbackAppends).toBe(0);
  gate.releaseFailedTerminal("conversation-1", "operation-1", "STOPPED");
  await expect(
    gate.terminal("conversation-1", "operation-1", "FAILED", async () => {
      fallbackAppends += 1;
    }),
  ).resolves.toBe("FAILED");
  expect(fallbackAppends).toBe(1);
});

test("adopting a durable terminal winner bypasses local pause remapping", async () => {
  const gate = new ConversationEmissionGate();
  gate.open("conversation-1", "operation-1", true);
  let locallyReserved: "ABORTED" | undefined;
  const failed = gate.terminal("conversation-1", "operation-1", "COMPLETED", async (winner) => {
    locallyReserved = winner as "ABORTED";
    throw new Error("durable competitor won");
  });
  await expect(failed).rejects.toThrow("durable competitor won");
  expect(locallyReserved).toBe("ABORTED");
  gate.releaseFailedTerminal("conversation-1", "operation-1", "ABORTED");
  expect(gate.adoptTerminal("conversation-1", "operation-1", "COMPLETED")).toBe("COMPLETED");
  expect(gate.finish("conversation-1", "operation-1")).toBe(true);
});

test("subscriber replay drains events synchronously enqueued by its listener", async () => {
  const subscribers = new ConversationSubscribers();
  const event = (seq: number) =>
    ({ conversation_id: "conversation-1", seq }) as PublicStoredTraceEvent;
  const observed: number[] = [];
  subscribers.subscribe(
    "conversation-1",
    (value) => {
      observed.push(value.seq);
      if (value.seq === 1) subscribers.notify(event(2));
    },
    async () => [event(1)],
    0,
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(observed).toEqual([1, 2]);
});

test("subscriber replay handles a large backlog and preserves its reentrant live tail", async () => {
  const subscribers = new ConversationSubscribers();
  const event = (seq: number) =>
    ({ conversation_id: "conversation-1", seq }) as PublicStoredTraceEvent;
  const backlog = Array.from({ length: 130_000 }, (_, index) => event(index + 1));
  const observed: number[] = [];
  subscribers.subscribe(
    "conversation-1",
    (value) => {
      observed.push(value.seq);
      if (value.seq === 1) subscribers.notify(event(130_001));
    },
    async () => backlog,
    0,
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(observed).toHaveLength(130_001);
  expect(observed[0]).toBe(1);
  expect(observed.at(-1)).toBe(130_001);
});

test("policy result projection contains hostile accessors as a failed result", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-result-"));
  try {
    const store = new ConversationArtifactStore({ dir: join(root, "manifests") });
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      operation_id: { enumerable: true, value: "operation-1" },
      status: { enumerable: true, value: "completed" },
      artifact_refs: {
        enumerable: true,
        get() {
          throw new Error("hostile policy getter escaped");
        },
      },
    });
    expect(() =>
      projectOrchestrationResult(hostile, "operation-1", "conversation-1", store),
    ).not.toThrow();
    expect(projectOrchestrationResult(hostile, "operation-1", "conversation-1", store)).toEqual({
      operation_id: "operation-1",
      status: "failed",
      artifact_refs: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation manifest is durable and existence is independent from a trace journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-store-"));
  try {
    const store = new ConversationArtifactStore({ dir: join(root, "manifests") });
    expect(store.has("missing")).toBe(false);
    expect(existsSync(join(root, "trace"))).toBe(false);

    store.create(
      {
        version: "1.0",
        conversation_id: "conversation-1",
        revision_id: "revision-1",
        workflow_id: "workflow-1",
        run_id: "run-1",
        topic: "durable topic",
        policy: "direct",
        max_rounds: 1,
        repo_root: root,
        phase: 1,
        task_text: "durable topic",
        bindings: [manifestBinding()],
        parent_conversation_id: null,
        parent_revision_id: null,
        created_at: "2026-08-22T00:00:00.000Z",
      },
      [bindingAuthority()],
    );
    store.recordOperation("conversation-1", "operation-1");
    expect(store.has("conversation-1")).toBe(true);
    const restarted = new ConversationArtifactStore({ dir: join(root, "manifests") });
    expect(restarted.read("conversation-1")).toMatchObject({
      conversation_id: "conversation-1",
      topic: "durable topic",
    });
    expect(restarted.operationOwner("operation-1")).toBe("conversation-1");
    expect(() => restarted.recordOperation("conversation-2", "operation-1")).toThrow(
      "durable operation authority conflict",
    );
    const persisted = store.read("conversation-1");
    if (!persisted) throw new Error("manifest was not persisted");
    expect(() => store.create({ ...persisted, topic: "different" }, [bindingAuthority()])).toThrow(
      "conversation manifest already exists",
    );
    writeFileSync(operationAuthorityPath(join(root, "manifests"), "operation-1"), "{}");
    expect(() => restarted.operationOwner("operation-1")).toThrow("invalid operation authority");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest store fails closed for symlink and hardlink aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-store-path-"));
  try {
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    const alias = join(root, "alias");
    symlinkSync(real, alias);
    expect(() => new ConversationArtifactStore({ dir: alias })).toThrow();

    const safe = new ConversationArtifactStore({ dir: join(root, "safe") });
    safe.create(
      {
        version: "1.0",
        conversation_id: "hardlink-source",
        revision_id: "revision",
        workflow_id: "workflow",
        run_id: "run",
        topic: "x",
        policy: "direct",
        max_rounds: 1,
        repo_root: root,
        phase: 1,
        task_text: "x",
        bindings: [manifestBinding()],
        parent_conversation_id: null,
        parent_revision_id: null,
        created_at: "2026-08-22T00:00:00.000Z",
      },
      [bindingAuthority()],
    );
    const manifestPath = conversationManifestPath(join(root, "safe"), "hardlink-source");
    const other = join(root, "manifest-hardlink");
    linkSync(manifestPath, other);
    expect(() => safe.read("hardlink-source")).toThrow("unsafe manifest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact catalog rejects forged deep state, unsafe native IDs, IDs, and caps", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-store-validation-"));
  try {
    const directory = join(root, "safe");
    const store = new ConversationArtifactStore({ dir: directory });
    store.create(
      {
        version: "1.0",
        conversation_id: "conversation-1",
        revision_id: "revision-1",
        workflow_id: "workflow-1",
        run_id: "run-1",
        topic: "x",
        policy: "direct",
        max_rounds: 1,
        repo_root: root,
        phase: 1,
        task_text: "x",
        bindings: [manifestBinding()],
        parent_conversation_id: null,
        parent_revision_id: null,
        created_at: "2026-08-22T00:00:00.000Z",
      },
      [bindingAuthority()],
    );

    expect(() =>
      store.prepareCreateArtifact("conversation-1", "../escape", {
        artifact_type: "synthesis",
        content: "unsafe id",
        idempotency_key: "unsafe:id",
      }),
    ).toThrow("invalid artifact");
    expect(() =>
      store.prepareCreateArtifact("conversation-1", "artifact-extra", {
        artifact_type: "synthesis",
        content: "extra",
        idempotency_key: "unsafe:extra",
        raw_path: "/private/artifact",
      } as never),
    ).toThrow("invalid artifact request");
    expect(() =>
      store.prepareCreateArtifact("conversation-1", "artifact-large", {
        artifact_type: "synthesis",
        content: new Uint8Array(1024 * 1024 + 1),
        idempotency_key: "unsafe:large",
      }),
    ).toThrow("invalid artifact content");

    const prepared = store.prepareCreateArtifact("conversation-1", "artifact-1", {
      artifact_type: "synthesis",
      content: "safe",
      idempotency_key: "safe:create",
    });
    prepared.commit();
    const created = prepared.result;
    const manifestPath = conversationManifestPath(directory, "conversation-1");
    const original = readFileSync(manifestPath);

    const extra = JSON.parse(original.toString("utf8"));
    extra.binding_authorities[0].raw_env = { SECRET: "value" };
    writeFileSync(manifestPath, JSON.stringify(extra));
    expect(() => store.readRecord("conversation-1")).toThrow("invalid manifest");

    const unsafeNative = JSON.parse(original.toString("utf8"));
    unsafeNative.resume_bindings = [
      {
        participant_id: "participant-1",
        attemptId: "attempt-1",
        engine: "codex",
        nativeSessionId: "/tmp/private-session",
      },
    ];
    writeFileSync(manifestPath, JSON.stringify(unsafeNative));
    expect(() => store.readRecord("conversation-1")).toThrow("invalid manifest");

    const oversized = JSON.parse(original.toString("utf8"));
    oversized.artifacts = Array.from({ length: 513 }, () => oversized.artifacts[0]);
    writeFileSync(manifestPath, JSON.stringify(oversized));
    expect(() => store.readRecord("conversation-1")).toThrow("invalid manifest");

    writeFileSync(manifestPath, original);
    const contentPath = join(
      directory,
      "content",
      `${created.ref.slice("vf-artifact-".length)}.bin`,
    );
    writeFileSync(contentPath, "evil");
    expect(() => store.readArtifact("conversation-1", "artifact-1")).toThrow(
      "artifact content hash mismatch",
    );
    writeFileSync(contentPath, "sa");
    expect(() => store.readArtifact("conversation-1", "artifact-1")).toThrow(
      "artifact content hash mismatch",
    );
    writeFileSync(contentPath, "safe");
    linkSync(contentPath, join(root, "artifact-hardlink"));
    expect(() => store.readArtifact("conversation-1", "artifact-1")).toThrow("unsafe artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a committed duplicate artifact reservation survives the original writer rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "vf-conversation-artifact-race-"));
  try {
    const directory = join(root, "manifests");
    const first = new ConversationArtifactStore({ dir: directory });
    first.create(
      {
        version: "1.0",
        conversation_id: "conversation-1",
        revision_id: "revision-1",
        workflow_id: "workflow-1",
        run_id: "run-1",
        topic: "shared artifact",
        policy: "direct",
        max_rounds: 1,
        repo_root: root,
        phase: 1,
        task_text: "shared artifact",
        bindings: [manifestBinding()],
        parent_conversation_id: null,
        parent_revision_id: null,
        created_at: "2026-08-22T00:00:00.000Z",
      },
      [bindingAuthority()],
    );
    const second = new ConversationArtifactStore({ dir: directory });
    const request = {
      artifact_type: "synthesis" as const,
      content: "shared content",
      idempotency_key: "shared:create",
    };

    const original = first.prepareCreateArtifact("conversation-1", "artifact-original", request);
    const duplicate = second.prepareCreateArtifact("conversation-1", "artifact-duplicate", request);
    expect(duplicate.result).toEqual(original.result);

    duplicate.commit();
    original.rollback();

    expect(second.readRecord("conversation-1")?.artifacts).toHaveLength(1);
    expect(
      new TextDecoder().decode(
        second.readArtifact("conversation-1", original.result.artifact_id) ?? new Uint8Array(),
      ),
    ).toBe("shared content");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operation cancellation is reserved, append-before-abort, and exactly once", async () => {
  const calls: string[] = [];
  const registry = new OperationRegistry();
  const operation = registry.create("conversation-1", "operation-1");
  operation.addAttempt(handle("attempt-1", calls));

  const reservation = registry.reserveCancel("conversation-1", "operation-1");
  expect(reservation.status).toBe("reserved");
  expect(operation.signal.aborted).toBe(false);
  calls.push("journal:caller_cancelled");
  if (reservation.status === "reserved") {
    await Promise.all([
      reservation.commit("user request"),
      reservation.commit("duplicate request"),
    ]);
  }

  expect(calls).toEqual(["journal:caller_cancelled", "terminate:attempt-1:user request"]);
  expect(operation.signal.aborted).toBe(true);
  expect(registry.get("conversation-1", "operation-1")).toBeNull();
  expect(registry.reserveCancel("conversation-1", "operation-1")).toEqual({
    status: "not_cancellable",
  });
});

test("operation ids have one global owner and wrong-conversation cancel is typed", () => {
  const registry = new OperationRegistry();
  registry.create("conversation-1", "operation-shared");

  expect(() => registry.create("conversation-2", "operation-shared")).toThrow(
    "operation already exists",
  );
  expect(registry.reserveCancel("conversation-2", "operation-shared")).toEqual({
    status: "conversation_mismatch",
  });
  expect(registry.reserveCancel("conversation-2", "operation-missing")).toEqual({
    status: "not_found",
  });
});

test("settled operations terminate attempts and cannot be cancelled or stopped", async () => {
  const calls: string[] = [];
  const registry = new OperationRegistry();
  const operation = registry.create("conversation-1", "operation-1");
  operation.addAttempt(handle("attempt-1", calls));

  await registry.settleAndTerminate("conversation-1", "operation-1", "completed");
  expect(registry.get("conversation-1", "operation-1")).toBeNull();
  expect(registry.reserveCancel("conversation-1", "operation-1")).toEqual({
    status: "not_cancellable",
  });
  await registry.stopConversation("conversation-1", "too late");

  expect(operation.signal.aborted).toBe(true);
  expect(calls).toEqual(["terminate:attempt-1:completed"]);
});

test("terminal ownership tombstones are FIFO-capped and pruned ids are reusable", async () => {
  const registry = new OperationRegistry({ tombstoneLimit: 2 });
  for (const operationId of ["operation-1", "operation-2", "operation-3"]) {
    registry.create("conversation-1", operationId);
    await registry.settleAndTerminate("conversation-1", operationId, "completed");
  }

  expect(registry.reserveCancel("conversation-1", "operation-1")).toEqual({
    status: "not_found",
  });
  expect(registry.reserveCancel("conversation-1", "operation-2")).toEqual({
    status: "not_cancellable",
  });
  expect(registry.reserveCancel("conversation-2", "operation-3")).toEqual({
    status: "conversation_mismatch",
  });
  expect(() => registry.create("conversation-2", "operation-1")).not.toThrow();
});

test("completed attempt handles are removed and stop terminates remaining attempts once", async () => {
  const calls: string[] = [];
  const registry = new OperationRegistry();
  const operation = registry.create("conversation-1", "operation-1");
  const completed = handle("attempt-completed", calls);
  operation.addAttempt(completed);
  operation.addAttempt(handle("attempt-live", calls));
  operation.removeAttempt(completed);

  await Promise.all([
    registry.stopConversation("conversation-1", "stopped"),
    registry.stopConversation("conversation-1", "stopped again"),
  ]);

  expect(calls).toEqual(["terminate:attempt-live:stopped"]);
});

test("cancel rollback preserves an operation and stop aborts every live operation", async () => {
  const calls: string[] = [];
  const registry = new OperationRegistry();
  const first = registry.create("conversation-1", "operation-1");
  const second = registry.create("conversation-1", "operation-2");
  first.addAttempt(handle("attempt-1", calls));
  second.addAttempt(handle("attempt-2", calls));

  const reservation = registry.reserveCancel("conversation-1", "operation-1");
  if (reservation.status === "reserved") reservation.rollback();
  expect(first.signal.aborted).toBe(false);

  await registry.stopConversation("conversation-1", "conversation stopped");
  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(true);
  expect(calls).toEqual([
    "terminate:attempt-1:conversation stopped",
    "terminate:attempt-2:conversation stopped",
  ]);
});

test("reentrant and concurrent termination callers share one complete drain promise", async () => {
  const registry = new OperationRegistry();
  const operation = registry.create("conversation-1", "operation-1");
  let release!: () => void;
  const drained = new Promise<void>((resolve) => {
    release = resolve;
  });
  let terminateCalls = 0;
  operation.addAttempt({
    attemptId: "attempt-1",
    completion: drained.then(() => result("attempt-1")),
    async terminate() {
      terminateCalls += 1;
      await drained;
    },
    readResumeBinding: () => undefined,
    readEvidenceBinding: () => undefined,
  });
  let reentrant: Promise<void> | undefined;
  operation.signal.addEventListener(
    "abort",
    () => {
      reentrant = registry.stopConversation("conversation-1", "reentrant");
    },
    { once: true },
  );
  const first = registry.settleAndTerminate("conversation-1", "operation-1", "terminal");
  const second = registry.settleAndTerminate("conversation-1", "operation-1", "terminal");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reentrant).toBeDefined();
  let settled = false;
  void Promise.all([first, second, reentrant]).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect({ settled, terminateCalls }).toEqual({ settled: false, terminateCalls: 1 });
  release();
  await Promise.all([first, second, reentrant]);
  expect(settled).toBe(true);
});
