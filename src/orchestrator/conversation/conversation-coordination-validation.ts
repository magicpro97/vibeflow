import {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_ESCALATION_REASONS,
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_LIMIT,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCE,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCES,
  CONVERSATION_COORDINATION_SCHEMA_VERSION,
  CONVERSATION_COORDINATION_TERMINAL_OUTCOME,
  type ConversationCoordinationEscalationReasonV1,
  type ConversationCoordinationLaneV1,
  type ConversationCoordinationResolutionSourceV1,
  type ConversationCoordinationTerminalOutcomeV1,
} from "./conversation-coordination-contract.js";
import type {
  ConversationCoordinationDirectiveV1,
  ConversationCoordinationRecordV1,
  CoordinationEpochTerminationV1,
  CoordinationFinalizationV1,
  CoordinationMalformedOutputV1,
  CoordinationResolutionAttemptV1,
  CoordinationTaskContractV1,
  CoordinatorResolutionV1,
  ExecutorBlockedV1,
  ExecutorClarificationV1,
  ExecutorCompletionV1,
  UserEscalationV1,
} from "./conversation-coordination-records.js";

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: JsonRecord, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const text = (
  value: unknown,
  max = CONVERSATION_COORDINATION_LIMIT.MAX_TEXT_BYTES,
): value is string =>
  typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max;
const reference = (value: unknown): value is string =>
  text(value, CONVERSATION_COORDINATION_LIMIT.MAX_REFERENCE_BYTES) &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32);
const list = (value: unknown, minimum = 0): value is string[] =>
  Array.isArray(value) &&
  value.length >= minimum &&
  value.length <= CONVERSATION_COORDINATION_LIMIT.MAX_LIST_ITEMS &&
  value.every((item) => text(item)) &&
  new Set(value).size === value.length;

function task(value: unknown): value is CoordinationTaskContractV1 {
  return (
    record(value) &&
    exact(value, [
      "task_id",
      "executor_participant_id",
      "goal",
      "scope",
      "forbidden",
      "must_haves",
      "verify_oracles",
      "source_message_refs",
    ]) &&
    reference(value.task_id) &&
    reference(value.executor_participant_id) &&
    text(value.goal) &&
    list(value.scope, 1) &&
    list(value.forbidden) &&
    list(value.must_haves, 1) &&
    list(value.verify_oracles, 1) &&
    list(value.source_message_refs, 1)
  );
}

function clarification(value: unknown): value is ExecutorClarificationV1 {
  return (
    record(value) &&
    exact(value, [
      "task_id",
      "question_id",
      "question",
      "blocking_reason",
      "attempted_interpretations",
      "required_decision",
    ]) &&
    reference(value.task_id) &&
    reference(value.question_id) &&
    text(value.question) &&
    text(value.blocking_reason) &&
    list(value.attempted_interpretations, 1) &&
    text(value.required_decision)
  );
}

function resolution(value: unknown): value is CoordinatorResolutionV1 {
  if (
    !record(value) ||
    !exact(value, ["task_id", "question_id", "answer", "source", "source_refs", "assumptions"]) ||
    !reference(value.task_id) ||
    !reference(value.question_id) ||
    !text(value.answer) ||
    !CONVERSATION_COORDINATION_RESOLUTION_SOURCES.includes(
      value.source as ConversationCoordinationResolutionSourceV1,
    ) ||
    !list(value.source_refs) ||
    !list(value.assumptions)
  )
    return false;
  return value.source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.SAFE_DEFAULT
    ? value.assumptions.length > 0
    : value.source_refs.length > 0;
}

function escalation(value: unknown): value is UserEscalationV1 {
  if (
    !record(value) ||
    !exact(value, [
      "task_id",
      "question_id",
      "question",
      "reason_code",
      "resolution_attempts",
      "impact",
      "options",
    ]) ||
    !reference(value.task_id) ||
    !reference(value.question_id) ||
    !text(value.question) ||
    !CONVERSATION_COORDINATION_ESCALATION_REASONS.includes(
      value.reason_code as ConversationCoordinationEscalationReasonV1,
    ) ||
    !Array.isArray(value.resolution_attempts) ||
    value.resolution_attempts.length !== CONVERSATION_COORDINATION_RESOLUTION_SOURCES.length ||
    !value.resolution_attempts.every((attempt) => resolutionAttempt(attempt)) ||
    !CONVERSATION_COORDINATION_RESOLUTION_SOURCES.every(
      (source, index) =>
        (value.resolution_attempts as CoordinationResolutionAttemptV1[])[index]?.source === source,
    ) ||
    !text(value.impact) ||
    !list(value.options, 2)
  )
    return false;
  return value.options.length <= CONVERSATION_COORDINATION_LIMIT.MAX_OPTIONS;
}

function resolutionAttempt(value: unknown): value is CoordinationResolutionAttemptV1 {
  if (
    !record(value) ||
    !exact(value, ["source", "outcome", "source_refs"]) ||
    !CONVERSATION_COORDINATION_RESOLUTION_SOURCES.includes(
      value.source as ConversationCoordinationResolutionSourceV1,
    ) ||
    !text(value.outcome) ||
    !list(value.source_refs)
  )
    return false;
  return value.source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.SAFE_DEFAULT
    ? value.source_refs.length === 0
    : value.source_refs.length > 0;
}

