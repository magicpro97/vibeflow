import { expect, test } from "bun:test";
import { canonicalJsonBytes } from "../../src/durability/index.js";
import type { ConversationArtifactStore } from "../../src/orchestrator/conversation/artifact-store.js";
import {
  CONVERSATION_COORDINATION_RESOLUTION_SOURCES,
  CONVERSATION_COORDINATION_SCHEMA_VERSION,
  CONVERSATION_COORDINATION_TOOL,
  conversationCoordinationEpochId,
} from "../../src/orchestrator/conversation/conversation-coordination-contract.js";
import type {
  ConversationCoordinationDirectiveV1,
  ConversationCoordinationRecordV1,
} from "../../src/orchestrator/conversation/conversation-coordination-records.js";
import { readRuntimeConversationCoordinationState } from "../../src/orchestrator/conversation/runtime-coordination-state.js";
import type { TraceStore } from "../../src/orchestrator/trace/store.js";

const task = {
  task_id: "task-1",
  executor_participant_id: "executor-1",
  goal: "Implement the requested change",
  scope: ["src"],
  forbidden: [],
  must_haves: ["preserve context"],
  verify_oracles: ["tests pass"],
  source_message_refs: ["message-1"],
};
const parentEpochId = conversationCoordinationEpochId({
  workflow_id: "workflow-1",
  operation_id: "operation-parent",
  revision_id: "revision-parent",
});

const records: ConversationCoordinationRecordV1[] = [
  {
    schema_version: CONVERSATION_COORDINATION_SCHEMA_VERSION,
    epoch_id: parentEpochId,
    record_id: "record-1",
    operation_id: "operation-parent",
    revision_id: "revision-parent",
    step: 1,
    coordinator_participant_id: "coordinator-1",
    actor_participant_id: "coordinator-1",
    actor_lane: "coordinator",
    previous_ref: null,
    directive: { schema_version: "1.0", kind: "delegate_task", task },
  },
  {
    schema_version: CONVERSATION_COORDINATION_SCHEMA_VERSION,
    epoch_id: parentEpochId,
    record_id: "record-2",
    operation_id: "operation-parent",
    revision_id: "revision-parent",
    step: 2,
    coordinator_participant_id: "coordinator-1",
    actor_participant_id: "executor-1",
    actor_lane: "executor",
    previous_ref: "artifact-1",
    directive: {
      schema_version: "1.0",
      kind: "request_coordinator_clarification",
      clarification: {
        task_id: "task-1",
        question_id: "question-1",
        question: "Which compatibility target is required?",
        blocking_reason: "Two targets conflict.",
        attempted_interpretations: ["Preserve the current target"],
        required_decision: "Choose the target.",
      },
    },
  },
  {
    schema_version: CONVERSATION_COORDINATION_SCHEMA_VERSION,
    epoch_id: parentEpochId,
    record_id: "record-3",
    operation_id: "operation-parent",
    revision_id: "revision-parent",
    step: 3,
    coordinator_participant_id: "coordinator-1",
    actor_participant_id: "coordinator-1",
    actor_lane: "coordinator",
    previous_ref: "artifact-2",
    directive: {
      schema_version: "1.0",
      kind: "request_user_input",
      escalation: {
        task_id: "task-1",
        question_id: "question-1",
        question: "Which irreversible compatibility target is authorized?",
        reason_code: "irreversible-scope-choice",
        resolution_attempts: CONVERSATION_COORDINATION_RESOLUTION_SOURCES.map((source) => ({
          source,
          outcome: `${source} did not resolve the choice`,
          source_refs: source === "safe-default" ? [] : [`evidence:${source}`],
        })),
        impact: "The wrong choice breaks stored sessions.",
        options: ["Preserve", "Migrate"],
      },
    },
  },
  {
    schema_version: CONVERSATION_COORDINATION_SCHEMA_VERSION,
    epoch_id: parentEpochId,
    record_id: "record-4",
    operation_id: "operation-child",
    revision_id: "revision-child",
    step: 4,
    coordinator_participant_id: "coordinator-1",
    actor_participant_id: "coordinator-1",
    actor_lane: "coordinator",
    previous_ref: "artifact-3",
    directive: {
      schema_version: "1.0",
      kind: "resolve_clarification",
      resolution: {
        task_id: "task-1",
        question_id: "question-1",
        answer: "Preserve stored sessions.",
        source: "conversation-context",
        source_refs: ["message-child"],
        assumptions: [],
      },
    },
  },
];

