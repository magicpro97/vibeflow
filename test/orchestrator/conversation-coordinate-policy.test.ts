import { describe, expect, test } from "bun:test";
import type { ResolvedAgentBinding } from "../../src/agents/binding.js";
import { AGENT_ENGINE, AGENT_ROLE_SOURCE } from "../../src/core/agent-contract.js";
import { ROLE_MODEL, ROLE_SANDBOX, ROLE_TOOL_INTENT } from "../../src/core/role-contract.js";
import { CONVERSATION_ROLE_NAME } from "../../src/core/role-name-contract.js";
import { extractEngineResponseText } from "../../src/dispatch/prompt.js";
import { ENGINE_COORDINATION_WORKSPACE_ACCESS } from "../../src/dispatch/session-contract.js";
import { CONVERSATION_COMMAND_RESULT_STATUS } from "../../src/orchestrator/conversation/conversation-command-result-contract.js";
import {
  CONVERSATION_COORDINATION_DIAGNOSTIC,
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_ESCALATION_REASON,
  CONVERSATION_COORDINATION_PHASE,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCE,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCES,
  CONVERSATION_COORDINATION_SETTLEMENT,
  CONVERSATION_COORDINATION_TOOL,
  conversationCoordinationEpochId,
  conversationCoordinationWorkspaceKey,
} from "../../src/orchestrator/conversation/conversation-coordination-contract.js";
import {
  type ConversationCoordinationStateV1,
  emptyConversationCoordinationState,
  foldConversationCoordinationRecords,
} from "../../src/orchestrator/conversation/conversation-coordination-fold.js";
import { CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC } from "../../src/orchestrator/conversation/conversation-coordination-output.js";
import {
  recoverCoordinationPolicyFailure,
  settleCoordinationWorkspace,
} from "../../src/orchestrator/conversation/conversation-coordination-policy-result.js";
import type {
  ConversationCoordinationDirectiveV1,
  ConversationCoordinationRecordV1,
  StoredConversationCoordinationRecordV1,
} from "../../src/orchestrator/conversation/conversation-coordination-records.js";
import {
  CONVERSATION_DELEGATION_TASK_DIAGNOSTIC,
  CONVERSATION_DELEGATION_VERIFY_ORACLE,
} from "../../src/orchestrator/conversation/conversation-delegation-workspace-contract.js";
import { CONVERSATION_POLICY } from "../../src/orchestrator/conversation/conversation-policy-contract.js";
import {
  CONVERSATION_TOOL_ACTION_STATUS,
  CONVERSATION_TRACE_EVENT_KIND,
} from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import { CoordinateConversationPolicy } from "../../src/orchestrator/conversation/coordinate-policy.js";
import { DirectConversationPolicy } from "../../src/orchestrator/conversation/direct-policy.js";
import { CONVERSATION_TURN_INSTRUCTION_KIND } from "../../src/orchestrator/conversation/turn-delivery-contract.js";
import type {
  ArtifactCreateRequest,
  ConversationArtifactRef,
  ConversationContext,
  ConversationPolicy,
  CoordinatorEmission,
  PolicyAttemptRequest,
} from "../../src/orchestrator/conversation/types.js";

const task = {
  task_id: "task-1",
  executor_participant_id: "executor-1",
  goal: "Implement direct coordination",
  scope: ["src/orchestrator/conversation"],
  forbidden: ["src/security/"],
  must_haves: ["durable replay"],
  verify_oracles: [CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST],
  source_message_refs: ["message-1"],
};
const replacementTask = {
  ...task,
  task_id: "task-2",
  goal: "Implement the safe replanned coordination path",
};
const VERIFIED_HEAD = "0".repeat(40);
const workspaceKey = (revisionId = "revision-1"): string =>
  conversationCoordinationWorkspaceKey(
    conversationCoordinationEpochId({
      workflow_id: "workflow-1",
      operation_id: `operation-${revisionId}`,
      revision_id: revisionId,
    }),
  );