function executorCompletion(value: unknown): value is ExecutorCompletionV1 {
  if (
    !record(value) ||
    !exact(value, ["task_id", "summary", "changed_paths", "evidence_refs", "verification"]) ||
    !reference(value.task_id) ||
    !text(value.summary) ||
    !list(value.changed_paths) ||
    !list(value.evidence_refs, 1) ||
    !record(value.verification) ||
    !exact(value.verification, ["commands", "passed"])
  )
    return false;
  return list(value.verification.commands, 1) && value.verification.passed === true;
}

const blocked = (value: unknown): value is ExecutorBlockedV1 =>
  record(value) &&
  exact(value, ["task_id", "reason", "evidence_refs", "recoverable"]) &&
  reference(value.task_id) &&
  text(value.reason) &&
  list(value.evidence_refs, 1) &&
  typeof value.recoverable === "boolean";
const finalization = (value: unknown): value is CoordinationFinalizationV1 =>
  record(value) &&
  exact(value, ["completed_task_ids", "reviewed_head", "summary", "evidence_refs"]) &&
  list(value.completed_task_ids, 1) &&
  typeof value.reviewed_head === "string" &&
  /^[0-9a-f]{40,64}$/.test(value.reviewed_head) &&
  text(value.summary) &&
  list(value.evidence_refs, 1);
const malformed = (value: unknown): value is CoordinationMalformedOutputV1 =>
  record(value) &&
  exact(value, ["correction_key", "participant_id", "lane", "diagnostic_code"]) &&
  reference(value.correction_key) &&
  reference(value.participant_id) &&
  (value.lane === CONVERSATION_COORDINATION_LANE.COORDINATOR ||
    value.lane === CONVERSATION_COORDINATION_LANE.EXECUTOR) &&
  reference(value.diagnostic_code);
const termination = (value: unknown): value is CoordinationEpochTerminationV1 =>
  record(value) &&
  exact(value, ["outcome", "reason_code"]) &&
  Object.values(CONVERSATION_COORDINATION_TERMINAL_OUTCOME).includes(
    value.outcome as ConversationCoordinationTerminalOutcomeV1,
  ) &&
  reference(value.reason_code);

export function parseConversationCoordinationDirective(
  value: unknown,
  lane: ConversationCoordinationLaneV1,
): ConversationCoordinationDirectiveV1 | null {
  if (!record(value) || value.schema_version !== CONVERSATION_COORDINATION_SCHEMA_VERSION)
    return null;
  const base = ["schema_version", "kind"];
  let valid = false;
  if (lane === CONVERSATION_COORDINATION_LANE.COORDINATOR) {
    valid =
      (value.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK &&
        exact(value, [...base, "task"]) &&
        task(value.task)) ||
      (value.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION &&
        exact(value, [...base, "resolution"]) &&
        resolution(value.resolution)) ||
      (value.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE &&
        exact(value, [...base, "finalization"]) &&
        finalization(value.finalization)) ||
      (value.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT &&
        exact(value, [...base, "escalation"]) &&
        escalation(value.escalation));
  } else if (lane === CONVERSATION_COORDINATION_LANE.EXECUTOR) {
    valid =
      (value.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION &&
        exact(value, [...base, "clarification"]) &&
        clarification(value.clarification)) ||
      (value.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK &&
        exact(value, [...base, "completion"]) &&
        executorCompletion(value.completion)) ||
      (value.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED &&
        exact(value, [...base, "blocked"]) &&
        blocked(value.blocked));
  } else {
    valid =
      (value.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT &&
        exact(value, [...base, "correction"]) &&
        malformed(value.correction)) ||
      (value.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH &&
        exact(value, [...base, "termination"]) &&
        termination(value.termination));
  }
  return valid ? (structuredClone(value) as ConversationCoordinationDirectiveV1) : null;
}

export function assertConversationCoordinationRecord(
  value: unknown,
): asserts value is ConversationCoordinationRecordV1 {
  if (
    !record(value) ||
    !exact(value, [
      "schema_version",
      "epoch_id",
      "record_id",
      "operation_id",
      "revision_id",
      "step",
      "coordinator_participant_id",
      "actor_participant_id",
      "actor_lane",
      "previous_ref",
      "directive",
    ]) ||
    value.schema_version !== CONVERSATION_COORDINATION_SCHEMA_VERSION ||
    typeof value.epoch_id !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.epoch_id) ||
    !reference(value.record_id) ||
    !reference(value.operation_id) ||
    !reference(value.revision_id) ||
    !Number.isSafeInteger(value.step) ||
    (value.step as number) < 1 ||
    !reference(value.coordinator_participant_id) ||
    !reference(value.actor_participant_id) ||
    (value.previous_ref !== null && !reference(value.previous_ref)) ||
    !Object.values(CONVERSATION_COORDINATION_LANE).includes(
      value.actor_lane as ConversationCoordinationLaneV1,
    )
  )
    throw new Error("invalid coordination record");
  const directive = parseConversationCoordinationDirective(
    value.directive,
    value.actor_lane as ConversationCoordinationLaneV1,
  );
  if (!directive) throw new Error("invalid coordination directive");
  if (
    value.actor_lane === CONVERSATION_COORDINATION_LANE.COORDINATOR &&
    value.actor_participant_id !== value.coordinator_participant_id
  )
    throw new Error("coordinator record actor mismatch");
  if (
    value.actor_lane === CONVERSATION_COORDINATION_LANE.HOST &&
    directive.kind !== CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT &&
    directive.kind !== CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH
  )
    throw new Error("host coordination record mismatch");
}
