import { isAgentEngine } from "../core/agent-contract.js";
import { isCapabilityHostActionKind, isHostActionKind } from "./host-action-contract.js";
import type { ActionTargetBindingV1 } from "./preview-types.js";
import {
  ACTION_OPERATION_EVENT_CURSOR_PATTERN,
  ACTION_OPERATION_EVENT_FIELDS,
  ACTION_OPERATION_EVENT_SCHEMA_VERSION,
  ACTION_OPERATION_STATE,
  type ActionOperationState,
  isActionOperationState,
} from "./protocol-contract.js";
import { PUBLIC_ERROR_CODE, type PublicApiErrorBodyV1 } from "./public-error-contract.js";
import { parsePublicApiErrorBody } from "./public-error-wire-validation.js";
import {
  PUBLIC_ACTION_TARGET_APPLY_FAILURE,
  PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_FIELDS,
  PUBLIC_ACTION_TARGET_HEALTH_FAILURE,
  PUBLIC_ACTION_TARGET_SUBJECT_KIND,
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_MESSAGE_CODE_PREFIX,
  PUBLIC_OPERATION_PROGRESS_FIELDS,
  PUBLIC_OPERATION_PROGRESS_STATUS,
  PUBLIC_TARGET_RESULT_FIELDS,
  PUBLIC_TARGET_RESULT_HEALTH,
  isPublicActionTargetScope,
  isPublicOperationParticipantTargetPhase,
  isPublicOperationPhase,
  isPublicOperationProgressStatus,
  isPublicTargetResultHealth,
  isPublicTargetResultOutcome,
  publicOperationTargetOutcomes,
} from "./public-operation-contract.js";
import type {
  ActionOperationEventV1,
  PublicOperationProgressV1,
  PublicTargetResultV1,
} from "./public-operation-dto.js";
import {
  expectedOperationStatus,
  isPublicOperationPhaseOwned,
  isPublicOperationPhaseStateValid,
  terminalStateForPhase,
} from "./public-operation-semantics.js";
import {
  hasExactWireFields,
  isBoundedWireIdentity,
  isExactWireTimestamp,
  isNonnegativeSafeWireInteger,
  isPlainWireRecord,
  isSha256WireDigest,
  sameWireValue,
} from "./public-wire-primitives.js";

const nullableIdentity = (value: unknown): value is string | null =>
  value === null || isBoundedWireIdentity(value);

function isPublicActionTarget(value: unknown): boolean {
  if (!isPlainWireRecord(value) || !hasExactWireFields(value, PUBLIC_ACTION_TARGET_FIELDS))
    return false;
  if (
    !isPublicActionTargetScope(value.scope) ||
    (value.engine !== null && !isAgentEngine(value.engine)) ||
    !nullableIdentity(value.participant_id) ||
    typeof value.required !== "boolean"
  )
    return false;
  return value.required
    ? value.on_apply_failure === PUBLIC_ACTION_TARGET_APPLY_FAILURE.ABORT_SCOPE &&
        value.on_health_failure === PUBLIC_ACTION_TARGET_HEALTH_FAILURE.ABORT_SCOPE
    : value.on_apply_failure === PUBLIC_ACTION_TARGET_APPLY_FAILURE.OMIT_AFTER_ROLLBACK &&
        (value.on_health_failure === PUBLIC_ACTION_TARGET_HEALTH_FAILURE.OMIT_AFTER_ROLLBACK ||
          value.on_health_failure === PUBLIC_ACTION_TARGET_HEALTH_FAILURE.COMMIT_DEGRADED);
}

function isPublicActionSubject(value: unknown): boolean {
  if (!isPlainWireRecord(value)) return false;
  if (value.kind === PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION)
    return (
      hasExactWireFields(value, PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS) &&
      isHostActionKind(value.action_type) &&
      nullableIdentity(value.participant_id)
    );
  if (value.kind === PUBLIC_ACTION_TARGET_SUBJECT_KIND.CAPABILITY)
    return (
      hasExactWireFields(value, PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS) &&
      isBoundedWireIdentity(value.package_id) &&
      isBoundedWireIdentity(value.component_id)
    );
  return false;
}

export function isPublicOperationProgress(
  value: unknown,
  expected: { sequence: number; state: ActionOperationState; occurredAt: string },
): value is PublicOperationProgressV1 {
  if (
    !isPlainWireRecord(value) ||
    !hasExactWireFields(value, PUBLIC_OPERATION_PROGRESS_FIELDS) ||
    value.sequence !== expected.sequence ||
    !isPublicOperationPhase(value.phase) ||
    !isPublicOperationProgressStatus(value.status) ||
    value.message_code !== `${PUBLIC_OPERATION_MESSAGE_CODE_PREFIX}${value.phase}` ||
    value.at !== expected.occurredAt
  )
    return false;
  try {
    return value.status === expectedOperationStatus(value.phase, expected.state);
  } catch {
    return false;
  }
}

