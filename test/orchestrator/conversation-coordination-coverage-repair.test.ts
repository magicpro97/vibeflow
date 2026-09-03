import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import { AGENT_ENGINE } from "../../src/core/agent-contract.js";
import { CONVERSATION_ROLE_NAME } from "../../src/core/role-name-contract.js";
import { canonicalJsonBytes } from "../../src/durability/index.js";
import type { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import {
  CONVERSATION_COORDINATION_DIAGNOSTIC,
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_PHASE,
  CONVERSATION_COORDINATION_TERMINAL_OUTCOME,
  CONVERSATION_COORDINATION_TOOL,
  conversationCoordinationEpochId,
} from "../../src/orchestrator/conversation/conversation-coordination-contract.js";
import { validateConversationCoordinationRepoEvidence } from "../../src/orchestrator/conversation/conversation-coordination-evidence.js";
import { emptyConversationCoordinationState } from "../../src/orchestrator/conversation/conversation-coordination-fold.js";
import { appendConversationCoordinationRecord } from "../../src/orchestrator/conversation/conversation-coordination-journal.js";
import {
  CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC,
  parseConversationCoordinationOutput,
} from "../../src/orchestrator/conversation/conversation-coordination-output.js";
import {
  coordinationAwaitsUserInCurrentRevision,
  coordinationDryRun,
  planConversationCoordinationTurn,
  validateCoordinationDirectiveForTurn,
} from "../../src/orchestrator/conversation/conversation-coordination-policy-helpers.js";
import type {
  ConversationCoordinationDirectiveV1,
  ConversationCoordinationRecordV1,
  StoredConversationCoordinationRecordV1,
} from "../../src/orchestrator/conversation/conversation-coordination-records.js";
import { CONVERSATION_DELEGATION_VERIFY_ORACLE } from "../../src/orchestrator/conversation/conversation-delegation-workspace-contract.js";
import {
  previewAgentPolicyContext,
  previewPolicyContext,
} from "../../src/orchestrator/conversation/emission-authority.js";
import { applyConversationRevisionMutation } from "../../src/orchestrator/conversation/revision-action-manifest.js";
import { readRuntimeConversationCoordinationState } from "../../src/orchestrator/conversation/runtime-coordination-state.js";
import { createRuntimePolicyContext } from "../../src/orchestrator/conversation/runtime-policy-context.js";
import type {
  ConversationBinding,
  ConversationContext,
  ConversationManifest,
  PolicyAttempt,
} from "../../src/orchestrator/conversation/types.js";
import type { TraceStore } from "../../src/orchestrator/trace/store.js";

const roots: string[] = [];
const HEAD = "a".repeat(40);
const task = {
  task_id: "task-coverage",
  executor_participant_id: "executor-coverage",
  goal: "Exercise the coordinator authority boundary",
  scope: ["src/orchestrator/conversation/"],
  forbidden: ["src/security/"],
  must_haves: ["retain durable authority"],
  verify_oracles: [CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST],
  source_message_refs: ["message-user"],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function correlation(revisionId = "revision-coverage") {
  return {
    workflow_id: "workflow-coverage",
    conversation_id: "conversation-coverage",
    revision_id: revisionId,
    run_id: "run-coverage",
    turn_id: "turn-coverage",
    operation_id: "operation-coverage",
    attempt_id: "attempt-coverage",
  };
}

function minimalManifest(bindings: ConversationBinding[] = []): ConversationManifest {
  return {
    version: "1.0",
    conversation_id: "conversation-coverage",
    workflow_id: "workflow-coverage",
    revision_id: "revision-coverage",
    run_id: "run-coverage",
    parent_conversation_id: null,
    parent_revision_id: null,
    topic: "Coordinate coverage repair",
    policy: "coordinate",
    max_rounds: 4,
    baseline_enabled: false,
    evaluator_auto_added: false,
    repo_root: "/unused",
    phase: 3,
    task_text: "Coordinate coverage repair",
    bindings,
    created_at: "2026-08-28T00:00:00.000Z",
  };
}

describe("coordination authority coverage repair", () => {
  test("rejects a missing evidence root", () => {
    const missing = join(tmpdir(), `vf-missing-evidence-${crypto.randomUUID()}`);
    expect(validateConversationCoordinationRepoEvidence(missing, ["README.md"])).toBeFalse();
  });

  test("publishes the host termination summary and rejects parsed JSON primitives", async () => {
    const attemptEvents: unknown[] = [];
    const committed: unknown[] = [];
    const context = {
      correlation: correlation(),
      participantIds: ["coordinator-coverage", "executor-coverage"],
      createArtifact: async () => ({ ref: "artifact-termination" }),
      emit: async (event: unknown) => {
        committed.push(event);
        return {};
      },
    } as unknown as ConversationContext;
    const attempt = {
      emit: async (event: unknown) => {
        attemptEvents.push(event);
        return {};
      },
    } as unknown as PolicyAttempt;
    const directive: ConversationCoordinationDirectiveV1 = {
      schema_version: "1.0",
      kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH,
      termination: {
        outcome: CONVERSATION_COORDINATION_TERMINAL_OUTCOME.FAILED,
        reason_code: "coordination_attempt_failed",
      },
    };
    const state = await appendConversationCoordinationRecord({
      context,
      state: emptyConversationCoordinationState(),
      actor_participant_id: "host-authority",
      actor_lane: CONVERSATION_COORDINATION_LANE.HOST,
      directive,
      attempt,
    });
    expect(state.phase).toBe(CONVERSATION_COORDINATION_PHASE.TERMINATED);
    expect(attemptEvents).toMatchObject([
      {
        event: {
          payload: {
            content_delta: "Coordination stopped: coordination_attempt_failed",
            final_evidence: [],
          },
        },
      },
    ]);
    expect(committed).toHaveLength(1);
    expect(
      parseConversationCoordinationOutput("[]", CONVERSATION_COORDINATION_LANE.COORDINATOR, [
        CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
      ]),
    ).toEqual({
      ok: false,
      diagnostic_code: CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC.NOT_JSON_OBJECT,
    });
  });

  test("projects dry-run readiness and exercises review and verification fail-closed paths", async () => {
    const completedState = {
      ...emptyConversationCoordinationState(),
      phase: CONVERSATION_COORDINATION_PHASE.COMPLETED,
    };
    const baseContext = {
      correlation: correlation(),
      topic: "Coordinate coverage repair",
      participantIds: ["coordinator-coverage", "executor-coverage"],
      bindings: [
        {
          engine: AGENT_ENGINE.CLAUDE,
          model: "claude-model",
          role: { spec: { name: CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR } },
        },
        {
          engine: AGENT_ENGINE.CODEX,
          model: "codex-model",
          role: { spec: { name: CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR } },
        },
        {
          engine: AGENT_ENGINE.CODEX,
          model: "unbound-preview",
          role: { spec: { name: "doc-writer" } },
        },
      ],
      bindingReadiness: [
        { engine_available: true, model_valid: true },
        { engine_available: false, model_valid: false },
        { engine_available: false, model_valid: true },
      ],
      evaluatorAutoAdded: false,
    } as unknown as ConversationContext;
    expect(coordinationDryRun(baseContext)).toMatchObject({
      participants: [
        { participant_id: "coordinator-coverage", engine_available: true },
        { participant_id: "executor-coverage", engine_available: false },
      ],
      engines_available: [AGENT_ENGINE.CLAUDE],
      models_valid: false,
    });
    expect(planConversationCoordinationTurn(baseContext, completedState)).toBeNull();

    const completion: ConversationCoordinationDirectiveV1 = {
      schema_version: "1.0",
      kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
      completion: {
        task_id: task.task_id,
        summary: "Finished the delegated task.",
        changed_paths: ["src/orchestrator/conversation/example.ts"],
        evidence_refs: ["test:coverage"],
        verification: {
          commands: [CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST],
          passed: true,
        },
      },
    };
    const runningState = {
      ...emptyConversationCoordinationState(),
      phase: CONVERSATION_COORDINATION_PHASE.EXECUTOR_RUNNING,
      active_task: task,
    };
    const plan = {
      participant_id: "executor-coverage",
      binding_index: 1,
      lane: CONVERSATION_COORDINATION_LANE.EXECUTOR,
      allowed_kinds: [CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK],
      instruction: { kind: "executor-task", task },
    } as const;
    const throwingObservation = {
      ...baseContext,
      observeWorkspace: () => {
        throw new Error("workspace unavailable");
      },
    } as unknown as ConversationContext;
    expect(
      await validateCoordinationDirectiveForTurn(
        throwingObservation,
        runningState,
        plan,
        completion,
        {} as never,
      ),
    ).toBe(CONVERSATION_COORDINATION_DIAGNOSTIC.WORKSPACE_REQUIRES_CLEAN_COMMIT);
    const throwingVerification = {
      ...baseContext,
      observeWorkspace: (workspaceKey: string) => ({
        workspace_key: workspaceKey,
        branch_ref: "refs/heads/vf/coordinate/example",
        head: HEAD,
        verified_head: null,
        dirty: false,
        quiescent: true,
        evidence_refs: [],
      }),
      verifyWorkspace: async () => {
        throw new Error("verification unavailable");
      },
    } as unknown as ConversationContext;
    const workspaceState = {
      ...runningState,
      epoch_id: conversationCoordinationEpochId(correlation()),
    };
    expect(
      await validateCoordinationDirectiveForTurn(
        throwingVerification,
        workspaceState,
        plan,
        completion,
        {} as never,
      ),
    ).toBe(CONVERSATION_COORDINATION_DIAGNOSTIC.WORKSPACE_VERIFICATION_FAILED);
  });

  test("finds the current-revision user escalation and exposes read-only preview observations", async () => {
    const escalationRecord = {
      artifact_ref: "artifact-escalation",
      record: {
        revision_id: "revision-coverage",
        directive: {
          kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT,
        },
      },
    } as StoredConversationCoordinationRecordV1;
    const needsInput = {
      ...emptyConversationCoordinationState(),
      phase: CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT,
      committed_records: [escalationRecord],
    };
    const context = {
      correlation: correlation(),
    } as unknown as ConversationContext;
    expect(coordinationAwaitsUserInCurrentRevision(context, needsInput)).toBeTrue();
    expect(
      coordinationAwaitsUserInCurrentRevision(context, {
        ...needsInput,
        committed_records: [],
      }),
    ).toBeFalse();

    const manifest = minimalManifest();
    const agentPreview = previewAgentPolicyContext(manifest, [], correlation());
    const policyPreview = previewPolicyContext(manifest, [], correlation());
    for (const preview of [agentPreview, policyPreview]) {
      expect(preview.observeWorkspace("workspace")).toEqual({
        workspace_key: "dry-run",
        branch_ref: null,
        head: null,
        verified_head: null,
        dirty: false,
        quiescent: false,
        evidence_refs: [],
      });
      await expect(preview.verifyWorkspace("workspace", {} as never)).resolves.toEqual({
        workspace_key: "dry-run",
        branch_ref: null,
        head: null,
        verified_head: null,
        dirty: false,
        quiescent: false,
        evidence_refs: [],
      });
    }
  });

  test("runtime policy evidence delegates to the canonical in-repo validator", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-runtime-policy-evidence-"));
    roots.push(root);
    writeFileSync(join(root, "evidence.txt"), "authority\n");
    const manifest = { ...minimalManifest(), repo_root: root };
    const context = createRuntimePolicyContext({
      options: {} as never,
      live: { manifest, bindings: [] } as never,
      signal: new AbortController().signal,
      correlation: correlation(),
      writePolicy: (() => Promise.resolve({})) as never,
      launchAttempt: (() => {
        throw new Error("unused");
      }) as never,
      createArtifact: (() => Promise.resolve({})) as never,
      updateArtifact: (() => Promise.resolve({})) as never,
    });
    expect(context.validateCoordinationRepoEvidence(["evidence.txt#L1"])).toBeTrue();
  });

  test("a pending child directive starts one fresh epoch after its terminal parent", async () => {
    const parentEpoch = conversationCoordinationEpochId({
      ...correlation("revision-parent"),
      operation_id: "operation-parent",
    });
    const childEpoch = conversationCoordinationEpochId({
      ...correlation("revision-child"),
      operation_id: "operation-child",
    });
    const directives: ConversationCoordinationDirectiveV1[] = [
      {
        schema_version: "1.0",
        kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
        task,
      },
      {
        schema_version: "1.0",
        kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
        completion: {
          task_id: task.task_id,
          summary: "Completed.",
          changed_paths: ["src/example.ts"],
          evidence_refs: ["test:coverage"],
          verification: {
            commands: [CONVERSATION_DELEGATION_VERIFY_ORACLE.BUN_TEST],
            passed: true,
          },
        },
      },
      {
        schema_version: "1.0",
        kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
        finalization: {
          completed_task_ids: [task.task_id],
          reviewed_head: HEAD,
          summary: "Finalized.",
          evidence_refs: ["test:coverage"],
        },
      },
    ];
    const parentRecords = directives.map(
      (directive, index): ConversationCoordinationRecordV1 => ({
        schema_version: "1.0",
        epoch_id: parentEpoch,
        record_id: `record-parent-${index + 1}`,
        operation_id: "operation-parent",
        revision_id: "revision-parent",
        step: index + 1,
        coordinator_participant_id: "coordinator-coverage",
        actor_participant_id:
          directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK
            ? "executor-coverage"
            : "coordinator-coverage",
        actor_lane:
          directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK
            ? CONVERSATION_COORDINATION_LANE.EXECUTOR
            : CONVERSATION_COORDINATION_LANE.COORDINATOR,
        previous_ref: index === 0 ? null : `artifact-parent-${index}`,
        directive,
      }),
    );
    const pending: ConversationCoordinationRecordV1 = {
      schema_version: "1.0",
      epoch_id: childEpoch,
      record_id: "record-child-1",
      operation_id: "operation-child",
      revision_id: "revision-child",
      step: 1,
      coordinator_participant_id: "coordinator-coverage",
      actor_participant_id: "coordinator-coverage",
      actor_lane: CONVERSATION_COORDINATION_LANE.COORDINATOR,
      previous_ref: null,
      directive: {
        schema_version: "1.0",
        kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
        task,
      },
    };
    const bytes = new Map<string, Uint8Array>([
      ...parentRecords.map(
        (record, index) => [`artifact-parent-${index + 1}`, canonicalJsonBytes(record)] as const,
      ),
      ["artifact-child-1", canonicalJsonBytes(pending)],
    ]);
    const artifactStore = {
      readRecord: (id: string) =>
        id === "parent"
          ? {
              manifest: {
                conversation_id: "parent",
                revision_id: "revision-parent",
                parent_conversation_id: null,
                parent_revision_id: null,
              },
              artifacts: parentRecords.map((_record, index) => ({
                artifact_type: "coordination",
                ref: `artifact-parent-${index + 1}`,
              })),
            }
          : id === "child"
            ? {
                manifest: {
                  conversation_id: "child",
                  revision_id: "revision-child",
                  parent_conversation_id: "parent",
                  parent_revision_id: "revision-parent",
                },
                artifacts: [{ artifact_type: "coordination", ref: "artifact-child-1" }],
              }
            : null,
      readArtifactRef: (_conversationId: string, ref: string) => bytes.get(ref) ?? null,
    } as unknown as ConversationArtifactStore;
    const committedEvent = (record: ConversationCoordinationRecordV1, index: number) => ({
      stored_event: {
        operation_id: record.operation_id,
        revision_id: record.revision_id,
        event: {
          type: "tool_action",
          payload: {
            tool: CONVERSATION_COORDINATION_TOOL,
            action: record.directive.kind,
            status: "completed",
            input_ref: record.previous_ref,
            output_ref: `artifact-parent-${index + 1}`,
          },
        },
      },
    });
    const traceStore = {
      readConversation: async (id: string) =>
        id === "parent" ? parentRecords.map(committedEvent) : [],
    } as unknown as TraceStore;
    const state = await readRuntimeConversationCoordinationState({
      artifactStore,
      traceStore,
      conversationId: "child",
      revisionId: "revision-child",
    });
    expect(state.phase).toBe(CONVERSATION_COORDINATION_PHASE.COORDINATOR_PLANNING);
    expect(state.committed_records).toHaveLength(0);
    expect(state.pending_records[0]?.record.record_id).toBe("record-child-1");
  });

  test("runtime replay rejects malformed coordination artifact bytes", async () => {
    const artifactStore = {
      readRecord: () => ({
        manifest: {
          conversation_id: "conversation-invalid",
          revision_id: "revision-invalid",
          parent_conversation_id: null,
          parent_revision_id: null,
        },
        artifacts: [{ artifact_type: "coordination", ref: "artifact-invalid" }],
      }),
      readArtifactRef: () => Buffer.from("not-json", "utf8"),
    } as unknown as ConversationArtifactStore;
    const traceStore = {
      readConversation: async () => [],
    } as unknown as TraceStore;
    await expect(
      readRuntimeConversationCoordinationState({
        artifactStore,
        traceStore,
        conversationId: "conversation-invalid",
        revisionId: "revision-invalid",
      }),
    ).rejects.toThrow("invalid coordination authority: artifact record");
  });

  test("adding an executor to coordinate topology renormalizes the full participant set", () => {
    const binding = (
      participantId: string,
      roleRef: string,
      engine: ConversationBinding["input"]["engine"],
    ): ConversationBinding => ({
      participant_id: participantId,
      host_tools: [],
      input: {
        roleRef,
        engine,
        sessionMode: "fresh",
        additionalSkillRefs: [],
      },
    });
    const parent = minimalManifest([
      binding(
        "coordinator-coverage",
        CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR,
        AGENT_ENGINE.CLAUDE,
      ),
      binding(
        "executor-coverage",
        CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
        AGENT_ENGINE.CODEX,
      ),
    ]);
    const result = applyConversationRevisionMutation({
      parent,
      action: {
        type: HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT,
        participant: {
          role_ref: "doc-writer",
          engine: AGENT_ENGINE.CODEX,
          model: null,
          skill_refs: [],
        },
      },
      idempotencyKey: "add-third-executor",
    });
    expect(result.policy).toBe("coordinate");
    expect(result.bindings).toHaveLength(3);
    expect(result.bindings.map(({ input }) => input.roleRef)).toEqual([
      CONVERSATION_ROLE_NAME.COORDINATION_COORDINATOR,
      CONVERSATION_ROLE_NAME.COORDINATION_EXECUTOR,
      "doc-writer",
    ]);
  });
});
