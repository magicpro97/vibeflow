import { isHostActionKind } from "../../actions/host-action-contract.js";
import {
  ACTION_OPERATION_EVENT_CURSOR_PATTERN,
  ACTION_OPERATION_STATE,
  isActionOperationApprovalProhibitedState,
  isActionOperationApprovalRequiredState,
  isActionOperationDispatchReplayState,
  isActionOperationState,
} from "../../actions/protocol-contract.js";
import {
  PUBLIC_ERROR_CODE,
  PUBLIC_RECOVERY_ACTION,
  isPublicRecoveryAction,
} from "../../actions/public-error-contract.js";
import { parsePublicApiErrorBody } from "../../actions/public-error-wire-validation.js";
import {
  PUBLIC_ACTION_TARGET_APPLY_FAILURE,
  PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_FIELDS,
  PUBLIC_ACTION_TARGET_HEALTH_FAILURE,
  PUBLIC_ACTION_TARGET_SUBJECT_KIND,
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_MESSAGE_CODE_PREFIX,
  PUBLIC_OPERATION_PROGRESS_STATUS,
  PUBLIC_TARGET_RESULT_FIELDS,
  isPublicActionTargetApplyFailure,
  isPublicActionTargetHealthFailure,
  isPublicActionTargetScope,
  isPublicOperationPhase,
  isPublicOperationProgressStatus,
  isPublicOperationStateDependentStatusPhase,
  isPublicTargetResultHealth,
  isPublicTargetResultOutcome,
} from "../../actions/public-operation-contract.js";
import { expectedOperationStatus } from "../../actions/public-operation-semantics.js";
import {
  compareUtf8Wire,
  isBoundedWireIdentity,
  isBoundedWireText,
  isExactWireTimestamp,
  isNonnegativeSafeWireInteger,
  isSha256WireDigest,
} from "../../actions/public-wire-primitives.js";
import { isAgentEngine } from "../../core/agent-contract.js";
import {
  ACTION_OPERATION_FIELDS,
  ACTION_PROGRESS_FIELDS,
  ACTION_TARGET_BINDING_FIELDS,
} from "./conversation-home-action-boundary-fields.js";
import {
  assert,
  ACTION_APPROVAL_ID_PATTERN,
  ACTION_CORRELATION_ID_PATTERN,
  ACTION_DELIVERY,
  ACTION_DOMAIN,
  ACTION_DOMAINS,
  ACTION_OPERATION_ID_PATTERN,
  ACTION_PROPOSAL_ID_PATTERN,
  PUBLIC_ACTION_SCHEMA_VERSION,
  assertExactRecord,
  assertPattern,
  memberOf,
  nullableDigest,
  nullableIdentity,
} from "./conversation-home-action-boundary-shared.js";
import { latestProgressMatchesSharedProducer } from "./conversation-home-action-operation-progress.js";
import type { HomeActionOperation } from "./conversation-home-types.js";

function parsePublicActionTarget(value: unknown): void {
  const row = assertExactRecord(value, PUBLIC_ACTION_TARGET_FIELDS, "invalid action target");
  assert(isPublicActionTargetScope(row.scope), "invalid action target scope");
  assert(row.engine === null || isAgentEngine(row.engine), "invalid action target engine");
  assert(nullableIdentity(row.participant_id), "invalid action target participant");
  assert(typeof row.required === "boolean", "invalid action target required flag");
  assert(isPublicActionTargetApplyFailure(row.on_apply_failure), "invalid target apply failure");
  assert(isPublicActionTargetHealthFailure(row.on_health_failure), "invalid target health failure");
  if (row.required) {
    assert(
      row.on_apply_failure === PUBLIC_ACTION_TARGET_APPLY_FAILURE.ABORT_SCOPE &&
        row.on_health_failure === PUBLIC_ACTION_TARGET_HEALTH_FAILURE.ABORT_SCOPE,
      "invalid required target failure policy",
    );
    return;
  }
  assert(
    row.on_apply_failure === PUBLIC_ACTION_TARGET_APPLY_FAILURE.OMIT_AFTER_ROLLBACK &&
      (row.on_health_failure === PUBLIC_ACTION_TARGET_HEALTH_FAILURE.OMIT_AFTER_ROLLBACK ||
        row.on_health_failure === PUBLIC_ACTION_TARGET_HEALTH_FAILURE.COMMIT_DEGRADED),
    "invalid optional target failure policy",
  );
}

function parseActionSubject(value: unknown): void {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "invalid action subject",
  );
  const kind = (value as { kind?: unknown }).kind;
  const fields =
    kind === PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION
      ? PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS
      : PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS;
  const row = assertExactRecord(value, fields, "invalid action subject");
  if (row.kind === PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION) {
    assert(isHostActionKind(row.action_type), "invalid subject action type");
    assert(nullableIdentity(row.participant_id), "invalid subject participant");
    return;
  }
  if (row.kind === PUBLIC_ACTION_TARGET_SUBJECT_KIND.CAPABILITY) {
    assert(isBoundedWireIdentity(row.package_id), "invalid subject package id");
    assert(isBoundedWireIdentity(row.component_id), "invalid subject component id");
    return;
  }
  throw new Error("invalid action subject kind");
}

