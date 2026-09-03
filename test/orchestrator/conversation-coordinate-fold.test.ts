import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_ESCALATION_REASON,
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_PHASE,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCE,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCES,
  CONVERSATION_COORDINATION_TERMINAL_OUTCOME,
  conversationCoordinationEpochId,
} from "../../src/orchestrator/conversation/conversation-coordination-contract.js";
import { foldConversationCoordinationRecords } from "../../src/orchestrator/conversation/conversation-coordination-fold.js";
import type {
  ConversationCoordinationDirectiveV1,
  StoredConversationCoordinationRecordV1,
} from "../../src/orchestrator/conversation/conversation-coordination-records.js";

const coordinator = "coordinator-1";
const executor = "executor-1";
const epochId = conversationCoordinationEpochId({
  workflow_id: "workflow-1",
  operation_id: "operation-1",
  revision_id: "revision-1",
});
const task = {
  task_id: "task-1",
  executor_participant_id: executor,
  goal: "Implement direct coordination",
  scope: ["src/orchestrator/conversation"],
  forbidden: ["nested orchestration"],
  must_haves: ["durable state"],
  verify_oracles: ["focused tests pass"],
  source_message_refs: ["message-1"],
};
const replacementTask = {
  ...task,
  task_id: "task-2",
  goal: "Replan the blocked coordination task",
};
const delegate = (delegatedTask = task): ConversationCoordinationDirectiveV1 => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
  task: delegatedTask,
});
const clarify = (questionId = "question-1"): ConversationCoordinationDirectiveV1 => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION,
  clarification: {
    task_id: task.task_id,
    question_id: questionId,
    question: "Which existing contract is authoritative?",
    blocking_reason: "Two contracts conflict.",
    attempted_interpretations: ["Prefer the public wire contract"],
    required_decision: "Select the canonical contract.",
  },
});
const resolve = (): ConversationCoordinationDirectiveV1 => ({
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
const complete = (): ConversationCoordinationDirectiveV1 => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
  completion: {
    task_id: task.task_id,
    summary: "Implemented and verified direct coordination.",
    changed_paths: ["src/orchestrator/conversation/coordinate-policy.ts"],
    evidence_refs: ["test:conversation-coordinate-policy"],
    verification: { commands: ["bun test conversation-coordinate-policy"], passed: true },
  },
});
const blocked = (recoverable: boolean): ConversationCoordinationDirectiveV1 => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED,
  blocked: {
    task_id: task.task_id,
    reason: "The current task contract cannot be completed as written.",
    evidence_refs: ["evidence:blocker"],
    recoverable,
  },
});
const escalateBlocked = (): ConversationCoordinationDirectiveV1 => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT,
  escalation: {
    task_id: task.task_id,
    question_id: "blocked-decision-1",
    question: "Which authorized compatibility outcome should unblock the task?",
    reason_code: CONVERSATION_COORDINATION_ESCALATION_REASON.IRREVERSIBLE_SCOPE_CHOICE,
    resolution_attempts: CONVERSATION_COORDINATION_RESOLUTION_SOURCES.map((source) => ({
      source,
      outcome: `${source} cannot authorize the required decision`,
      source_refs:
        source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.SAFE_DEFAULT
          ? []
          : [
              source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.TASK_SPEC
                ? "message-1"
                : source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.CONVERSATION_CONTEXT
                  ? "response-1"
                  : "src/orchestrator/conversation/coordinate-policy.ts",
            ],
    })),
    impact: "Choosing the wrong outcome would make the change irreversible.",
    options: ["Preserve compatibility", "Authorize migration"],
  },
});
const finalize = (): ConversationCoordinationDirectiveV1 => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
  finalization: {
    completed_task_ids: [task.task_id],
    reviewed_head: "0".repeat(40),
    summary: "Coordination is complete.",
    evidence_refs: ["test:conversation-coordinate-policy"],
  },
});
const terminate = (): ConversationCoordinationDirectiveV1 => ({
  schema_version: "1.0",
  kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH,
  termination: {
    outcome: CONVERSATION_COORDINATION_TERMINAL_OUTCOME.FAILED,
    reason_code: "coordination_attempt_failed",
  },
});

