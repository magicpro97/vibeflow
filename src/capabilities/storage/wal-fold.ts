import {
  ACTION_OPERATION_STATE,
  ACTION_OPERATION_TRANSITION_TARGETS,
  type ActionOperationDispatchReplayState,
} from "../../actions/protocol-contract.js";
import { canonicalJson } from "../../durability/index.js";
import {
  type AdapterReceiptV1,
  CAPABILITY_ADAPTER_RECEIPT_ACTIVE_STATES,
  CAPABILITY_ADAPTER_RECEIPT_EFFECT_UNRESOLVED_STATES,
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_OUTBOX_DELIVERY,
  CAPABILITY_OUTBOX_TRANSITION,
  CAPABILITY_PRE_EFFECT_FRONTIER,
  CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN,
  CAPABILITY_WAL_PAYLOAD_KIND,
  type CapabilityWalEventV1,
  type CapabilityWalPayloadV1,
  isCapabilityAdapterReceiptStateIn,
  isLegalCapabilityAdapterReceiptTransition,
} from "../wire/operation.js";
import { CapabilityValidationError, timestamp } from "../wire/primitives.js";
import { validateCapabilityWalEvent } from "./wal-validation.js";

export interface CapabilityWalFoldV1 {
  state: ActionOperationDispatchReplayState;
  last_event_digest: string;
  latest_sequence: number;
}

function unresolved(receipts: ReadonlyMap<string, AdapterReceiptV1["state"]>): boolean {
  return [...receipts.values()].some((state) =>
    isCapabilityAdapterReceiptStateIn(CAPABILITY_ADAPTER_RECEIPT_ACTIVE_STATES, state),
  );
}

function effectUnresolved(receipts: ReadonlyMap<string, AdapterReceiptV1["state"]>): boolean {
  return [...receipts.values()].some((state) =>
    isCapabilityAdapterReceiptStateIn(CAPABILITY_ADAPTER_RECEIPT_EFFECT_UNRESOLVED_STATES, state),
  );
}

function unresolvedReceiptKeys(
  receipts: ReadonlyMap<string, AdapterReceiptV1["state"]>,
  ignoredPreparedKey: string | null,
): string[] {
  return [...receipts]
    .filter(
      ([key, state]) =>
        !(key === ignoredPreparedKey && state === CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED) &&
        isCapabilityAdapterReceiptStateIn(CAPABILITY_ADAPTER_RECEIPT_ACTIVE_STATES, state),
    )
    .map(([key]) => key);
}

function hasApplied(receipts: ReadonlyMap<string, AdapterReceiptV1["state"]>): boolean {
  return [...receipts.values()].includes(CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED);
}

