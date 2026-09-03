import { digestV1 } from "../../durability/index.js";
import {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_LIMIT,
  CONVERSATION_COORDINATION_PHASE,
  type ConversationCoordinationPhaseV1,
  type ConversationCoordinationTerminalOutcomeV1,
} from "./conversation-coordination-contract.js";
import type {
  CoordinationTaskContractV1,
  CoordinatorResolutionV1,
  ExecutorBlockedV1,
  ExecutorClarificationV1,
  ExecutorCompletionV1,
  StoredConversationCoordinationRecordV1,
  UserEscalationV1,
} from "./conversation-coordination-records.js";
import { assertConversationCoordinationRecord } from "./conversation-coordination-validation.js";

export interface ConversationCoordinationStateV1 {
  epoch_id: string | null;
  phase: ConversationCoordinationPhaseV1;
  terminal_outcome: ConversationCoordinationTerminalOutcomeV1 | null;
  coordinator_participant_id: string | null;
  active_task: CoordinationTaskContractV1 | null;
  last_clarification: ExecutorClarificationV1 | null;
  last_resolution: CoordinatorResolutionV1 | null;
  last_completion: ExecutorCompletionV1 | null;
  last_blocked: ExecutorBlockedV1 | null;
  last_escalation: UserEscalationV1 | null;
  completed_task_ids: readonly string[];
  task_count: number;
  clarification_count: number;
  user_escalation_count: number;
  correction_keys: readonly string[];
  latest_artifact_ref: string | null;
  committed_records: readonly StoredConversationCoordinationRecordV1[];
  pending_records: readonly StoredConversationCoordinationRecordV1[];
}

type MutableState = {
  epochId: string | null;
  phase: ConversationCoordinationPhaseV1;
  terminalOutcome: ConversationCoordinationTerminalOutcomeV1 | null;
  coordinatorId: string | null;
  activeTask: CoordinationTaskContractV1 | null;
  clarification: ExecutorClarificationV1 | null;
  resolution: CoordinatorResolutionV1 | null;
  completion: ExecutorCompletionV1 | null;
  blocked: ExecutorBlockedV1 | null;
  escalation: UserEscalationV1 | null;
  completedTaskIds: string[];
  taskIds: Set<string>;
  clarificationDigests: Set<string>;
  clarificationCountByTask: Map<string, number>;
  escalationCountByTask: Map<string, number>;
  correctionKeys: Set<string>;
  latestRef: string | null;
};

const initial = (): MutableState => ({
  epochId: null,
  phase: CONVERSATION_COORDINATION_PHASE.COORDINATOR_PLANNING,
  terminalOutcome: null,
  coordinatorId: null,
  activeTask: null,
  clarification: null,
  resolution: null,
  completion: null,
  blocked: null,
  escalation: null,
  completedTaskIds: [],
  taskIds: new Set(),
  clarificationDigests: new Set(),
  clarificationCountByTask: new Map(),
  escalationCountByTask: new Map(),
  correctionKeys: new Set(),
  latestRef: null,
});

const fail = (message: string): never => {
  throw new Error(`invalid coordination journal: ${message}`);
};
const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);
const questionDigest = (taskId: string, question: string): string =>
  digestV1("VF-CONVERSATION-COORDINATION-QUESTION\0v1\0", {
    task_id: taskId,
    question: question.trim().toLowerCase().replace(/\s+/gu, " "),
  });

