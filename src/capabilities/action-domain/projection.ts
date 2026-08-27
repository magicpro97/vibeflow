import {
  ACTION_OPERATION_EVENT_SCHEMA_VERSION,
  ACTION_OPERATION_STATE,
  type ActionAuthoritySnapshotV1,
  type ActionOperationDomainTerminalState,
  type ActionOperationEventV1,
  type ActionOperationState,
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_MESSAGE_CODE_PREFIX,
  PUBLIC_TARGET_RESULT_OUTCOME,
  type PublicApiErrorBodyV1,
  type PublicOperationFixedPhaseV1,
  type PublicOperationPhaseV1,
  type PublicTargetResultOutcomeV1,
  type PublicTargetResultV1,
  actionCorrelationId,
  initialActionDelivery,
  isActionOperationDomainTerminalState,
  projectActionSnapshot,
  publicActionError,
} from "../../actions/index.js";
import { expectedOperationStatus } from "../../actions/operation-phase-rules.js";
import {
  ACTION_DELIVERY_VALUE,
  type ActionDelivery,
} from "../../actions/public-action-contract.js";
import {
  PUBLIC_ERROR_CANONICAL_MESSAGE,
  PUBLIC_ERROR_CODE,
  PUBLIC_RECOVERY_ACTION,
} from "../../actions/public-error-contract.js";
import { canonicalJson, digestHex, digestV1 } from "../../durability/index.js";
import {
  readOperationBaseLock,
  readOperationGraph,
  readOperationHeader,
} from "../operations/fold.js";
import { foldCapabilityTarget } from "../operations/target-fold.js";
import type { CapabilityOperationActionAuthorityV1 } from "../operations/types.js";
import { readCapabilityWal } from "../storage/operation-store.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import {
  CAPABILITY_OUTBOX_DELIVERY,
  CAPABILITY_WAL_PAYLOAD_KIND,
  type CapabilityWalEventV1,
} from "../wire/operation.js";

const TARGET_PHASE_BY_OUTCOME = Object.freeze({
  [PUBLIC_TARGET_RESULT_OUTCOME.APPLIED]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_APPLIED,
  [PUBLIC_TARGET_RESULT_OUTCOME.FAILED]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_FAILED,
  [PUBLIC_TARGET_RESULT_OUTCOME.MANUAL]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_BLOCKED,
  [PUBLIC_TARGET_RESULT_OUTCOME.REQUIRED_USER_ACTION]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_BLOCKED,
  [PUBLIC_TARGET_RESULT_OUTCOME.UNSUPPORTED]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_BLOCKED,
  [PUBLIC_TARGET_RESULT_OUTCOME.OMITTED]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_OMITTED,
  [PUBLIC_TARGET_RESULT_OUTCOME.REVERSED]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_REVERSED,
  [PUBLIC_TARGET_RESULT_OUTCOME.DEGRADED]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_DEGRADED,
  [PUBLIC_TARGET_RESULT_OUTCOME.BLOCKED]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_BLOCKED,
  [PUBLIC_TARGET_RESULT_OUTCOME.NEEDS_RECOVERY]: PUBLIC_OPERATION_FIXED_PHASE.TARGET_NEEDS_RECOVERY,
} satisfies Readonly<Record<PublicTargetResultOutcomeV1, PublicOperationFixedPhaseV1>>);

const TERMINAL_PHASE_BY_STATE = Object.freeze({
  [ACTION_OPERATION_STATE.SUCCEEDED]: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED,
  [ACTION_OPERATION_STATE.FAILED]: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED,
  [ACTION_OPERATION_STATE.NEEDS_RECOVERY]: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY,
} satisfies Readonly<Record<ActionOperationDomainTerminalState, PublicOperationFixedPhaseV1>>);

function cursor(
  operationId: string,
  sequence: number,
  authorityDigest: string,
  targetId: string | null,
): string {
  return `vf-operation-event-${digestHex(
    digestV1("VF-CAPABILITY-ACTION-EVENT-CURSOR\0v1\0", {
      schema_version: ACTION_OPERATION_EVENT_SCHEMA_VERSION,
      operation_id: operationId,
      phase_sequence: sequence,
      authority_digest: authorityDigest,
      target_id: targetId,
    }),
  )}`;
}

function targetPhase(outcome: PublicTargetResultOutcomeV1): PublicOperationFixedPhaseV1 {
  return TARGET_PHASE_BY_OUTCOME[outcome];
}