export function foldCapabilityWal(events: readonly CapabilityWalEventV1[]): CapabilityWalFoldV1 {
  if (events.length === 0) throw new CapabilityValidationError("capability WAL is empty", "events");
  const operationId = events[0]?.operation_id as string;
  let priorDigest: string | null = null;
  let priorTime = -1;
  let state:
    | CapabilityWalFoldV1["state"]
    | typeof CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED =
    CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED;
  const receipts = new Map<string, AdapterReceiptV1["state"]>();
  const appliedOrder: string[] = [];
  const outbox = new Map<
    string,
    Extract<CapabilityWalPayloadV1, { kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.OUTBOX }>
  >();
  let nextPhase = 0;
  let checkpointed = false;
  let prepared: Extract<
    CapabilityWalPayloadV1,
    { kind: typeof CAPABILITY_WAL_PAYLOAD_KIND.HEALTH_INVENTORY_PREPARED }
  > | null = null;
  let committed = false;
  let refused = false;
  let refusedPreparedKey: string | null = null;
  for (const [index, event] of events.entries()) {
    validateCapabilityWalEvent(event, operationId);
    if (event.sequence !== index || event.previous_event_digest !== priorDigest)
      throw new CapabilityValidationError(
        "capability WAL is not dense/chained",
        `events[${index}]`,
      );
    const at = timestamp(event.recorded_at, `events[${index}].recorded_at`);
    if (at < priorTime)
      throw new CapabilityValidationError("capability WAL timestamps regress", `events[${index}]`);
    priorTime = at;
    const payload = event.payload;
    if (
      index === 0 &&
      (payload.kind !== CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION ||
        payload.from !== CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED ||
        payload.to !== ACTION_OPERATION_STATE.COMMITTING ||
        payload.reason_code !== null)
    )
      throw new CapabilityValidationError(
        "capability WAL sequence zero has wrong transition",
        "events[0].payload",
      );
    if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.OPERATION_TRANSITION) {
      const terminalReason =
        payload.to === ACTION_OPERATION_STATE.COMMITTING ||
        payload.to === ACTION_OPERATION_STATE.SUCCEEDED
          ? payload.reason_code === null
          : payload.reason_code !== null;
      const legal =
        terminalReason &&
        ((state === CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED &&
          payload.from === CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED &&
          payload.to === ACTION_OPERATION_STATE.COMMITTING) ||
          (state !== CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED &&
            payload.from === state &&
            ACTION_OPERATION_TRANSITION_TARGETS[state].some(
              (candidate) => candidate === payload.to,
            )));
      if (
        !legal ||
        (payload.to === ACTION_OPERATION_STATE.SUCCEEDED && (!committed || unresolved(receipts))) ||
        (payload.to === ACTION_OPERATION_STATE.FAILED &&
          (effectUnresolved(receipts) ||
            hasApplied(receipts) ||
            ([...receipts.values()].includes(CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED) &&
              !refusedPreparedKey)))
      )
        throw new CapabilityValidationError(
          "illegal operation state transition",
          `events[${index}].payload`,
        );
      state = payload.to as CapabilityWalFoldV1["state"];
    } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP) {
      const key = `${payload.receipt.plan_id}\0${payload.receipt.step_id}`;
      const prior = receipts.get(key);
      const next = payload.receipt.state;
      const activeKeys = unresolvedReceiptKeys(receipts, refusedPreparedKey);
      if (activeKeys.length > 1 || (activeKeys.length === 1 && activeKeys[0] !== key))
        throw new CapabilityValidationError(
          "adapter receipt escaped the single unresolved frontier",
          `events[${index}].payload.receipt`,
        );
      const rollbackAfterRefusal =
        (prior === CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED &&
          next === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSE_IN_PROGRESS) ||
        (prior === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSE_IN_PROGRESS &&
          (next === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED ||
            next === CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN)) ||
        (prior === CAPABILITY_ADAPTER_RECEIPT_STATE.UNCERTAIN &&
          (next === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSE_IN_PROGRESS ||
            next === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED));
      const reconciliation =
        state === ACTION_OPERATION_STATE.NEEDS_RECOVERY &&
        prior !== undefined &&
        isCapabilityAdapterReceiptStateIn(
          CAPABILITY_ADAPTER_RECEIPT_EFFECT_UNRESOLVED_STATES,
          prior,
        );
      if (
        committed ||
        (state !== ACTION_OPERATION_STATE.COMMITTING && !reconciliation) ||
        (refused && !rollbackAfterRefusal) ||
        !isLegalCapabilityAdapterReceiptTransition(prior, next)
      )
        throw new CapabilityValidationError(
          refused
            ? "only reverse receipts are legal after refusal"
            : "illegal adapter receipt transition",
          `events[${index}].payload.receipt.state`,
        );
      if (
        refused &&
        (next === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSE_IN_PROGRESS ||
          next === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED) &&
        appliedOrder.at(-1) !== key
      )
        throw new CapabilityValidationError(
          "compensation escaped reverse applied order after refusal",
          `events[${index}].payload.receipt`,
        );
      receipts.set(key, next);
      if (
        next === CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED &&
        prior !== CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED &&
        !appliedOrder.includes(key)
      )
        appliedOrder.push(key);
      if (next === CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED) {
        const appliedIndex = appliedOrder.lastIndexOf(key);
        if (appliedIndex >= 0) appliedOrder.splice(appliedIndex, 1);
      }
    } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.PRE_EFFECT_REFUSAL) {
      if (state !== ACTION_OPERATION_STATE.COMMITTING || refused || committed)
        throw new CapabilityValidationError(
          "duplicate or late pre-effect refusal",
          `events[${index}]`,
        );
      const active = [...receipts].filter(([, receiptState]) =>
        isCapabilityAdapterReceiptStateIn(CAPABILITY_ADAPTER_RECEIPT_ACTIVE_STATES, receiptState),
      );
      if (active.length > 0) {
        const [activeKey, activeState] = active[0] as [string, AdapterReceiptV1["state"]];
        const refusalKey = `${payload.refusal.plan_id}\0${payload.refusal.step_id}`;
        if (
          active.length !== 1 ||
          activeState !== CAPABILITY_ADAPTER_RECEIPT_STATE.PREPARED ||
          payload.refusal.frontier_kind !== CAPABILITY_PRE_EFFECT_FRONTIER.ADAPTER_STEP ||
          refusalKey !== activeKey
        )
          throw new CapabilityValidationError(
            "pre-effect refusal escaped the unresolved prepared frontier",
            `events[${index}].payload.refusal`,
          );
        refusedPreparedKey = activeKey;
      }
      refused = true;
    } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.HEALTH) {
      if (state !== ACTION_OPERATION_STATE.COMMITTING || refused || prepared || committed)
        throw new CapabilityValidationError(
          "health row occurs outside its legal frontier",
          `events[${index}]`,
        );
    } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.LOCK_CHECKPOINT) {
      if (
        state !== ACTION_OPERATION_STATE.COMMITTING ||
        refused ||
        checkpointed ||
        prepared ||
        committed
      )
        throw new CapabilityValidationError("illegal lock checkpoint", `events[${index}]`);
      checkpointed = true;
    } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.HEALTH_INVENTORY_PREPARED) {
      if (state !== ACTION_OPERATION_STATE.COMMITTING || refused || prepared || committed)
        throw new CapabilityValidationError(
          "duplicate or late inventory preparation",
          `events[${index}]`,
        );
      prepared = payload;
    } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.LOCK_COMMIT) {
      if (!prepared || committed || refused || state !== ACTION_OPERATION_STATE.COMMITTING)
        throw new CapabilityValidationError(
          "lock commit lacks one legal prepared predecessor",
          `events[${index}]`,
        );
      const { kind: _preparedKind, ...preparedFields } = prepared;
      const { kind: _commitKind, directory_fsync_completed: _fsync, ...commitFields } = payload;
      if (canonicalJson(preparedFields) !== canonicalJson(commitFields))
        throw new CapabilityValidationError(
          "lock commit differs from prepared inventory",
          `events[${index}]`,
        );
      committed = true;
    } else if (payload.kind === CAPABILITY_WAL_PAYLOAD_KIND.OUTBOX) {
      const prior = outbox.get(payload.outbox_event_id);
      if (!prior) {
        if (
          payload.transition !== CAPABILITY_OUTBOX_TRANSITION.CREATED ||
          payload.phase_sequence !== nextPhase
        )
          throw new CapabilityValidationError(
            "outbox introduction sequence is not dense",
            `events[${index}]`,
          );
        nextPhase += 1;
      } else {
        const stable = (row: typeof payload) => ({ ...row, transition: "", delivery: "" });
        if (
          canonicalJson(stable(prior)) !== canonicalJson(stable(payload)) ||
          prior.delivery === CAPABILITY_OUTBOX_DELIVERY.DELIVERED ||
          payload.transition === CAPABILITY_OUTBOX_TRANSITION.CREATED
        )
          throw new CapabilityValidationError(
            "illegal outbox delivery transition",
            `events[${index}]`,
          );
      }
      outbox.set(payload.outbox_event_id, payload);
    }
    priorDigest = event.event_digest;
  }
  if (state === CAPABILITY_WAL_OPERATION_TRANSITION_ORIGIN.CREATED)
    throw new CapabilityValidationError("capability WAL never entered committing", "events");
  return { state, last_event_digest: priorDigest as string, latest_sequence: events.length - 1 };
}