const delegate = (delegatedTask = task): ConversationCoordinationDirectiveV1 => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
  task: delegatedTask,
});
const pendingDelegateRecord = (): StoredConversationCoordinationRecordV1 => ({
  artifact_ref: "artifact-1",
  record: {
    schema_version: "1.0",
    epoch_id: conversationCoordinationEpochId({
      workflow_id: "workflow-1",
      operation_id: "operation-revision-1",
      revision_id: "revision-1",
    }),
    record_id: "record-pending",
    operation_id: "operation-revision-1",
    revision_id: "revision-1",
    step: 1,
    coordinator_participant_id: "coordinator-1",
    actor_participant_id: "coordinator-1",
    actor_lane: "coordinator",
    previous_ref: null,
    directive: delegate(),
  },
});
const clarification = () => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION,
  clarification: {
    task_id: task.task_id,
    question_id: "question-1",
    question: "Which contract owns the status value?",
    blocking_reason: "Two legacy values exist.",
    attempted_interpretations: ["Use the public wire contract"],
    required_decision: "Select one canonical contract.",
  },
});
const resolution = () => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION,
  resolution: {
    task_id: task.task_id,
    question_id: "question-1",
    answer: "Use the public wire contract.",
    source: "repo-evidence",
    source_refs: ["src/orchestrator/conversation/conversation-public-wire-contract.ts"],
    assumptions: [],
  },
});
const completion = (completedTask = task) => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
  completion: {
    task_id: completedTask.task_id,
    summary: "Implemented the coordination state machine.",
    changed_paths: ["src/orchestrator/conversation/coordinate-policy.ts"],
    evidence_refs: ["test:coordinate-policy"],
    verification: { commands: [CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST], passed: true },
  },
});
const finalization = (
  reviewedHead = VERIFIED_HEAD,
  completedTaskIds: readonly string[] = [task.task_id],
) => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
  finalization: {
    completed_task_ids: [...completedTaskIds],
    reviewed_head: reviewedHead,
    summary: "Coordination completed with measured evidence.",
    evidence_refs: ["test:coordinate-policy", "workspace:clean"],
  },
});
const blocked = (recoverable: boolean) => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED,
  blocked: {
    task_id: task.task_id,
    reason: "The current contract cannot safely complete.",
    evidence_refs: ["evidence:blocker"],
    recoverable,
  },
});
const escalation = () => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT,
  escalation: {
    task_id: task.task_id,
    question_id: "question-1",
    question: "Which irreversible compatibility target is authorized?",
    reason_code: CONVERSATION_COORDINATION_ESCALATION_REASON.IRREVERSIBLE_SCOPE_CHOICE,
    resolution_attempts: CONVERSATION_COORDINATION_RESOLUTION_SOURCES.map((source) => ({
      source,
      outcome: `${source} cannot safely authorize the irreversible target`,
      source_refs:
        source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.TASK_SPEC
          ? ["message-1"]
          : source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.CONVERSATION_CONTEXT
            ? ["executor-response-1"]
            : source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.REPO_EVIDENCE
              ? ["src/orchestrator/conversation/coordinate-policy.ts"]
              : [],
    })),
    impact: "The wrong choice would break stored sessions.",
    options: ["Preserve legacy sessions", "Migrate all sessions"],
  },
});
const claudeEnvelope = (directive: unknown): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "claude-session-1",
    result: JSON.stringify(directive),
  });
const codexEnvelope = (directive: unknown): string =>
  [
    JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "reasoning-1", type: "reasoning", text: JSON.stringify(finalization()) },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "message-1", type: "agent_message", text: JSON.stringify(directive) },
    }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n");

interface Harness {
  context: ConversationContext;
  requests: PolicyAttemptRequest[];
  coordinatorEmissions: CoordinatorEmission[];
  attemptEmissions: Array<{ participant_id: string; emission: unknown }>;
  artifacts: StoredConversationCoordinationRecordV1[];
  settlements: string[];
  verificationCalls: string[];
  coordinationStateReads(): number;
}

function policyBinding(
  roleName: string,
  engine: typeof AGENT_ENGINE.CLAUDE | typeof AGENT_ENGINE.CODEX | typeof AGENT_ENGINE.COPILOT,
  sandbox: typeof ROLE_SANDBOX.READ_ONLY | typeof ROLE_SANDBOX.WORKSPACE_WRITE,
  source: (typeof AGENT_ROLE_SOURCE)[keyof typeof AGENT_ROLE_SOURCE] = AGENT_ROLE_SOURCE.BUILTIN,
): ResolvedAgentBinding {
  const tools =
    sandbox === ROLE_SANDBOX.READ_ONLY
      ? [ROLE_TOOL_INTENT.READ, ROLE_TOOL_INTENT.GREP]
      : [ROLE_TOOL_INTENT.READ, ROLE_TOOL_INTENT.WRITE];
  return {
    role: {
      spec: {
        name: roleName,
        description: "Policy authority fixture",
        body: "Policy authority fixture",
        tools,
        model: ROLE_MODEL.SONNET,
        sandbox,
      },
      source,
      resolved_hash: `role-hash:${roleName}`,
      metadata: {},
    },
    engine,
    model: null,
    sandbox,
    tool_intents: tools,
  } as unknown as ResolvedAgentBinding;
}

const canonicalPolicyBindings = (): ResolvedAgentBinding[] => [
  policyBinding(
    CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR,
    AGENT_ENGINE.CLAUDE,
    ROLE_SANDBOX.READ_ONLY,
  ),
  policyBinding(
    CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
    AGENT_ENGINE.CODEX,
    ROLE_SANDBOX.WORKSPACE_WRITE,
  ),
];

