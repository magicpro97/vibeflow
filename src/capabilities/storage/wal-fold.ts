import { canonicalJson } from "../../durability/index.js";
import type {
  AdapterReceiptV1,
  CapabilityWalEventV1,
  CapabilityWalPayloadV1,
} from "../wire/operation.js";
import { CapabilityValidationError, timestamp } from "../wire/primitives.js";
import { validateCapabilityWalEvent } from "./wal-validation.js";

export interface CapabilityWalFoldV1 {
  state: "committing" | "succeeded" | "failed" | "needs_recovery";
  last_event_digest: string;
  latest_sequence: number;
}

function unresolved(receipts: ReadonlyMap<string, AdapterReceiptV1["state"]>): boolean {
  return [...receipts.values()].some((state) =>
    ["prepared", "effect_in_progress", "reverse_in_progress", "uncertain"].includes(state),
  );
}

function effectUnresolved(receipts: ReadonlyMap<string, AdapterReceiptV1["state"]>): boolean {
  return [...receipts.values()].some((state) =>
    ["effect_in_progress", "reverse_in_progress", "uncertain"].includes(state),
  );
}

function unresolvedReceiptKeys(
  receipts: ReadonlyMap<string, AdapterReceiptV1["state"]>,
  ignoredPreparedKey: string | null,
): string[] {
  return [...receipts]
    .filter(
      ([key, state]) =>
        !(key === ignoredPreparedKey && state === "prepared") &&
        ["prepared", "effect_in_progress", "reverse_in_progress", "uncertain"].includes(state),
    )
    .map(([key]) => key);
}

function hasApplied(receipts: ReadonlyMap<string, AdapterReceiptV1["state"]>): boolean {
  return [...receipts.values()].includes("applied");
}

function legalReceipt(
  prior: AdapterReceiptV1["state"] | undefined,
  next: AdapterReceiptV1["state"],
): boolean {
  return (
    (prior === undefined && next === "prepared") ||
    (prior === "prepared" && next === "effect_in_progress") ||
    (prior === "effect_in_progress" && ["applied", "failed", "uncertain"].includes(next)) ||
    (prior === "applied" && next === "reverse_in_progress") ||
    (prior === "reverse_in_progress" && ["reversed", "uncertain"].includes(next)) ||
    (prior === "uncertain" &&
      ["applied", "failed", "reverse_in_progress", "reversed"].includes(next))
  );
}