function authorities(nonCanonical = false) {
  const bytes = new Map(
    records.map((record, index) => [
      `artifact-${index + 1}`,
      nonCanonical && index === 0
        ? Buffer.from(`${JSON.stringify(record)}\n`)
        : canonicalJsonBytes(record),
    ]),
  );
  const manifest = (id: "parent" | "child") => ({
    manifest: {
      conversation_id: id,
      revision_id: `revision-${id}`,
      parent_conversation_id: id === "child" ? "parent" : null,
      parent_revision_id: id === "child" ? "revision-parent" : null,
    },
    artifacts: (id === "parent" ? [0, 1, 2] : [3]).map((index) => ({
      artifact_type: "coordination",
      ref: `artifact-${index + 1}`,
    })),
  });
  const artifactStore = {
    readRecord: (id: string) => (id === "parent" || id === "child" ? manifest(id) : null),
    readArtifactRef: (_id: string, ref: string) => bytes.get(ref) ?? null,
  } as unknown as ConversationArtifactStore;
  const event = (record: ConversationCoordinationRecordV1, index: number) => ({
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
          output_ref: `artifact-${index + 1}`,
        },
      },
    },
  });
  const traceStore = {
    readConversation: async (id: string) => (id === "parent" ? records.slice(0, 3).map(event) : []),
  } as unknown as TraceStore;
  return { artifactStore, traceStore };
}

function terminalEpochAuthorities(
  childCommitted: boolean,
  terminalKind: "completed" | "failed" = "completed",
) {
  const childEpochId = conversationCoordinationEpochId({
    workflow_id: "workflow-1",
    operation_id: "operation-child",
    revision_id: "revision-child",
  });
  const directives: ConversationCoordinationDirectiveV1[] =
    terminalKind === "completed"
      ? [
          { schema_version: "1.0", kind: "delegate_task", task },
          {
            schema_version: "1.0",
            kind: "complete_delegated_task",
            completion: {
              task_id: task.task_id,
              summary: "Implemented and verified.",
              changed_paths: ["src/example.ts"],
              evidence_refs: ["test:example"],
              verification: { commands: ["bun test"], passed: true },
            },
          },
          {
            schema_version: "1.0",
            kind: "finalize_coordination",
            finalization: {
              completed_task_ids: [task.task_id],
              reviewed_head: "0".repeat(40),
              summary: "First epoch complete.",
              evidence_refs: ["test:example"],
            },
          },
        ]
      : [
          { schema_version: "1.0", kind: "delegate_task", task },
          {
            schema_version: "1.0",
            kind: "terminate_epoch",
            termination: { outcome: "failed", reason_code: "coordination_attempt_failed" },
          },
        ];
  const terminalRecords = directives.map(
    (directive, index): ConversationCoordinationRecordV1 => ({
      schema_version: "1.0",
      epoch_id: parentEpochId,
      record_id: `completed-record-${index + 1}`,
      operation_id: "operation-parent",
      revision_id: "revision-parent",
      step: index + 1,
      coordinator_participant_id: "coordinator-1",
      actor_participant_id:
        directive.kind === "complete_delegated_task" ? "executor-1" : "coordinator-1",
      actor_lane:
        directive.kind === "complete_delegated_task"
          ? "executor"
          : directive.kind === "terminate_epoch"
            ? "host"
            : "coordinator",
      previous_ref: index === 0 ? null : `completed-artifact-${index}`,
      directive,
    }),
  );
  const next: ConversationCoordinationRecordV1 = {
    schema_version: "1.0",
    epoch_id: childEpochId,
    record_id: "child-record-1",
    operation_id: "operation-child",
    revision_id: "revision-child",
    step: 1,
    coordinator_participant_id: "coordinator-1",
    actor_participant_id: "coordinator-1",
    actor_lane: "coordinator",
    previous_ref: null,
    directive: { schema_version: "1.0", kind: "delegate_task", task },
  };
  const bytes = new Map<string, Uint8Array>(
    terminalRecords.map((record, index) => [
      `completed-artifact-${index + 1}`,
      canonicalJsonBytes(record),
    ]),
  );
  if (childCommitted) bytes.set("child-artifact-1", canonicalJsonBytes(next));
  const manifest = (id: "parent" | "child") => ({
    manifest: {
      conversation_id: id,
      revision_id: `revision-${id}`,
      parent_conversation_id: id === "child" ? "parent" : null,
      parent_revision_id: id === "child" ? "revision-parent" : null,
    },
    artifacts:
      id === "parent"
        ? terminalRecords.map((_record, index) => ({
            artifact_type: "coordination",
            ref: `completed-artifact-${index + 1}`,
          }))
        : childCommitted
          ? [{ artifact_type: "coordination", ref: "child-artifact-1" }]
          : [],
  });
  const event = (record: ConversationCoordinationRecordV1, ref: string) => ({
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
          output_ref: ref,
        },
      },
    },
  });
  return {
    artifactStore: {
      readRecord: (id: string) => (id === "parent" || id === "child" ? manifest(id) : null),
      readArtifactRef: (_id: string, ref: string) => bytes.get(ref) ?? null,
    } as unknown as ConversationArtifactStore,
    traceStore: {
      readConversation: async (id: string) =>
        id === "parent"
          ? terminalRecords.map((record, index) => event(record, `completed-artifact-${index + 1}`))
          : childCommitted
            ? [event(next, "child-artifact-1")]
            : [],
    } as unknown as TraceStore,
    childEpochId,
  };
}

