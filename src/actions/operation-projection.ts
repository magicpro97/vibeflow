import { canonicalJsonBytes } from "../durability/index.js";
import { publicActionError } from "./errors.js";
import { isCapabilityHostActionKind } from "./host-action-contract.js";
import { validateOperationBatches } from "./operation-batch-validation.js";
import {
  assertPhaseOwner,
  expectedOperationStatus,
  isOperationPhase,
  terminalStateForPhase,
} from "./operation-phase-rules.js";
import {
  ACTION_OPERATION_STATE,
  ACTION_ROOT_LOCATOR_KIND,
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_PROGRESS_STATUS,
  PUBLIC_TARGET_RESULT_HEALTH,
  isActionOperationDomainTerminalState,
  isPublicOperationParticipantTargetPhase,
  isPublicOperationProgressStatus,
  isPublicTargetResultHealth,
  isPublicTargetResultOutcome,
  publicOperationTargetOutcomes,
} from "./protocol-contract.js";
import { PUBLIC_ERROR_CODE } from "./public-error-contract.js";
import { assertPublicProjectionSafe } from "./public-safety.js";
import type {
  ActionOperationEventV1,
  PublicOperationProgressV1,
  PublicTargetResultV1,
} from "./public-types.js";
import { assertDigest, assertOpaqueId, assertTimestamp, bytewise } from "./record-primitives.js";
import { exactObject, safeInteger } from "./strict-json.js";
import type { ActionAuthoritySnapshotV1 } from "./types.js";

export interface DomainProjectionFoldV1 {
  phase_sequence: number | null;
  latest_event_cursor: string | null;
  progress: PublicOperationProgressV1[];
  targets: PublicTargetResultV1[];
  error: ActionOperationEventV1["error"];
  updated_at: string;
}

export function foldDomainProjection(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[],
  correlationId: string,
): DomainProjectionFoldV1 {
  if (events.length > 16_384) throw new Error("operation phase count exceeds bound");
  if (!snapshot.operation_id && events.length)
    throw new Error("undispatched proposal has domain phases");
  let priorTime = 0;
  const cursors = new Set<string>();
  const targets = new Map<string, PublicTargetResultV1>();
  const progress: PublicOperationProgressV1[] = [];
  for (const [index, event] of events.entries()) {
    validateEvent(event, snapshot, correlationId, index);
    if (cursors.has(event.event_cursor)) throw new Error("operation event cursor is duplicated");
    cursors.add(event.event_cursor);
    const occurred = assertTimestamp(event.occurred_at, `$.operation_events[${index}].occurred_at`);
    if (occurred < priorTime) throw new Error("operation phase timestamps regress");
    priorTime = occurred;
    progress.push(structuredClone(event.progress as PublicOperationProgressV1));
    if (event.target) targets.set(event.target.target_id, structuredClone(event.target));
  }
  validateOperationBatches(snapshot, events);
  const last = events.at(-1);
  const capabilityOutbox =
    isCapabilityHostActionKind(snapshot.proposal.action.type) &&
    snapshot.proposal.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.CONVERSATION;
  if (isActionOperationDomainTerminalState(snapshot.state) && !last)
    throw new Error("terminal action authority has no domain phase closure");
  if (
    last &&
    !capabilityOutbox &&
    isActionOperationDomainTerminalState(snapshot.state) &&
    last.state !== snapshot.state
  )
    throw new Error("terminal operation phase does not match action authority");
  if (
    last &&
    !capabilityOutbox &&
    isActionOperationDomainTerminalState(snapshot.state) &&
    last.occurred_at !== snapshot.events.at(-1)?.recorded_at
  )
    throw new Error("terminal operation phase timestamp does not match domain mirror");
  const authorityUpdated = snapshot.events.at(-1)?.recorded_at ?? snapshot.proposal.created_at;
  const domainUpdated = last?.occurred_at ?? snapshot.proposal.created_at;
  return {
    phase_sequence: last?.phase_sequence ?? null,
    latest_event_cursor: last?.event_cursor ?? null,
    progress,
    targets: [...targets.values()].sort((left, right) => bytewise(left.target_id, right.target_id)),
    error: last?.error ?? null,
    updated_at:
      Date.parse(domainUpdated) > Date.parse(authorityUpdated) ? domainUpdated : authorityUpdated,
  };
}