function stored(
  directive: ConversationCoordinationDirectiveV1,
  records: readonly StoredConversationCoordinationRecordV1[],
): StoredConversationCoordinationRecordV1 {
  const step = records.length + 1;
  const actorLane = (() => {
    if (directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH)
      return CONVERSATION_COORDINATION_LANE.HOST;
    if (
      directive.kind ===
        CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION ||
      directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK ||
      directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED
    )
      return CONVERSATION_COORDINATION_LANE.EXECUTOR;
    return CONVERSATION_COORDINATION_LANE.COORDINATOR;
  })();
  return {
    artifact_ref: `artifact-${step}`,
    record: {
      schema_version: "1.0",
      epoch_id: epochId,
      record_id: `record-${step}`,
      operation_id: "operation-1",
      revision_id: "revision-1",
      step,
      coordinator_participant_id: coordinator,
      actor_participant_id:
        actorLane === CONVERSATION_COORDINATION_LANE.EXECUTOR ? executor : coordinator,
      actor_lane: actorLane,
      previous_ref: records.at(-1)?.artifact_ref ?? null,
      directive,
    },
  };
}

describe("conversation coordination fold", () => {
  test("folds delegate, clarification, resolution, completion, and finalization deterministically", () => {
    const records: StoredConversationCoordinationRecordV1[] = [];
    for (const directive of [delegate(), clarify(), resolve(), complete(), finalize()])
      records.push(stored(directive, records));
    const state = foldConversationCoordinationRecords(records);
    expect(state).toMatchObject({
      phase: CONVERSATION_COORDINATION_PHASE.COMPLETED,
      coordinator_participant_id: coordinator,
      completed_task_ids: [task.task_id],
      task_count: 1,
      clarification_count: 1,
      latest_artifact_ref: "artifact-5",
    });
    expect(state.committed_records).toHaveLength(5);
  });

  test("rejects concurrent delegation and repeated normalized clarification loops", () => {
    const delegated = [stored(delegate(), [])];
    expect(() =>
      foldConversationCoordinationRecords([...delegated, stored(delegate(), delegated)]),
    ).toThrow("task delegated while another task is active");

    const records: StoredConversationCoordinationRecordV1[] = [];
    for (const directive of [delegate(), clarify(), resolve(), clarify("question-2")])
      records.push(stored(directive, records));
    expect(() => foldConversationCoordinationRecords(records)).toThrow(
      "repeated clarification loop",
    );
  });

  test("validates but does not apply one artifact created before its TOOL_ACTION commit", () => {
    const pending = stored(delegate(), []);
    const state = foldConversationCoordinationRecords([], [pending]);
    expect(state.phase).toBe(CONVERSATION_COORDINATION_PHASE.COORDINATOR_PLANNING);
    expect(state.latest_artifact_ref).toBeNull();
    expect(state.pending_records).toEqual([pending]);
    expect(() => foldConversationCoordinationRecords([], [pending, pending])).toThrow(
      "multiple pending records",
    );
  });

  test("makes a host-terminated epoch immutable and preserves its terminal outcome", () => {
    const records: StoredConversationCoordinationRecordV1[] = [];
    for (const directive of [delegate(), terminate()]) records.push(stored(directive, records));

    const state = foldConversationCoordinationRecords(records);
    expect(state.phase).toBe(CONVERSATION_COORDINATION_PHASE.TERMINATED);
    expect(state.terminal_outcome).toBe(CONVERSATION_COORDINATION_TERMINAL_OUTCOME.FAILED);
    expect(() =>
      foldConversationCoordinationRecords([...records, stored(complete(), records)]),
    ).toThrow("task completion authority");
  });

  test("permits a bounded redelegation after a recoverable executor blocker", () => {
    const records: StoredConversationCoordinationRecordV1[] = [];
    for (const directive of [delegate(), blocked(true), delegate(replacementTask)])
      records.push(stored(directive, records));

    expect(foldConversationCoordinationRecords(records)).toMatchObject({
      phase: CONVERSATION_COORDINATION_PHASE.EXECUTOR_RUNNING,
      active_task: { task_id: replacementTask.task_id },
      last_blocked: null,
      task_count: 2,
    });
  });

  test("requires one user escalation before redelegating an unrecoverable blocker", () => {
    const records: StoredConversationCoordinationRecordV1[] = [];
    for (const directive of [delegate(), blocked(false)]) records.push(stored(directive, records));

    expect(() =>
      foldConversationCoordinationRecords([...records, stored(delegate(replacementTask), records)]),
    ).toThrow("task delegated while another task is active");

    records.push(stored(escalateBlocked(), records));
    expect(foldConversationCoordinationRecords(records)).toMatchObject({
      phase: CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT,
      last_blocked: { recoverable: false },
      last_escalation: { question_id: "blocked-decision-1" },
      task_count: 1,
    });

    records.push(stored(delegate(replacementTask), records));
    expect(foldConversationCoordinationRecords(records)).toMatchObject({
      phase: CONVERSATION_COORDINATION_PHASE.EXECUTOR_RUNNING,
      active_task: { task_id: replacementTask.task_id },
      last_escalation: null,
      task_count: 2,
    });
  });
});