export function isPublicTargetResult(value: unknown): value is PublicTargetResultV1 {
  return (
    isPlainWireRecord(value) &&
    hasExactWireFields(value, PUBLIC_TARGET_RESULT_FIELDS) &&
    isBoundedWireIdentity(value.target_id) &&
    isPublicActionTarget(value.target) &&
    isPublicActionSubject(value.subject) &&
    isPublicTargetResultOutcome(value.outcome) &&
    isPublicTargetResultHealth(value.health) &&
    (value.evidence_digest === null || isSha256WireDigest(value.evidence_digest))
  );
}

export function isPublicOperationEventSemantics(input: {
  progress: PublicOperationProgressV1;
  target: PublicTargetResultV1 | null;
  error: PublicApiErrorBodyV1 | null;
  state: ActionOperationState;
  phaseSequence: number;
  actionType: unknown;
}): boolean {
  const { progress, target, error, state, phaseSequence, actionType } = input;
  if (
    !isPublicOperationPhaseOwned({ actionType, phase: progress.phase, phaseSequence }) ||
    !isPublicOperationPhaseStateValid({
      actionType,
      phase: progress.phase,
      phaseSequence,
      state,
    })
  )
    return false;
  if (
    phaseSequence === 0 &&
    (state !== ACTION_OPERATION_STATE.COMMITTING || target !== null || error !== null)
  )
    return false;
  const terminalState = terminalStateForPhase(progress.phase);
  if (terminalState !== null && terminalState !== state) return false;
  if (
    progress.phase === PUBLIC_OPERATION_FIXED_PHASE.DISPATCH &&
    progress.status !== PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING
  )
    return false;
  const outcomes = publicOperationTargetOutcomes(progress.phase);
  if ((outcomes !== null) !== (target !== null)) return false;
  if (target && !outcomes?.includes(target.outcome)) return false;
  if (
    target &&
    isPublicOperationParticipantTargetPhase(progress.phase) &&
    (target.health !== PUBLIC_TARGET_RESULT_HEALTH.UNKNOWN || target.evidence_digest !== null)
  )
    return false;
  if (error === null) return true;
  if (
    (state !== ACTION_OPERATION_STATE.FAILED && state !== ACTION_OPERATION_STATE.NEEDS_RECOVERY) ||
    phaseSequence === 0
  )
    return false;
  if (!isCapabilityHostActionKind(actionType)) return false;
  const expectedCode =
    state === ACTION_OPERATION_STATE.FAILED
      ? PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED
      : PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY;
  const expectedPhase =
    state === ACTION_OPERATION_STATE.FAILED
      ? PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED
      : PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY;
  return error.code === expectedCode && progress.phase === expectedPhase;
}

export function parsePublicOperationEvent(
  value: unknown,
  expected: {
    operationId: string;
    correlationId: string;
    actionType: unknown;
    targets: readonly ActionTargetBindingV1[];
  },
): ActionOperationEventV1 {
  if (
    !isPlainWireRecord(value) ||
    !hasExactWireFields(value, ACTION_OPERATION_EVENT_FIELDS) ||
    value.schema_version !== ACTION_OPERATION_EVENT_SCHEMA_VERSION ||
    value.operation_id !== expected.operationId ||
    !isBoundedWireIdentity(value.operation_id) ||
    !isActionOperationState(value.state) ||
    !isNonnegativeSafeWireInteger(value.phase_sequence) ||
    !isExactWireTimestamp(value.occurred_at) ||
    typeof value.event_cursor !== "string" ||
    !ACTION_OPERATION_EVENT_CURSOR_PATTERN.test(value.event_cursor) ||
    !isPublicOperationProgress(value.progress, {
      sequence: value.phase_sequence,
      state: value.state,
      occurredAt: value.occurred_at,
    }) ||
    (value.target !== null && !isPublicTargetResult(value.target))
  )
    throw new Error("invalid public operation event");
  const error =
    value.error === null ? null : parsePublicApiErrorBody(value.error, expected.correlationId);
  if (value.target !== null) {
    const parsedTarget = value.target as PublicTargetResultV1;
    const binding = expected.targets.find((target) => target.target_id === parsedTarget.target_id);
    if (
      binding === undefined ||
      !sameWireValue(
        { target: parsedTarget.target, subject: parsedTarget.subject },
        { target: binding.target, subject: binding.subject },
      )
    )
      throw new Error("public operation target binding mismatch");
  }
  if (
    error !== null &&
    (error.code === PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED ||
      error.code === PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY) &&
    error.details.operation_id !== value.operation_id
  )
    throw new Error("public operation error identity mismatch");
  if (
    !isPublicOperationEventSemantics({
      progress: value.progress,
      target: value.target,
      error,
      state: value.state,
      phaseSequence: value.phase_sequence,
      actionType: expected.actionType,
    })
  )
    throw new Error("invalid public operation event semantics");
  return {
    schema_version: ACTION_OPERATION_EVENT_SCHEMA_VERSION,
    operation_id: value.operation_id,
    phase_sequence: value.phase_sequence,
    state: value.state,
    progress: value.progress,
    target: value.target,
    error,
    occurred_at: value.occurred_at,
    event_cursor: value.event_cursor,
  };
}