function validateEvent(
  event: ActionOperationEventV1,
  snapshot: ActionAuthoritySnapshotV1,
  correlationId: string,
  index: number,
): void {
  const path = `$.operation_events[${index}]`;
  exactObject(
    event,
    [
      "schema_version",
      "operation_id",
      "phase_sequence",
      "state",
      "progress",
      "target",
      "error",
      "occurred_at",
      "event_cursor",
    ],
    [],
    path,
  );
  if (
    event.schema_version !== "1.0" ||
    event.operation_id !== snapshot.operation_id ||
    safeInteger(event.phase_sequence, `${path}.phase_sequence`) !== index
  )
    throw new Error("operation phase identity or dense sequence mismatch");
  assertOpaqueId(event.operation_id, `${path}.operation_id`);
  assertOpaqueId(event.event_cursor, `${path}.event_cursor`, 2_048);
  if (!isOperationPhase(event.progress?.phase)) throw new Error("unknown public operation phase");
  assertPhaseOwner(snapshot, event.progress.phase, index);
  validateProgress(event.progress, event.phase_sequence, event.occurred_at, event.state, path);
  if (event.target) validateTarget(event.target, snapshot, path);
  validatePhaseState(event, snapshot);
  if (event.error) {
    if (
      (event.state !== ACTION_OPERATION_STATE.FAILED &&
        event.state !== ACTION_OPERATION_STATE.NEEDS_RECOVERY) ||
      index === 0
    )
      throw new Error("public operation error is not on a terminal boundary");
    const checked = publicActionError(event.error as never).error;
    if (checked.correlation_id !== correlationId)
      throw new Error("operation error correlation mismatch");
    const expectedError =
      event.state === ACTION_OPERATION_STATE.FAILED
        ? PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED
        : PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY;
    const expectedPhase =
      event.state === ACTION_OPERATION_STATE.FAILED
        ? PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED
        : PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY;
    if (
      !isCapabilityHostActionKind(snapshot.proposal.action.type) ||
      checked.code !== expectedError ||
      event.progress?.phase !== expectedPhase
    )
      throw new Error("operation terminal error code does not match state");
  }
  if (
    index > 0 &&
    event.error === null &&
    (event.state === ACTION_OPERATION_STATE.FAILED ||
      event.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY) &&
    (event.progress?.phase === PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED ||
      event.progress?.phase === PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY)
  ) {
    // Ordinary terminal failures may intentionally have no public error.
  }
  assertPublicProjectionSafe(event, path);
}

function validateProgress(
  progress: PublicOperationProgressV1 | null,
  sequence: number,
  occurredAt: string,
  state: ActionOperationEventV1["state"],
  path: string,
): void {
  if (!progress) throw new Error("every public operation phase requires progress");
  exactObject(
    progress,
    ["sequence", "phase", "status", "message_code", "at"],
    [],
    `${path}.progress`,
  );
  if (
    progress.sequence !== sequence ||
    progress.message_code !== `operation.${progress.phase}` ||
    progress.at !== occurredAt ||
    !isPublicOperationProgressStatus(progress.status)
  )
    throw new Error("operation progress projection mismatch");
  if (progress.status !== expectedOperationStatus(progress.phase, state))
    throw new Error("operation progress status does not match phase");
}

function validateTarget(
  target: PublicTargetResultV1,
  snapshot: ActionAuthoritySnapshotV1,
  path: string,
): void {
  exactObject(
    target,
    ["target_id", "target", "subject", "outcome", "health", "evidence_digest"],
    [],
    `${path}.target`,
  );
  const expected = snapshot.proposal.target_set.find((row) => row.target_id === target.target_id);
  if (
    !expected ||
    !canonicalJsonBytes({ target: target.target, subject: target.subject }).equals(
      canonicalJsonBytes({ target: expected.target, subject: expected.subject }),
    )
  )
    throw new Error("operation target projection does not match immutable proposal");
  if (!isPublicTargetResultOutcome(target.outcome))
    throw new Error("invalid public target outcome");
  if (!isPublicTargetResultHealth(target.health)) throw new Error("invalid public target health");
  if (target.evidence_digest !== null)
    assertDigest(target.evidence_digest, `${path}.target.evidence_digest`);
}

function validatePhaseState(
  event: ActionOperationEventV1,
  snapshot: ActionAuthoritySnapshotV1,
): void {
  const phase = event.progress?.phase ?? "";
  const expected = terminalStateForPhase(phase);
  if (expected && event.state !== expected) throw new Error("operation phase/state mismatch");
  if (
    phase === PUBLIC_OPERATION_FIXED_PHASE.DISPATCH &&
    (event.state !== ACTION_OPERATION_STATE.COMMITTING ||
      event.progress?.status !== PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING ||
      event.target !== null)
  )
    throw new Error("dispatch phase projection mismatch");
  if (
    phase === PUBLIC_OPERATION_FIXED_PHASE.DISPATCH &&
    event.occurred_at !== snapshot.approval?.decided_at
  )
    throw new Error("dispatch phase timestamp mismatch");
  const targetOutcomes = event.progress
    ? publicOperationTargetOutcomes(event.progress.phase)
    : null;
  const targetBearing = targetOutcomes !== null;
  if (targetBearing !== (event.target !== null))
    throw new Error("operation phase target nullability mismatch");
  if (event.target) {
    if (!targetOutcomes?.includes(event.target.outcome))
      throw new Error("operation phase target outcome mismatch");
    if (
      isPublicOperationParticipantTargetPhase(phase) &&
      (event.target.health !== PUBLIC_TARGET_RESULT_HEALTH.UNKNOWN ||
        event.target.evidence_digest !== null)
    )
      throw new Error("participant target projection carries non-authoritative health evidence");
  }
}