function applyRecord(
  state: MutableState,
  stored: StoredConversationCoordinationRecordV1,
  index: number,
): void {
  assertConversationCoordinationRecord(stored.record);
  const { artifact_ref: artifactRef, record } = stored;
  if (!artifactRef || Buffer.byteLength(artifactRef, "utf8") > 512) fail("artifact ref");
  if (record.step !== index + 1 || record.previous_ref !== state.latestRef) fail("record chain");
  if (state.epochId === null) state.epochId = record.epoch_id;
  if (state.epochId !== record.epoch_id) fail("epoch changed");
  if (state.coordinatorId === null) state.coordinatorId = record.coordinator_participant_id;
  if (state.coordinatorId !== record.coordinator_participant_id) fail("coordinator changed");
  const directive = record.directive;
  if (directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT) {
    if (record.actor_lane !== CONVERSATION_COORDINATION_LANE.HOST) fail("correction lane");
    if (
      record.actor_participant_id !== directive.correction.participant_id ||
      state.correctionKeys.has(directive.correction.correction_key)
    )
      fail("correction authority");
    state.correctionKeys.add(directive.correction.correction_key);
    state.latestRef = artifactRef;
    return;
  }
  if (directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH) {
    if (record.actor_lane !== CONVERSATION_COORDINATION_LANE.HOST) fail("termination lane");
    if (
      state.phase === CONVERSATION_COORDINATION_PHASE.COMPLETED ||
      state.phase === CONVERSATION_COORDINATION_PHASE.TERMINATED
    )
      fail("terminal epoch changed");
    state.terminalOutcome = directive.termination.outcome;
    state.phase = CONVERSATION_COORDINATION_PHASE.TERMINATED;
    state.latestRef = artifactRef;
    return;
  }
  if (
    directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK ||
    directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION ||
    directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE ||
    directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT
  ) {
    if (
      record.actor_lane !== CONVERSATION_COORDINATION_LANE.COORDINATOR ||
      record.actor_participant_id !== state.coordinatorId
    )
      fail("coordinator directive actor");
  }

  switch (directive.kind) {
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK: {
      const planning = state.phase === CONVERSATION_COORDINATION_PHASE.COORDINATOR_PLANNING;
      const reviewReplan =
        state.phase === CONVERSATION_COORDINATION_PHASE.COORDINATOR_REVIEWING &&
        state.blocked?.recoverable !== false;
      const userDecisionReplan =
        state.phase === CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT &&
        state.blocked?.recoverable === false &&
        state.escalation !== null;
      if (!planning && !reviewReplan && !userDecisionReplan)
        fail("task delegated while another task is active");
      const task = directive.task;
      if (task.executor_participant_id === state.coordinatorId || state.taskIds.has(task.task_id))
        fail("task identity");
      if (state.taskIds.size >= CONVERSATION_COORDINATION_LIMIT.MAX_TASKS) fail("task limit");
      state.taskIds.add(task.task_id);
      state.activeTask = task;
      state.clarification = null;
      state.resolution = null;
      state.completion = null;
      state.blocked = null;
      state.escalation = null;
      state.phase = CONVERSATION_COORDINATION_PHASE.EXECUTOR_RUNNING;
      break;
    }
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION: {
      const clarification = directive.clarification;
      if (
        state.phase !== CONVERSATION_COORDINATION_PHASE.EXECUTOR_RUNNING ||
        !state.activeTask ||
        clarification.task_id !== state.activeTask.task_id ||
        record.actor_participant_id !== state.activeTask.executor_participant_id
      )
        fail("clarification task authority");
      const count = state.clarificationCountByTask.get(clarification.task_id) ?? 0;
      if (count >= CONVERSATION_COORDINATION_LIMIT.MAX_CLARIFICATIONS_PER_TASK)
        fail("clarification limit");
      const digest = questionDigest(clarification.task_id, clarification.question);
      if (state.clarificationDigests.has(digest)) fail("repeated clarification loop");
      state.clarificationDigests.add(digest);
      state.clarificationCountByTask.set(clarification.task_id, count + 1);
      state.clarification = clarification;
      state.resolution = null;
      state.escalation = null;
      state.phase = CONVERSATION_COORDINATION_PHASE.COORDINATOR_RESOLVING;
      break;
    }
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION: {
      const resolution = directive.resolution;
      if (
        (state.phase !== CONVERSATION_COORDINATION_PHASE.COORDINATOR_RESOLVING &&
          state.phase !== CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT) ||
        !state.activeTask ||
        !state.clarification ||
        resolution.task_id !== state.activeTask.task_id ||
        resolution.question_id !== state.clarification.question_id
      )
        fail("clarification resolution authority");
      state.resolution = resolution;
      state.escalation = null;
      state.phase = CONVERSATION_COORDINATION_PHASE.EXECUTOR_RUNNING;
      break;
    }
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT: {
      const escalation = directive.escalation;
      const clarificationAuthority =
        (state.phase === CONVERSATION_COORDINATION_PHASE.COORDINATOR_RESOLVING ||
          state.phase === CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT) &&
        state.clarification !== null &&
        escalation.question_id === state.clarification.question_id;
      const blockedAuthority =
        state.phase === CONVERSATION_COORDINATION_PHASE.COORDINATOR_REVIEWING &&
        state.blocked?.recoverable === false &&
        state.escalation === null;
      if (
        !state.activeTask ||
        escalation.task_id !== state.activeTask.task_id ||
        (!clarificationAuthority && !blockedAuthority)
      )
        fail("user escalation authority");
      const count = state.escalationCountByTask.get(escalation.task_id) ?? 0;
      if (count >= CONVERSATION_COORDINATION_LIMIT.MAX_USER_ESCALATIONS_PER_TASK)
        fail("user escalation limit");
      state.escalationCountByTask.set(escalation.task_id, count + 1);
      state.escalation = escalation;
      state.phase = CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT;
      break;
    }
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK: {
      const completion = directive.completion;
      if (
        state.phase !== CONVERSATION_COORDINATION_PHASE.EXECUTOR_RUNNING ||
        !state.activeTask ||
        completion.task_id !== state.activeTask.task_id ||
        record.actor_participant_id !== state.activeTask.executor_participant_id
      )
        fail("task completion authority");
      state.completion = completion;
      state.blocked = null;
      state.completedTaskIds.push(completion.task_id);
      state.phase = CONVERSATION_COORDINATION_PHASE.COORDINATOR_REVIEWING;
      break;
    }
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED: {
      const blocked = directive.blocked;
      if (
        state.phase !== CONVERSATION_COORDINATION_PHASE.EXECUTOR_RUNNING ||
        !state.activeTask ||
        blocked.task_id !== state.activeTask.task_id ||
        record.actor_participant_id !== state.activeTask.executor_participant_id
      )
        fail("task blocked authority");
      state.blocked = blocked;
      state.completion = null;
      state.clarification = null;
      state.resolution = null;
      state.escalation = null;
      state.phase = CONVERSATION_COORDINATION_PHASE.COORDINATOR_REVIEWING;
      break;
    }
    case CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE: {
      if (
        state.phase !== CONVERSATION_COORDINATION_PHASE.COORDINATOR_REVIEWING ||
        state.completedTaskIds.length === 0 ||
        !sameStrings(directive.finalization.completed_task_ids, state.completedTaskIds)
      )
        fail("finalization evidence authority");
      state.phase = CONVERSATION_COORDINATION_PHASE.COMPLETED;
      break;
    }
  }
  state.latestRef = artifactRef;
}