function harness(input: {
  outputs: unknown[];
  authenticatedOutputs?: Array<unknown | null>;
  revision_id?: string;
  state?: ConversationCoordinationStateV1;
  workspaceReady?: boolean;
  workspaceVerificationReady?: boolean;
  policy?: string;
  bindings?: readonly ResolvedAgentBinding[];
  participantIds?: readonly string[];
  userMessageIds?: readonly string[];
  applicableUserMessageIds?: readonly string[];
  durableStateRecovery?: boolean;
  coordinationCommitFailures?: number;
}): Harness {
  const requests: PolicyAttemptRequest[] = [];
  const coordinatorEmissions: CoordinatorEmission[] = [];
  const attemptEmissions: Array<{ participant_id: string; emission: unknown }> = [];
  const artifacts: StoredConversationCoordinationRecordV1[] = [];
  const settlements: string[] = [];
  const verificationCalls: string[] = [];
  const outputs = [...input.outputs];
  const authenticatedOutputs = input.authenticatedOutputs
    ? [...input.authenticatedOutputs]
    : undefined;
  const initial = input.state ?? emptyConversationCoordinationState();
  const workspaceHead = VERIFIED_HEAD;
  let attestedHead: string | null = null;
  let artifactOrdinal = initial.committed_records.length + initial.pending_records.length;
  let coordinationStateReads = 0;
  let remainingCoordinationCommitFailures = input.coordinationCommitFailures ?? 0;
  const authorityBindings = [...(input.bindings ?? canonicalPolicyBindings())];
  const userMessageIds = [...(input.userMessageIds ?? ["message-1"])];
  const applicableUserMessageIds = [...(input.applicableUserMessageIds ?? userMessageIds)];
  const correlation = {
    workflow_id: "workflow-1",
    conversation_id: "conversation-1",
    revision_id: input.revision_id ?? "revision-1",
    run_id: "run-1",
    turn_id: "turn-1",
    operation_id: `operation-${input.revision_id ?? "revision-1"}`,
    attempt_id: "coordinator",
  };
  const recoveredCoordinationState = (): ConversationCoordinationStateV1 => {
    const committedRefs = new Set([
      ...initial.committed_records.map(({ artifact_ref: artifactRef }) => artifactRef),
      ...coordinatorEmissions.flatMap(({ event }) =>
        event.type === CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION &&
        event.payload.tool === CONVERSATION_COORDINATION_TOOL &&
        event.payload.status === CONVERSATION_TOOL_ACTION_STATUS.COMPLETED &&
        event.payload.output_ref !== null
          ? [event.payload.output_ref]
          : [],
      ),
    ]);
    const candidates = [
      ...new Map(
        [...initial.committed_records, ...initial.pending_records, ...artifacts].map((stored) => [
          stored.artifact_ref,
          stored,
        ]),
      ).values(),
    ].sort((left, right) => left.record.step - right.record.step);
    return foldConversationCoordinationRecords(
      candidates.filter(({ artifact_ref: artifactRef }) => committedRefs.has(artifactRef)),
      candidates.filter(({ artifact_ref: artifactRef }) => !committedRefs.has(artifactRef)),
    );
  };
  const context = {
    correlation,
    topic: "Implement direct agent coordination",
    policy: input.policy ?? CONVERSATION_POLICY.COORDINATE,
    maxRounds: 8,
    baselineEnabled: false,
    evaluatorAutoAdded: false,
    bindings: authorityBindings,
    participantIds: [...(input.participantIds ?? ["coordinator-1", "executor-1"])],
    bindingReadiness: authorityBindings.map(() => ({
      engine_available: true,
      model_valid: true,
    })),
    signal: new AbortController().signal,
    messages: async () => [],
    validateCoordinationRepoEvidence: () => true,
    coordinationState: async () => {
      coordinationStateReads += 1;
      return input.durableStateRecovery ? recoveredCoordinationState() : initial;
    },
    observeWorkspace: (workspaceKey: string) => ({
      workspace_key: workspaceKey,
      branch_ref: input.workspaceReady === false ? null : "refs/heads/coordination",
      head: input.workspaceReady === false ? null : workspaceHead,
      verified_head: attestedHead,
      dirty: input.workspaceReady === false,
      quiescent: input.workspaceReady !== false,
      evidence_refs: input.workspaceReady === false ? [] : ["workspace:clean"],
    }),
    verifyWorkspace: async (workspaceKey: string) => {
      verificationCalls.push(workspaceKey);
      attestedHead =
        input.workspaceReady === false
          ? null
          : input.workspaceVerificationReady === false
            ? "fedcba9876543210"
            : workspaceHead;
      return {
        workspace_key: workspaceKey,
        branch_ref: input.workspaceReady === false ? null : "refs/heads/coordination",
        head: input.workspaceReady === false ? null : workspaceHead,
        verified_head: attestedHead,
        dirty: input.workspaceReady === false,
        quiescent: input.workspaceReady !== false,
        evidence_refs: input.workspaceReady === false ? [] : ["workspace:clean"],
      };
    },
    settleWorkspace: async (_workspaceKey: string, outcome: string) => {
      settlements.push(outcome);
    },
    prepareTurn: async ({ participant_id, instruction }: never) =>
      ({
        prompt_input: `VF-TURN/1\n${JSON.stringify({ participant_id, instruction })}`,
        envelope: {
          instruction,
          user_messages: userMessageIds.map((message_id) => ({
            message_id,
          })),
          public_responses: [{ message_id: "executor-response-1" }],
          recipient_history: { entries: [] },
          quoted_messages: [],
        },
        applicable_user_message_count: applicableUserMessageIds.length,
        applicable_user_message_ids: applicableUserMessageIds,
      }) as never,
    publishSocialIntent: () => ({ accepted: false, diagnostic_code: "not_used" }),
    stageActionCandidate: () => ({ accepted: false, diagnostic_code: "not_used" }),
    emit: async (emission: CoordinatorEmission) => {
      if (
        remainingCoordinationCommitFailures > 0 &&
        emission.event.type === CONVERSATION_TRACE_EVENT_KIND.TOOL_ACTION &&
        emission.event.payload.tool === CONVERSATION_COORDINATION_TOOL
      ) {
        remainingCoordinationCommitFailures -= 1;
        throw new Error("injected coordination commit failure");
      }
      coordinatorEmissions.push(emission);
      return { event_id: `event-${coordinatorEmissions.length}`, event: emission.event } as never;
    },
    launchAttempt: (request: PolicyAttemptRequest) => {
      requests.push(request);
      const output = outputs.shift();
      const publicOutput = typeof output === "string" ? output : JSON.stringify(output);
      const authenticatedOutput = authenticatedOutputs?.shift();
      const privateSource = authenticatedOutputs
        ? authenticatedOutput === null
          ? undefined
          : typeof authenticatedOutput === "string"
            ? authenticatedOutput
            : JSON.stringify(authenticatedOutput)
        : publicOutput;
      const engine = authorityBindings[request.bindingIndex]?.engine ?? AGENT_ENGINE.CLAUDE;
      return {
        ref: `attempt-${requests.length}` as never,
        completion: Promise.resolve({
          ok: true,
          state: "completed",
          output: publicOutput,
        } as never),
        readModelOutputBinding: () =>
          privateSource === undefined
            ? undefined
            : {
                attemptId: `attempt-${requests.length}`,
                engine,
                nativeSessionId: `${engine}-session`,
                output: extractEngineResponseText(privateSource, engine),
              },
        emit: async (emission: unknown) => {
          attemptEmissions.push({ participant_id: request.participantId, emission });
          return { event_id: `attempt-event-${attemptEmissions.length}` } as never;
        },
        onChunk: () => () => {},
      };
    },
    createArtifact: async (request: ArtifactCreateRequest) => {
      artifactOrdinal += 1;
      const artifactRef = `artifact-${artifactOrdinal}` as ConversationArtifactRef;
      const source =
        typeof request.content === "string"
          ? request.content
          : Buffer.from(request.content).toString("utf8");
      artifacts.push({
        artifact_ref: artifactRef,
        record: JSON.parse(source) as ConversationCoordinationRecordV1,
      });
      return { artifact_id: `artifact-id-${artifactOrdinal}`, ref: artifactRef };
    },
    updateArtifact: async () => {
      throw new Error("coordination records are immutable");
    },
  } as unknown as ConversationContext;
  return {
    context,
    requests,
    coordinatorEmissions,
    attemptEmissions,
    artifacts,
    settlements,
    verificationCalls,
    coordinationStateReads: () => coordinationStateReads,
  };
}