function boundaryPhase(state: ActionOperationDomainTerminalState): PublicOperationFixedPhaseV1 {
  return TERMINAL_PHASE_BY_STATE[state];
}

function terminalTransitions(events: readonly CapabilityWalEventV1[]) {
  return events.flatMap((event, index) =>
    event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION &&
    isActionOperationDomainTerminalState(event.payload.to)
      ? [{ event, index, state: event.payload.to }]
      : [],
  );
}

function retainedRefusal(
  events: readonly CapabilityWalEventV1[],
):
  | Extract<
      CapabilityWalEventV1["payload"],
      { kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.PRE_EFFECT_REFUSAL }
    >["refusal"]
  | null {
  return (
    events
      .flatMap((event) =>
        event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.PRE_EFFECT_REFUSAL
          ? [event.payload.refusal]
          : [],
      )
      .at(-1) ?? null
  );
}

function refusalTerminalError(
  snapshot: ActionAuthoritySnapshotV1,
  operationId: string,
  state: ActionOperationDomainTerminalState,
  events: readonly CapabilityWalEventV1[],
): PublicApiErrorBodyV1 | null {
  const refusal = retainedRefusal(events);
  if (!refusal || state === ACTION_OPERATION_STATE.SUCCEEDED) return null;
  if (refusal.operation_id !== operationId)
    throw new Error("capability refusal escaped its operation binding");
  if (state === ACTION_OPERATION_STATE.NEEDS_RECOVERY)
    return publicActionError({
      code: PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
      message: PUBLIC_ERROR_CANONICAL_MESSAGE[PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY],
      correlation_id: actionCorrelationId(snapshot),
      retryable: false,
      recovery_action: PUBLIC_RECOVERY_ACTION.REPAIR,
      details: { operation_id: operationId },
    }).error;
  return publicActionError({
    code: PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED,
    message: PUBLIC_ERROR_CANONICAL_MESSAGE[PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED],
    correlation_id: actionCorrelationId(snapshot),
    retryable: false,
    recovery_action: PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
    details: {
      operation_id: operationId,
      reason_code: refusal.reason_code,
      frontier_kind: refusal.frontier_kind,
    },
  }).error;
}

function projectCapabilityActionDeliveryFold(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly CapabilityWalEventV1[],
): { delivery: ActionDelivery; updated_at: string | null } {
  const initial = initialActionDelivery(snapshot);
  const outbox = events.filter(
    (
      event,
    ): event is CapabilityWalEventV1 & {
      payload: Extract<
        CapabilityWalEventV1["payload"],
        { kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.OUTBOX }
      >;
    } => event.payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.OUTBOX,
  );
  if (initial === ACTION_DELIVERY_VALUE.NOT_APPLICABLE) {
    if (outbox.length > 0)
      throw new Error("non-applicable capability action contains outbox authority");
    return { delivery: initial, updated_at: null };
  }
  const latest = new Map<
    string,
    { delivery: (typeof outbox)[number]["payload"]["delivery"]; recorded_at: string }
  >();
  for (const event of outbox)
    latest.set(event.payload.outbox_event_id, {
      delivery: event.payload.delivery,
      recorded_at: event.recorded_at,
    });
  if (latest.size === 0) return { delivery: ACTION_DELIVERY_VALUE.PENDING, updated_at: null };
  const deliveries = [...latest.values()].map((entry) => entry.delivery);
  const updatedAt = outbox.at(-1)?.recorded_at ?? null;
  if (deliveries.every((delivery) => delivery === CAPABILITY_OUTBOX_DELIVERY.DELIVERED))
    return { delivery: ACTION_DELIVERY_VALUE.DELIVERED, updated_at: updatedAt };
  if (deliveries.some((delivery) => delivery === CAPABILITY_OUTBOX_DELIVERY.PENDING))
    return { delivery: ACTION_DELIVERY_VALUE.PENDING, updated_at: updatedAt };
  return { delivery: ACTION_DELIVERY_VALUE.FAILED, updated_at: updatedAt };
}

export function projectCapabilityActionDelivery(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly CapabilityWalEventV1[],
): ActionDelivery {
  return projectCapabilityActionDeliveryFold(snapshot, events).delivery;
}