function foldCommitted(records: readonly StoredConversationCoordinationRecordV1[]): MutableState {
  if (records.length > CONVERSATION_COORDINATION_LIMIT.MAX_TOTAL_RECORDS) fail("record limit");
  const state = initial();
  const recordIds = new Set<string>();
  const artifactRefs = new Set<string>();
  records.forEach((stored, index) => {
    if (recordIds.has(stored.record.record_id) || artifactRefs.has(stored.artifact_ref))
      fail("duplicate record");
    recordIds.add(stored.record.record_id);
    artifactRefs.add(stored.artifact_ref);
    applyRecord(state, stored, index);
  });
  return state;
}

export function foldConversationCoordinationRecords(
  committed: readonly StoredConversationCoordinationRecordV1[],
  pending: readonly StoredConversationCoordinationRecordV1[] = [],
): ConversationCoordinationStateV1 {
  if (pending.length > 1) fail("multiple pending records");
  const state = foldCommitted(committed);
  if (pending.length) foldCommitted([...committed, ...pending]);
  return Object.freeze({
    epoch_id: state.epochId,
    phase: state.phase,
    terminal_outcome: state.terminalOutcome,
    coordinator_participant_id: state.coordinatorId,
    active_task: state.activeTask ? structuredClone(state.activeTask) : null,
    last_clarification: state.clarification ? structuredClone(state.clarification) : null,
    last_resolution: state.resolution ? structuredClone(state.resolution) : null,
    last_completion: state.completion ? structuredClone(state.completion) : null,
    last_blocked: state.blocked ? structuredClone(state.blocked) : null,
    last_escalation: state.escalation ? structuredClone(state.escalation) : null,
    completed_task_ids: Object.freeze([...state.completedTaskIds]),
    task_count: state.taskIds.size,
    clarification_count: [...state.clarificationCountByTask.values()].reduce(
      (sum, count) => sum + count,
      0,
    ),
    user_escalation_count: [...state.escalationCountByTask.values()].reduce(
      (sum, count) => sum + count,
      0,
    ),
    correction_keys: Object.freeze([...state.correctionKeys]),
    latest_artifact_ref: state.latestRef,
    committed_records: Object.freeze(structuredClone([...committed])),
    pending_records: Object.freeze(structuredClone([...pending])),
  });
}

export const emptyConversationCoordinationState = (): ConversationCoordinationStateV1 =>
  foldConversationCoordinationRecords([]);