export function parseActionTargetBinding(value: unknown): void {
  const row = assertExactRecord(
    value,
    ACTION_TARGET_BINDING_FIELDS,
    "invalid action target binding",
  );
  assert(isBoundedWireIdentity(row.target_id), "invalid action target binding id");
  parsePublicActionTarget(row.target);
  parseActionSubject(row.subject);
}

function parseTargetResult(value: unknown): void {
  const row = assertExactRecord(value, PUBLIC_TARGET_RESULT_FIELDS, "invalid action target result");
  assert(isBoundedWireIdentity(row.target_id), "invalid target result id");
  parsePublicActionTarget(row.target);
  parseActionSubject(row.subject);
  assert(isPublicTargetResultOutcome(row.outcome), "invalid target result outcome");
  assert(isPublicTargetResultHealth(row.health), "invalid target result health");
  assert(nullableDigest(row.evidence_digest), "invalid target result evidence digest");
}

function parseProgressEntry(
  value: unknown,
  index: number,
  state: Parameters<typeof expectedOperationStatus>[1],
): void {
  const row = assertExactRecord(value, ACTION_PROGRESS_FIELDS, "invalid action progress");
  assert(row.sequence === index, "invalid action progress sequence");
  assert(isPublicOperationPhase(row.phase), "invalid action progress phase");
  assert(isPublicOperationProgressStatus(row.status), "invalid action progress status");
  if (isPublicOperationStateDependentStatusPhase(row.phase))
    assert(
      row.status === PUBLIC_OPERATION_PROGRESS_STATUS.SUCCEEDED ||
        row.status === PUBLIC_OPERATION_PROGRESS_STATUS.FAILED,
      "invalid historical action progress status",
    );
  else
    assert(
      row.status === expectedOperationStatus(row.phase, state),
      "invalid action progress phase-status binding",
    );
  assert(
    row.message_code === `${PUBLIC_OPERATION_MESSAGE_CODE_PREFIX}${row.phase}` &&
      isBoundedWireText(row.message_code, { maxBytes: 512 }),
    "invalid action progress message code",
  );
  assert(isExactWireTimestamp(row.at), "invalid action progress timestamp");
}