test("coordination replay follows parent revisions and retains one child pending record", async () => {
  const state = await readRuntimeConversationCoordinationState({
    ...authorities(),
    conversationId: "child",
    revisionId: "revision-child",
  });
  expect(state.phase).toBe("needs-input");
  expect(state.committed_records.map(({ record }) => record.record_id)).toEqual([
    "record-1",
    "record-2",
    "record-3",
  ]);
  expect(state.pending_records[0]?.record.record_id).toBe("record-4");
});

test("coordination replay rejects non-canonical authority artifacts", async () => {
  await expect(
    readRuntimeConversationCoordinationState({
      ...authorities(true),
      conversationId: "child",
      revisionId: "revision-child",
    }),
  ).rejects.toThrow("non-canonical artifact record");
});

test("a child after finalization starts a new epoch while replaying the terminal revision stays idempotent", async () => {
  const authority = terminalEpochAuthorities(false);
  const child = await readRuntimeConversationCoordinationState({
    ...authority,
    conversationId: "child",
    revisionId: "revision-child",
  });
  expect(child.phase).toBe("coordinator-planning");
  expect(child.epoch_id).toBeNull();
  expect(child.committed_records).toHaveLength(0);

  const parent = await readRuntimeConversationCoordinationState({
    ...authority,
    conversationId: "parent",
    revisionId: "revision-parent",
  });
  expect(parent.phase).toBe("completed");
  expect(parent.epoch_id).toBe(parentEpochId);
});

test("a committed child delegation owns a fresh epoch after a finalized ancestor", async () => {
  const authority = terminalEpochAuthorities(true);
  const state = await readRuntimeConversationCoordinationState({
    ...authority,
    conversationId: "child",
    revisionId: "revision-child",
  });
  expect(state.phase).toBe("executor-running");
  expect(state.epoch_id).toBe(authority.childEpochId);
  expect(state.committed_records.map(({ record }) => record.record_id)).toEqual(["child-record-1"]);
});

test("a failed parent remains auditable while its child starts a fresh epoch", async () => {
  const authority = terminalEpochAuthorities(false, "failed");
  const child = await readRuntimeConversationCoordinationState({
    ...authority,
    conversationId: "child",
    revisionId: "revision-child",
  });
  expect(child.phase).toBe("coordinator-planning");
  expect(child.epoch_id).toBeNull();

  const parent = await readRuntimeConversationCoordinationState({
    ...authority,
    conversationId: "parent",
    revisionId: "revision-parent",
  });
  expect(parent.phase).toBe("terminated");
  expect(parent.terminal_outcome).toBe("failed");
  expect(parent.committed_records).toHaveLength(2);
});