function append(
  output: ActionOperationEventV1[],
  operationId: string,
  phase: PublicOperationPhaseV1,
  state: ActionOperationState,
  occurredAt: string,
  authorityDigest: string,
  target: PublicTargetResultV1 | null,
  error: PublicApiErrorBodyV1 | null = null,
): void {
  const sequence = output.length;
  output.push({
    schema_version: ACTION_OPERATION_EVENT_SCHEMA_VERSION,
    operation_id: operationId,
    phase_sequence: sequence,
    state,
    progress: {
      sequence,
      phase,
      status: expectedOperationStatus(phase, state),
      message_code: `${PUBLIC_OPERATION_MESSAGE_CODE_PREFIX}${phase}`,
      at: occurredAt,
    },
    target: target ? structuredClone(target) : null,
    error: error ? structuredClone(error) : null,
    occurred_at: occurredAt,
    event_cursor: cursor(operationId, sequence, authorityDigest, target?.target_id ?? null),
  });
}

/** Deterministically projects the private Capability WAL into the shared public action stream. */
export function projectCapabilityActionEvents(
  snapshot: ActionAuthoritySnapshotV1,
  storage: CapabilityStorageV1,
  actionAuthority: CapabilityOperationActionAuthorityV1,
): ActionOperationEventV1[] {
  const operationId = snapshot.operation_id;
  if (!operationId || !snapshot.approval) return [];
  const wal = readCapabilityWal(storage.paths, operationId);
  projectCapabilityActionDelivery(snapshot, wal);
  return projectCapabilityActionEventsFromWal(snapshot, storage, actionAuthority, wal);
}

function projectCapabilityActionEventsFromWal(
  snapshot: ActionAuthoritySnapshotV1,
  storage: CapabilityStorageV1,
  actionAuthority: CapabilityOperationActionAuthorityV1,
  wal: readonly CapabilityWalEventV1[],
): ActionOperationEventV1[] {
  const operationId = snapshot.operation_id;
  if (!operationId || !snapshot.approval) return [];
  const header = readOperationHeader(storage, operationId);
  const plan = readOperationGraph(actionAuthority, header).plan;
  const baseLock = readOperationBaseLock(storage, plan);
  const output: ActionOperationEventV1[] = [];
  append(
    output,
    operationId,
    PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
    ACTION_OPERATION_STATE.COMMITTING,
    header.created_at,
    header.header_digest,
    null,
  );
  if (snapshot.state === ACTION_OPERATION_STATE.COMMITTING) return output;
  const transitions = terminalTransitions(wal);
  const retained =
    snapshot.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY
      ? transitions.filter((row) => row.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY).slice(0, 1)
      : transitions.slice(0, transitions.findIndex((row) => row.state === snapshot.state) + 1);
  if (retained.length === 0) return output;
  let prior = new Map<string, PublicTargetResultV1>();
  for (const transition of retained) {
    const prefix = wal.slice(0, transition.index + 1);
    const current = plan.targets.map((target) =>
      foldCapabilityTarget({
        plan,
        events: prefix,
        targetId: target.target_id,
        terminal: transition.state,
        baseLock,
      }),
    );
    const changed =
      prior.size === 0
        ? current
        : current.filter(
            (target) => canonicalJson(prior.get(target.target_id)) !== canonicalJson(target),
          );
    for (const target of changed)
      append(
        output,
        operationId,
        targetPhase(target.outcome),
        transition.state,
        transition.event.recorded_at,
        transition.event.event_digest,
        target,
      );
    append(
      output,
      operationId,
      boundaryPhase(transition.state),
      transition.state,
      transition.event.recorded_at,
      transition.event.event_digest,
      null,
      refusalTerminalError(snapshot, operationId, transition.state, prefix),
    );
    prior = new Map(current.map((target) => [target.target_id, target]));
  }
  return output;
}

export function projectCapabilityActionSnapshot(
  snapshot: ActionAuthoritySnapshotV1,
  storage: CapabilityStorageV1,
  actionAuthority: CapabilityOperationActionAuthorityV1,
) {
  const operationId = snapshot.operation_id;
  const wal = operationId && snapshot.approval ? readCapabilityWal(storage.paths, operationId) : [];
  const delivery = projectCapabilityActionDeliveryFold(snapshot, wal);
  return projectActionSnapshot(
    snapshot,
    projectCapabilityActionEventsFromWal(snapshot, storage, actionAuthority, wal),
    { delivery: delivery.delivery, delivery_updated_at: delivery.updated_at ?? undefined },
  );
}
