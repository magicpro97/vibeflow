import { expect, test } from "bun:test";
import type { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import { ConversationContinuationRuntime } from "../../src/orchestrator/conversation/continuation-runtime.js";
import type { ConversationPolicyRegistry } from "../../src/orchestrator/conversation/policy-registry.js";
import type {
  ConversationRuntime,
  ConversationRuntimeOptions,
} from "../../src/orchestrator/conversation/runtime.js";
import type {
  ApprovalDecision,
  ConversationManifest,
  ConversationOrchestrationResult,
} from "../../src/orchestrator/conversation/types.js";

const manifest: ConversationManifest = {
  version: "1.0",
  conversation_id: "conversation-continuation",
  workflow_id: "workflow-continuation",
  revision_id: "revision-continuation",
  run_id: "run-continuation",
  parent_conversation_id: null,
  parent_revision_id: null,
  topic: "approval queue",
  policy: "approval-queue-test",
  max_rounds: 3,
  repo_root: "/repo",
  phase: 2,
  task_text: "exercise approval queue",
  bindings: [],
  created_at: "2026-08-22T00:00:00.000Z",
};

const approval = (approvalId: string, operationId = "operation-1"): ApprovalDecision => ({
  approval_id: approvalId,
  operation_id: operationId,
  actor: "reviewer",
  outcome: "approve",
  reason: null,
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition was not observed");
}

function fixture(
  continuation: (decision: ApprovalDecision) => Promise<ConversationOrchestrationResult>,
) {
  let operationId: string | undefined = "operation-1";
  const finishes: string[] = [];
  const finalized: ConversationOrchestrationResult[] = [];
  const runtime = {
    manifest: () => manifest,
    operationId: () => operationId,
    context: async () => ({}),
    finish: (id: string) => {
      finishes.push(id);
      operationId = undefined;
    },
  } as unknown as ConversationRuntime;
  const options = {
    artifactStore: {
      readRecord: () => ({ artifacts: [] }),
    } as unknown as ConversationArtifactStore,
    policies: {
      require: () => ({
        continueAfterApproval: (_context: unknown, decision: ApprovalDecision) =>
          continuation(decision),
      }),
    } as unknown as ConversationPolicyRegistry,
  } satisfies Pick<ConversationRuntimeOptions, "artifactStore" | "policies">;
  const continuations = new ConversationContinuationRuntime(
    runtime,
    options,
    async (_current, _operationId, result) => {
      finalized.push(result);
      return result;
    },
    async () => undefined,
    () => "2026-08-22T00:00:00.000Z",
    (task) => task(),
  );
  return {
    continuations,
    finalized,
    finishes,
    reopen: (nextOperationId: string) => {
      operationId = nextOperationId;
    },
  };
}

test("fresh approvals queue behind an active continuation in FIFO order without duplicate runs", async () => {
  let releaseFirst!: () => void;
  let observeFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    observeFirst = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const calls: string[] = [];
  const { continuations, finalized } = fixture(async (decision) => {
    calls.push(decision.approval_id);
    if (decision.approval_id === "approval-a") {
      observeFirst();
      await firstGate;
    }
    return {
      operation_id: decision.operation_id,
      status: "awaiting_approval",
      artifact_refs: [],
    };
  });
  const first = approval("approval-a");
  const second = approval("approval-b");

  continuations.start(manifest.conversation_id, first);
  await firstStarted;
  await Promise.all([
    Promise.resolve().then(() => continuations.start(manifest.conversation_id, second)),
    Promise.resolve().then(() => continuations.start(manifest.conversation_id, { ...second })),
    Promise.resolve().then(() => continuations.start(manifest.conversation_id, second)),
  ]);
  expect(calls).toEqual(["approval-a"]);

  releaseFirst();
  await waitFor(() => finalized.length === 2);
  expect(calls).toEqual(["approval-a", "approval-b"]);
  expect(finalized.map(({ status }) => status)).toEqual(["awaiting_approval", "awaiting_approval"]);

  continuations.start(manifest.conversation_id, { ...second });
  await Bun.sleep(5);
  expect(calls).toEqual(["approval-a", "approval-b"]);
});

test.each(["completed", "throw"] as const)(
  "%s continuation drops queued approvals and does not leak them into a reopened operation",
  async (outcome) => {
    let releaseFirst!: () => void;
    let observeFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      observeFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: string[] = [];
    const runtime = fixture(async (decision) => {
      calls.push(decision.approval_id);
      if (decision.approval_id === "approval-a") {
        observeFirst();
        await firstGate;
        if (outcome === "throw") throw new Error("continuation failed");
        return {
          operation_id: decision.operation_id,
          status: "completed",
          artifact_refs: [],
        };
      }
      return {
        operation_id: decision.operation_id,
        status: "awaiting_approval",
        artifact_refs: [],
      };
    });

    runtime.continuations.start(manifest.conversation_id, approval("approval-a"));
    await firstStarted;
    runtime.continuations.start(manifest.conversation_id, approval("approval-b"));
    releaseFirst();
    await waitFor(() => runtime.finishes.length === 1);
    expect(calls).toEqual(["approval-a"]);
    expect(runtime.finalized.at(-1)?.status).toBe(outcome === "throw" ? "failed" : "completed");

    runtime.reopen("operation-2");
    runtime.continuations.start(manifest.conversation_id, approval("approval-c", "operation-2"));
    await waitFor(() => calls.includes("approval-c"));
    expect(calls).toEqual(["approval-a", "approval-c"]);
  },
);