describe("coordinate conversation policy", () => {
  test("direct fails closed instead of delegating a mismatched multi-participant manifest", async () => {
    const run = harness({ outputs: [] });
    await expect(new DirectConversationPolicy().execute(run.context)).resolves.toEqual({
      operation_id: "operation-revision-1",
      status: "failed",
      artifact_refs: [],
    });
    await expect(new DirectConversationPolicy().dryRun(run.context)).resolves.toEqual({
      participants: [],
      evaluator_auto_added: false,
      engines_available: [],
      models_valid: false,
    });
  });

  test.each([
    {
      label: "same-engine executor",
      bindings: () => [
        canonicalPolicyBindings()[0] as ResolvedAgentBinding,
        policyBinding(
          CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
          AGENT_ENGINE.CLAUDE,
          ROLE_SANDBOX.WORKSPACE_WRITE,
        ),
      ],
    },
    {
      label: "writable coordinator",
      bindings: () => [
        policyBinding(
          CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR,
          AGENT_ENGINE.CLAUDE,
          ROLE_SANDBOX.WORKSPACE_WRITE,
        ),
        canonicalPolicyBindings()[1] as ResolvedAgentBinding,
      ],
    },
    {
      label: "read-only executor",
      bindings: () => [
        canonicalPolicyBindings()[0] as ResolvedAgentBinding,
        policyBinding(CONVERSATION_ROLE_NAME.DIRECT, AGENT_ENGINE.CODEX, ROLE_SANDBOX.READ_ONLY),
      ],
    },
    {
      label: "unauthenticated-output executor",
      bindings: () => [
        canonicalPolicyBindings()[0] as ResolvedAgentBinding,
        policyBinding(
          CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
          AGENT_ENGINE.COPILOT,
          ROLE_SANDBOX.WORKSPACE_WRITE,
        ),
      ],
    },
  ])("refuses $label before reading state or launching an attempt", async ({ bindings }) => {
    const run = harness({ outputs: [], bindings: bindings() });
    await expect(new CoordinateConversationPolicy().dryRun(run.context)).resolves.toEqual({
      participants: [],
      evaluator_auto_added: false,
      engines_available: [],
      models_valid: false,
    });
    await expect(new CoordinateConversationPolicy().execute(run.context)).resolves.toMatchObject({
      status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
      artifact_refs: [],
    });
    expect(run.coordinationStateReads()).toBe(0);
    expect(run.requests).toEqual([]);
    expect(run.artifacts).toEqual([]);
    expect(run.coordinatorEmissions).toEqual([]);
  });

  test("routes executor clarification to coordinator, resumes executor, and completes only when clean", async () => {
    const run = harness({
      outputs: [delegate(), clarification(), resolution(), completion(), finalization()],
    });
    const result = await new CoordinateConversationPolicy().execute(run.context);
    expect(result.status).toBe("completed");
    expect(run.requests.map(({ participantId }) => participantId)).toEqual([
      "coordinator-1",
      "executor-1",
      "coordinator-1",
      "executor-1",
      "coordinator-1",
    ]);
    expect(
      run.requests
        .filter(({ participantId }) => participantId === "executor-1")
        .map((request) => request.coordinationWorkspace?.workspace_key),
    ).toEqual([workspaceKey(), workspaceKey()]);
    expect(run.requests[0]?.coordinationWorkspace).toBeUndefined();
    expect(run.requests[2]?.coordinationWorkspace).toBeUndefined();
    expect(run.requests[4]?.coordinationWorkspace).toMatchObject({
      access: ENGINE_COORDINATION_WORKSPACE_ACCESS.REVIEW,
      workspace_key: workspaceKey(),
    });
    expect(run.requests[1]?.coordinationWorkspace).toMatchObject({
      access: ENGINE_COORDINATION_WORKSPACE_ACCESS.EXECUTOR,
      workspace_key: workspaceKey(),
      task: { task_id: task.task_id, scope: task.scope },
    });
    expect(run.settlements).toEqual([CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED]);
    expect(run.verificationCalls).toEqual([workspaceKey()]);
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      "delegate_task",
      "request_coordinator_clarification",
      "resolve_clarification",
      "complete_delegated_task",
      "finalize_coordination",
    ]);
    expect(result.artifact_refs).toEqual([
      "artifact-1",
      "artifact-2",
      "artifact-3",
      "artifact-4",
      "artifact-5",
    ]);
  });

  test("cold-reconciles a created directive after its first commit fails before terminalizing", async () => {
    const run = harness({
      outputs: [delegate()],
      durableStateRecovery: true,
      coordinationCommitFailures: 1,
    });

    await expect(new CoordinateConversationPolicy().execute(run.context)).resolves.toMatchObject({
      status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
      artifact_refs: ["artifact-1", "artifact-2"],
    });
    const durable = await run.context.coordinationState();
    expect(durable.pending_records).toEqual([]);
    expect(durable.phase).toBe(CONVERSATION_COORDINATION_PHASE.TERMINATED);
    expect(
      durable.committed_records.map(({ artifact_ref: artifactRef, record }) => ({
        artifact_ref: artifactRef,
        step: record.step,
        previous_ref: record.previous_ref,
        kind: record.directive.kind,
      })),
    ).toEqual([
      {
        artifact_ref: "artifact-1",
        step: 1,
        previous_ref: null,
        kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
      },
      {
        artifact_ref: "artifact-2",
        step: 2,
        previous_ref: "artifact-1",
        kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH,
      },
    ]);
  });

  test("runtime recovery fails closed when durable state cannot be read", async () => {
    const run = harness({ outputs: [] });
    const context = {
      ...run.context,
      coordinationState: async () => {
        throw new Error("durable coordination state unavailable");
      },
    } as ConversationContext;

    await expect(recoverCoordinationPolicyFailure(context)).resolves.toEqual({
      operation_id: "operation-revision-1",
      status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
      artifact_refs: [],
    });
  });

  test("runtime recovery settles a still-uncommittable record without creating a second step", async () => {
    for (const aborted of [false, true]) {
      const controller = new AbortController();
      if (aborted) controller.abort();
      const run = harness({
        state: foldConversationCoordinationRecords([], [pendingDelegateRecord()]),
        outputs: [],
        coordinationCommitFailures: 1,
      });
      const context = { ...run.context, signal: controller.signal } as ConversationContext;

      await expect(recoverCoordinationPolicyFailure(context)).resolves.toMatchObject({
        status: aborted
          ? CONVERSATION_COMMAND_RESULT_STATUS.ABORTED
          : CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
        artifact_refs: [],
      });
      expect(run.artifacts).toEqual([]);
      expect(run.settlements).toEqual([CONVERSATION_COORDINATION_SETTLEMENT.FAILED]);
    }
  });

  test("workspace settlement preserves completion failures but contains failed-settlement errors", async () => {
    const run = harness({ outputs: [] });
    const state = emptyConversationCoordinationState();
    const context = {
      ...run.context,
      settleWorkspace: async () => {
        throw new Error("injected settlement failure");
      },
    } as ConversationContext;

    await expect(
      settleCoordinationWorkspace(context, state, CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED),
    ).rejects.toThrow("workspace settlement failed");
    await expect(
      settleCoordinationWorkspace(context, state, CONVERSATION_COORDINATION_SETTLEMENT.FAILED),
    ).resolves.toBeUndefined();
  });

  test("parses only model-authored directives from Claude and Codex transport envelopes", async () => {
    const run = harness({
      outputs: [
        claudeEnvelope(delegate()),
        codexEnvelope(completion()),
        claudeEnvelope(finalization()),
      ],
    });
    const result = await new CoordinateConversationPolicy().execute(run.context);
    expect(result.status).toBe("completed");
    expect(run.requests.map(({ participantId }) => participantId)).toEqual([
      "coordinator-1",
      "executor-1",
      "coordinator-1",
    ]);
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      "delegate_task",
      "complete_delegated_task",
      "finalize_coordination",
    ]);
    expect(run.verificationCalls).toEqual([workspaceKey()]);
  });

  test("uses only authenticated private output and fails closed when that channel is absent", async () => {
    const privateRun = harness({
      outputs: ["public output was redacted and is not JSON", "still public", "still public"],
      authenticatedOutputs: [delegate(), completion(), finalization()],
    });
    await expect(
      new CoordinateConversationPolicy().execute(privateRun.context),
    ).resolves.toMatchObject({ status: "completed" });

    const missing = harness({
      outputs: [JSON.stringify(delegate())],
      authenticatedOutputs: [null],
    });
    await expect(
      new CoordinateConversationPolicy().execute(missing.context),
    ).resolves.toMatchObject({ status: "failed" });
    expect(
      missing.attemptEmissions.some(({ emission }) =>
        JSON.stringify(emission).includes("coordination_authenticated_output_unavailable"),
      ),
    ).toBe(true);
  });

  test("terminates at needs_input and a child revision resumes the exact pending question", async () => {
    const parent = harness({ outputs: [delegate(), clarification(), escalation()] });
    const parentResult = await new CoordinateConversationPolicy().execute(parent.context);
    expect(parentResult.status).toBe("needs_input");
    expect(parent.settlements).toEqual([CONVERSATION_COORDINATION_SETTLEMENT.NEEDS_INPUT]);
    const parentState = foldConversationCoordinationRecords(parent.artifacts);

    const child = harness({
      revision_id: "revision-2",
      state: parentState,
      outputs: [resolution(), completion(), finalization()],
    });
    const childResult = await new CoordinateConversationPolicy().execute(child.context);
    expect(childResult.status).toBe("completed");
    expect(childResult.artifact_refs).toEqual(["artifact-4", "artifact-5", "artifact-6"]);
    expect(child.requests.map(({ participantId }) => participantId)).toEqual([
      "coordinator-1",
      "executor-1",
      "coordinator-1",
    ]);
    expect(child.requests[0]?.delivery?.envelope.instruction).toMatchObject({
      kind: "coordinator-clarification",
      clarification: { question_id: "question-1" },
      user_escalation: { question_id: "question-1" },
    });
  });

  test("replans a recoverable blocker through one clean bounded redelegation", async () => {
    const run = harness({
      outputs: [
        delegate(),
        blocked(true),
        delegate(replacementTask),
        completion(replacementTask),
        finalization(VERIFIED_HEAD, [replacementTask.task_id]),
      ],
    });

    await expect(new CoordinateConversationPolicy().execute(run.context)).resolves.toMatchObject({
      status: CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED,
    });
    expect(run.requests.map(({ participantId }) => participantId)).toEqual([
      "coordinator-1",
      "executor-1",
      "coordinator-1",
      "executor-1",
      "coordinator-1",
    ]);
    expect(run.requests[2]?.delivery?.envelope.instruction).toMatchObject({
      kind: CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_REVIEW,
      blocked: { task_id: task.task_id, recoverable: true },
      user_escalation: null,
      allowed_directives: [CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK],
    });
    expect(run.requests[3]?.coordinationWorkspace).toMatchObject({
      access: ENGINE_COORDINATION_WORKSPACE_ACCESS.EXECUTOR,
      task: { task_id: replacementTask.task_id },
    });
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
    ]);
  });

  test("resumes an unrecoverable blocker only from the fresh decision in full history", async () => {
    const parent = harness({ outputs: [delegate(), blocked(false), escalation()] });
    await expect(new CoordinateConversationPolicy().execute(parent.context)).resolves.toMatchObject(
      {
        status: CONVERSATION_COMMAND_RESULT_STATUS.NEEDS_INPUT,
      },
    );
    expect(parent.requests[2]?.delivery?.envelope.instruction).toMatchObject({
      kind: CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_REVIEW,
      blocked: { task_id: task.task_id, recoverable: false },
      user_escalation: null,
      allowed_directives: [CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT],
    });
    const parentState = foldConversationCoordinationRecords(parent.artifacts);
    expect(parentState).toMatchObject({
      phase: CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT,
      task_count: 1,
      user_escalation_count: 1,
    });

    const userDecisionTask = {
      ...replacementTask,
      source_message_refs: ["user-decision-1"],
    };
    const child = harness({
      revision_id: "revision-2",
      state: parentState,
      userMessageIds: ["message-1", "user-decision-1"],
      applicableUserMessageIds: ["user-decision-1"],
      outputs: [
        delegate(userDecisionTask),
        completion(userDecisionTask),
        finalization(VERIFIED_HEAD, [userDecisionTask.task_id]),
      ],
    });
    await expect(new CoordinateConversationPolicy().execute(child.context)).resolves.toMatchObject({
      status: CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED,
      artifact_refs: ["artifact-4", "artifact-5", "artifact-6"],
    });
    expect(child.requests[0]?.delivery?.envelope.instruction).toMatchObject({
      kind: CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_REVIEW,
      blocked: { recoverable: false },
      user_escalation: { question_id: "question-1" },
      allowed_directives: [CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK],
    });
    expect(
      child.requests[0]?.delivery?.envelope.user_messages.map((message) => message.message_id),
    ).toEqual(["message-1", "user-decision-1"]);
    expect(child.requests[0]?.delivery?.applicable_user_message_ids).toEqual(["user-decision-1"]);
    expect(child.requests[1]?.coordinationWorkspace).toMatchObject({
      access: ENGINE_COORDINATION_WORKSPACE_ACCESS.EXECUTOR,
      task: { task_id: userDecisionTask.task_id },
    });
  });

  test("terminally rejects fabricated redelegation for an unrecoverable blocker", async () => {
    const fabricated = delegate(replacementTask);
    const run = harness({ outputs: [delegate(), blocked(false), fabricated, fabricated] });

    await expect(new CoordinateConversationPolicy().execute(run.context)).resolves.toMatchObject({
      status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
    });
    expect(run.requests).toHaveLength(4);
    expect(run.requests[2]?.delivery?.envelope.instruction).toMatchObject({
      allowed_directives: [CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT],
    });
    expect(run.requests[3]?.delivery?.envelope.instruction).toMatchObject({
      correction: {
        correction_attempt: 1,
        diagnostic_code: CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC.UNEXPECTED_DIRECTIVE,
        allowed_directives: [CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT],
      },
    });
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH,
    ]);
    expect(foldConversationCoordinationRecords(run.artifacts)).toMatchObject({
      phase: CONVERSATION_COORDINATION_PHASE.TERMINATED,
      task_count: 1,
    });
    expect(run.settlements).toEqual([CONVERSATION_COORDINATION_SETTLEMENT.FAILED]);
  });

  test("rejects an old-only task citation when full history also contains a fresh decision", async () => {
    const parent = harness({ outputs: [delegate(), blocked(false), escalation()] });
    await new CoordinateConversationPolicy().execute(parent.context);
    const parentState = foldConversationCoordinationRecords(parent.artifacts);
    const unboundDecisionTask = {
      ...replacementTask,
      source_message_refs: ["message-1"],
    };
    const child = harness({
      revision_id: "revision-2",
      state: parentState,
      userMessageIds: ["message-1", "user-decision-1"],
      applicableUserMessageIds: ["user-decision-1"],
      outputs: [delegate(unboundDecisionTask), delegate(unboundDecisionTask)],
    });

    await expect(new CoordinateConversationPolicy().execute(child.context)).resolves.toMatchObject({
      status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
    });
    expect(child.requests[1]?.delivery?.envelope.instruction).toMatchObject({
      correction: {
        diagnostic_code: CONVERSATION_COORDINATION_DIAGNOSTIC.USER_DECISION_SOURCE_UNVERIFIED,
      },
    });
    expect(child.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH,
    ]);
  });

  test("allows one exact-session correction then fails closed on repeated malformed output", async () => {
    const run = harness({ outputs: ["not-json", "still-not-json"] });
    const result = await new CoordinateConversationPolicy().execute(run.context);
    expect(result.status).toBe("failed");
    expect(run.requests).toHaveLength(2);
    expect(run.requests[1]?.parent as string | undefined).toBe("attempt-1");
    expect(run.requests[1]?.delivery?.envelope.instruction).toMatchObject({
      kind: "coordinator-plan",
      correction: { correction_attempt: 1, diagnostic_code: "coordination_output_not_json_object" },
    });
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      "malformed_output",
      "terminate_epoch",
    ]);
    expect(run.settlements).toEqual([CONVERSATION_COORDINATION_SETTLEMENT.FAILED]);
  });

  test("corrects unsupported verification oracles before committing a delegated task", async () => {
    const unsupported = {
      schema_version: "1.0",
      kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
      task: { ...task, verify_oracles: ["bun run typecheck"] },
    };
    const run = harness({ outputs: [unsupported, delegate(), completion(), finalization()] });
    await expect(new CoordinateConversationPolicy().execute(run.context)).resolves.toMatchObject({
      status: "completed",
    });
    expect(run.requests[1]?.delivery?.envelope.instruction).toMatchObject({
      correction: {
        diagnostic_code: CONVERSATION_DELEGATION_TASK_DIAGNOSTIC.VERIFY_ORACLE_UNSUPPORTED,
      },
    });
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
    ]);
    expect(JSON.stringify(run.artifacts)).not.toContain("bun run typecheck");
  });

  test("corrects a noncanonical task scope before it can reach the workspace lease", async () => {
    const invalidScope = delegate({ ...task, scope: ["../outside"] });
    const run = harness({
      outputs: [invalidScope, delegate(), completion(), finalization()],
    });

    await expect(new CoordinateConversationPolicy().execute(run.context)).resolves.toMatchObject({
      status: CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED,
    });
    expect(run.requests[1]?.delivery?.envelope.instruction).toMatchObject({
      correction: {
        correction_attempt: 1,
        diagnostic_code: CONVERSATION_DELEGATION_TASK_DIAGNOSTIC.SCOPE_SELECTOR_INVALID,
      },
    });
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
    ]);
    expect(JSON.stringify(run.artifacts)).not.toContain("../outside");
  });

  test("rejects immediate user escalation when source references lack host authority", async () => {
    const forged = escalation();
    forged.escalation.resolution_attempts[1] = {
      source: "conversation-context",
      outcome: "claimed context lookup",
      source_refs: ["invented-message-id"],
    };
    const run = harness({ outputs: [delegate(), clarification(), forged, forged] });
    const result = await new CoordinateConversationPolicy().execute(run.context);
    expect(result.status).toBe("failed");
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      "delegate_task",
      "request_coordinator_clarification",
      "malformed_output",
      "terminate_epoch",
    ]);
    expect(run.requests[3]?.delivery?.envelope.instruction).toMatchObject({
      correction: { diagnostic_code: "coordination_escalation_source_unverified" },
    });
    expect(run.settlements).toEqual([CONVERSATION_COORDINATION_SETTLEMENT.FAILED]);
  });

  test("refuses a coordinator finalization when workspace state is dirty or ambiguous", async () => {
    const run = harness({
      outputs: [delegate(), completion(), finalization()],
      workspaceReady: false,
    });
    const result = await new CoordinateConversationPolicy().execute(run.context);
    expect(result.status).toBe("failed");
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      "delegate_task",
      "malformed_output",
      "terminate_epoch",
    ]);
    expect(run.requests[2]?.delivery?.envelope.instruction).toMatchObject({
      kind: "executor-task",
      correction: {
        diagnostic_code: "coordination_workspace_requires_clean_commit",
      },
    });
    expect(run.settlements).toEqual([CONVERSATION_COORDINATION_SETTLEMENT.FAILED]);
    expect(run.verificationCalls).toEqual([]);
  });

  test("fails closed when host verification does not attest the exact workspace head", async () => {
    const run = harness({
      outputs: [delegate(), completion(), completion()],
      workspaceVerificationReady: false,
    });
    const result = await new CoordinateConversationPolicy().execute(run.context);
    expect(result.status).toBe("failed");
    expect(run.verificationCalls).toEqual([workspaceKey(), workspaceKey()]);
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      "delegate_task",
      "malformed_output",
      "terminate_epoch",
    ]);
    expect(run.requests[2]?.delivery?.envelope.instruction).toMatchObject({
      kind: "executor-task",
      correction: {
        diagnostic_code: "coordination_workspace_verification_failed",
      },
    });
    expect(run.settlements).toEqual([CONVERSATION_COORDINATION_SETTLEMENT.FAILED]);
  });

  test("rejects coordinator review that names any head except the host-verified snapshot", async () => {
    const stale = "f".repeat(40);
    const run = harness({
      outputs: [delegate(), completion(), finalization(stale), finalization(stale)],
    });
    const result = await new CoordinateConversationPolicy().execute(run.context);
    expect(result.status).toBe("failed");
    expect(run.requests[2]?.coordinationWorkspace).toMatchObject({
      access: ENGINE_COORDINATION_WORKSPACE_ACCESS.REVIEW,
      workspace_key: workspaceKey(),
    });
    expect(run.requests[3]?.parent as string | undefined).toBe("attempt-3");
    expect(run.artifacts.map(({ record }) => record.directive.kind)).toEqual([
      "delegate_task",
      "complete_delegated_task",
      "malformed_output",
      "terminate_epoch",
    ]);
  });

  test("commits an orphan artifact before resuming the next missing transition", async () => {
    const pending = pendingDelegateRecord();
    const run = harness({
      state: foldConversationCoordinationRecords([], [pending]),
      outputs: [completion(), finalization()],
    });
    const execution = await new CoordinateConversationPolicy().execute(run.context);
    expect(execution.status).toBe("completed");
    expect(run.requests.map(({ participantId }) => participantId)).toEqual([
      "executor-1",
      "coordinator-1",
    ]);
    expect(run.coordinatorEmissions[0]).toMatchObject({
      event: {
        type: "tool_action",
        payload: { action: "delegate_task", output_ref: "artifact-1" },
      },
    });
    expect(run.artifacts.map(({ artifact_ref: artifactRef }) => artifactRef)).toEqual([
      "artifact-2",
      "artifact-3",
    ]);
  });
});