export function foldCapabilityWal(events: readonly CapabilityWalEventV1[]): CapabilityWalFoldV1 {
  if (events.length === 0) throw new CapabilityValidationError("capability WAL is empty", "events");
  const operationId = events[0]?.operation_id as string;
  let priorDigest: string | null = null;
  let priorTime = -1;
  let state: CapabilityWalFoldV1["state"] | "created" = "created";
  const receipts = new Map<string, AdapterReceiptV1["state"]>();
  const appliedOrder: string[] = [];
  const outbox = new Map<string, CapabilityWalPayloadV1 & { kind: "outbox" }>();
  let nextPhase = 0;
  let checkpointed = false;
  let prepared: (CapabilityWalPayloadV1 & { kind: "health-inventory-prepared" }) | null = null;
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
      (payload.kind !== "operation-transition" ||
        payload.from !== "created" ||
        payload.to !== "committing" ||
        payload.reason_code !== null)
    )
      throw new CapabilityValidationError(
        "capability WAL sequence zero has wrong transition",
        "events[0].payload",
      );
    if (payload.kind === "operation-transition") {
      const terminalReason =
        payload.to === "committing" || payload.to === "succeeded"
          ? payload.reason_code === null
          : payload.reason_code !== null;
      const legal =
        terminalReason &&
        ((state === "created" && payload.from === "created" && payload.to === "committing") ||
          (state === "committing" &&
            payload.from === "committing" &&
            ["succeeded", "failed", "needs_recovery"].includes(payload.to)) ||
          (state === "needs_recovery" &&
            payload.from === "needs_recovery" &&
            ["succeeded", "failed"].includes(payload.to)));
      if (
        !legal ||
        (payload.to === "succeeded" && (!committed || unresolved(receipts))) ||
        (payload.to === "failed" &&
          (effectUnresolved(receipts) ||
            hasApplied(receipts) ||
            ([...receipts.values()].includes("prepared") && !refusedPreparedKey)))
      )
        throw new CapabilityValidationError(
          "illegal operation state transition",
          `events[${index}].payload`,
        );
      state = payload.to as CapabilityWalFoldV1["state"];
    } else if (payload.kind === "adapter-step") {
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
        (prior === "applied" && next === "reverse_in_progress") ||
        (prior === "reverse_in_progress" && ["reversed", "uncertain"].includes(next)) ||
        (prior === "uncertain" && ["reverse_in_progress", "reversed"].includes(next));
      const reconciliation =
        state === "needs_recovery" &&
        prior !== undefined &&
        ["effect_in_progress", "reverse_in_progress", "uncertain"].includes(prior);
      if (
        committed ||
        (state !== "committing" && !reconciliation) ||
        (refused && !rollbackAfterRefusal) ||
        !legalReceipt(prior, next)
      )
        throw new CapabilityValidationError(
          refused
            ? "only reverse receipts are legal after refusal"
            : "illegal adapter receipt transition",
          `events[${index}].payload.receipt.state`,
        );
      if (
        refused &&
        (next === "reverse_in_progress" || next === "reversed") &&
        appliedOrder.at(-1) !== key
      )
        throw new CapabilityValidationError(
          "compensation escaped reverse applied order after refusal",
          `events[${index}].payload.receipt`,
        );
      receipts.set(key, next);
      if (next === "applied" && prior !== "applied" && !appliedOrder.includes(key))
        appliedOrder.push(key);
      if (next === "reversed") {
        const appliedIndex = appliedOrder.lastIndexOf(key);
        if (appliedIndex >= 0) appliedOrder.splice(appliedIndex, 1);
      }
    } else if (payload.kind === "pre-effect-refusal") {
      if (state !== "committing" || refused || committed)
        throw new CapabilityValidationError(
          "duplicate or late pre-effect refusal",
          `events[${index}]`,
        );
      const active = [...receipts].filter(([, receiptState]) =>
        ["prepared", "effect_in_progress", "reverse_in_progress", "uncertain"].includes(
          receiptState,
        ),
      );
      if (active.length > 0) {
        const [activeKey, activeState] = active[0] as [string, AdapterReceiptV1["state"]];
        const refusalKey = `${payload.refusal.plan_id}\0${payload.refusal.step_id}`;
        if (
          active.length !== 1 ||
          activeState !== "prepared" ||
          payload.refusal.frontier_kind !== "adapter-step" ||
          refusalKey !== activeKey
        )
          throw new CapabilityValidationError(
            "pre-effect refusal escaped the unresolved prepared frontier",
            `events[${index}].payload.refusal`,
          );
        refusedPreparedKey = activeKey;
      }
      refused = true;
    } else if (payload.kind === "health") {
      if (state !== "committing" || refused || prepared || committed)
        throw new CapabilityValidationError(
          "health row occurs outside its legal frontier",
          `events[${index}]`,
        );
    } else if (payload.kind === "lock-checkpoint") {
      if (state !== "committing" || refused || checkpointed || prepared || committed)
        throw new CapabilityValidationError("illegal lock checkpoint", `events[${index}]`);
      checkpointed = true;
    } else if (payload.kind === "health-inventory-prepared") {
      if (state !== "committing" || refused || prepared || committed)
        throw new CapabilityValidationError(
          "duplicate or late inventory preparation",
          `events[${index}]`,
        );
      prepared = payload;
    } else if (payload.kind === "lock-commit") {
      if (!prepared || committed || refused || state !== "committing")
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
    } else if (payload.kind === "outbox") {
      const prior = outbox.get(payload.outbox_event_id);
      if (!prior) {
        if (payload.transition !== "created" || payload.phase_sequence !== nextPhase)
          throw new CapabilityValidationError(
            "outbox introduction sequence is not dense",
            `events[${index}]`,
          );
        nextPhase += 1;
      } else {
        const stable = (row: typeof payload) => ({ ...row, transition: "", delivery: "" });
        if (
          canonicalJson(stable(prior)) !== canonicalJson(stable(payload)) ||
          prior.delivery === "delivered" ||
          payload.transition === "created"
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
  if (state === "created")
    throw new CapabilityValidationError("capability WAL never entered committing", "events");
  return { state, last_event_digest: priorDigest as string, latest_sequence: events.length - 1 };
}