export function parseActionOperation(value: unknown): HomeActionOperation {
  const row = assertExactRecord(value, ACTION_OPERATION_FIELDS, "invalid action operation");
  assert(
    row.schema_version === PUBLIC_ACTION_SCHEMA_VERSION,
    "invalid action operation schema version",
  );
  assert(
    row.operation_id === null ||
      (isBoundedWireIdentity(row.operation_id) &&
        ACTION_OPERATION_ID_PATTERN.test(row.operation_id)),
    "invalid action operation id",
  );
  assert(
    (row.operation_id !== null) === isActionOperationDispatchReplayState(row.state),
    "invalid action operation state/id binding",
  );
  assertPattern(
    row.proposal_id,
    ACTION_PROPOSAL_ID_PATTERN,
    "invalid action operation proposal id",
  );
  assert(isSha256WireDigest(row.proposal_digest), "invalid action operation proposal digest");
  assert(
    row.approval_id === null ||
      (isBoundedWireIdentity(row.approval_id) && ACTION_APPROVAL_ID_PATTERN.test(row.approval_id)),
    "invalid action operation approval id",
  );
  assert(nullableDigest(row.approval_digest), "invalid action operation approval digest");
  assert(
    (row.approval_id === null) === (row.approval_digest === null),
    "invalid action operation approval binding",
  );
  if (isActionOperationApprovalRequiredState(row.state))
    assert(row.approval_id !== null, "action operation state requires approval identity");
  if (isActionOperationApprovalProhibitedState(row.state))
    assert(row.approval_id === null, "action operation state prohibits approval identity");
  assertPattern(row.correlation_id, ACTION_CORRELATION_ID_PATTERN, "invalid action correlation id");
  assert(memberOf(ACTION_DOMAINS, row.domain), "invalid action operation domain");
  assert(isActionOperationState(row.state), "invalid action operation state");
  assert(
    row.phase_sequence === null || isNonnegativeSafeWireInteger(row.phase_sequence),
    "invalid action phase sequence",
  );
  assert(
    row.latest_event_cursor === null ||
      (typeof row.latest_event_cursor === "string" &&
        ACTION_OPERATION_EVENT_CURSOR_PATTERN.test(row.latest_event_cursor)),
    "invalid action latest event cursor",
  );
  assert(Array.isArray(row.progress), "invalid action progress history");
  let previousAt = Number.NEGATIVE_INFINITY;
  row.progress.forEach((entry, index) => {
    parseProgressEntry(entry, index, row.state);
    const at = Date.parse((entry as { at: string }).at);
    assert(at >= previousAt, "invalid action progress ordering");
    previousAt = at;
  });
  assert(Array.isArray(row.targets), "invalid action target history");
  for (const target of row.targets) parseTargetResult(target);
  assert(memberOf(ACTION_DELIVERY, row.delivery), "invalid action delivery");
  assert(row.result_ref === null, "v1 action result ref must be null");
  const error = row.error === null ? null : parsePublicApiErrorBody(row.error, row.correlation_id);
  if (error !== null) {
    const expected =
      row.state === ACTION_OPERATION_STATE.FAILED
        ? {
            code: PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED,
            phase: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED,
          }
        : row.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY
          ? {
              code: PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
              phase: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY,
            }
          : null;
    assert(
      row.domain === ACTION_DOMAIN.CAPABILITY &&
        expected !== null &&
        error.code === expected.code &&
        row.progress.at(-1)?.phase === expected.phase &&
        error.details.operation_id === row.operation_id,
      "invalid action operation error association",
    );
  }
  assert(Array.isArray(row.recovery_actions), "invalid action recovery actions");
  const recoveryActions = row.recovery_actions;
  assert(recoveryActions.every(isPublicRecoveryAction), "invalid action recovery actions");
  const sortedRecoveryActions = [...recoveryActions].sort(compareUtf8Wire);
  assert(
    new Set(recoveryActions).size === recoveryActions.length &&
      recoveryActions.every((action, index) => action === sortedRecoveryActions[index]),
    "action recovery actions must be unique and canonically ordered",
  );
  if (error !== null)
    assert(
      error.recovery_action === null
        ? recoveryActions.length === 0
        : recoveryActions.length === 1 && recoveryActions[0] === error.recovery_action,
      "action recovery actions contradict the public error",
    );
  else {
    const expectedRecovery =
      row.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY
        ? PUBLIC_RECOVERY_ACTION.REPAIR
        : row.state === ACTION_OPERATION_STATE.FAILED
          ? PUBLIC_RECOVERY_ACTION.RETRY
          : null;
    assert(
      expectedRecovery === null
        ? recoveryActions.length === 0
        : recoveryActions.length === 1 && recoveryActions[0] === expectedRecovery,
      "action recovery actions contradict operation state",
    );
  }
  assert(isExactWireTimestamp(row.created_at), "invalid action created_at");
  assert(isExactWireTimestamp(row.updated_at), "invalid action updated_at");
  assert(
    Date.parse(row.updated_at) >= Date.parse(row.created_at),
    "invalid action updated_at ordering",
  );
  const latestProgress = row.progress.at(-1);
  if (latestProgress)
    assert(
      Date.parse(row.updated_at) >= Date.parse(latestProgress.at),
      "action updated_at predates its latest progress",
    );
  assert(
    row.progress.every(
      (entry: { at: string }) => Date.parse(entry.at) >= Date.parse(row.created_at),
    ),
    "action progress predates its creation",
  );
  const targetIds = row.targets.map((target: { target_id: string }) => target.target_id);
  const sortedTargetIds = [...targetIds].sort(compareUtf8Wire);
  assert(
    new Set(targetIds).size === targetIds.length &&
      targetIds.every((targetId, index) => targetId === sortedTargetIds[index]),
    "action targets must be a unique canonical fold",
  );
  if (row.phase_sequence === null) {
    assert(row.latest_event_cursor === null, "undispatched action cannot expose an event cursor");
    assert(row.progress.length === 0, "undispatched action cannot expose progress");
    assert(row.targets.length === 0, "undispatched action cannot expose targets");
    assert(
      row.operation_id === null || row.state === ACTION_OPERATION_STATE.COMMITTING,
      "only a committing recovered dispatch may omit progress",
    );
  } else {
    assert(row.operation_id !== null, "dispatched action must expose an operation id");
    assert(row.latest_event_cursor !== null, "dispatched action must expose an event cursor");
    assert(row.progress.length === row.phase_sequence + 1, "invalid action progress density");
    const latest = row.progress.at(-1);
    assert(
      latest !== undefined &&
        latestProgressMatchesSharedProducer(
          row as Pick<HomeActionOperation, "domain" | "state">,
          latest as HomeActionOperation["progress"][number],
        ),
      "action operation state escaped its latest producer phase semantics",
    );
  }
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    operation_id: row.operation_id,
    proposal_id: row.proposal_id,
    proposal_digest: row.proposal_digest,
    approval_id: row.approval_id,
    approval_digest: row.approval_digest,
    correlation_id: row.correlation_id,
    domain: row.domain,
    state: row.state,
    phase_sequence: row.phase_sequence,
    latest_event_cursor: row.latest_event_cursor,
    progress: structuredClone(row.progress),
    targets: structuredClone(row.targets),
    delivery: row.delivery,
    result_ref: row.result_ref,
    error,
    recovery_actions: [...recoveryActions],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
