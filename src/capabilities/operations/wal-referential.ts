import { canonicalJson } from "../../durability/index.js";
import type { CapabilityFabricPlanV1 } from "../planning/types.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import type {
  AdapterReceiptV1,
  CapabilityOperationV1,
  CapabilityWalEventV1,
} from "../wire/operation.js";
import { bytewise } from "../wire/primitives.js";
import { CapabilityRuntimeError } from "./errors.js";
import { resolveHealthObservationBatches } from "./health-evidence.js";
import { validateCapabilityLockCheckpoint } from "./lock-checkpoint.js";
import { assertCapabilityPublicationEvidence } from "./publication-evidence.js";
import { readCapabilityPreEffectObservation } from "./refusal-evidence.js";
import {
  assertCapabilityForwardReceiptOrder,
  assertCapabilityReceipt,
  capabilityReceiptKey,
  latestCapabilityReceipts,
} from "./wal-receipt-referential.js";

function corrupt(message: string): never {
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function hostTargetIds(plan: CapabilityFabricPlanV1): string[] {
  return plan.target_dispositions
    .filter((row) => row.execution === "host")
    .map((row) => row.target_id)
    .sort(bytewise);
}

function healthKey(planId: string, probeId: string, targetId: string): string {
  return `${planId}\0${probeId}\0${targetId}`;
}

function expectedHealthKeys(
  plan: CapabilityFabricPlanV1,
  events: readonly CapabilityWalEventV1[],
  planId: string,
  beforeSequence: number,
): string[] {
  const adapterPlan = plan.adapter_plans.find((row) => row.plan_id === planId);
  if (!adapterPlan) corrupt("health observation names an unknown adapter plan");
  const receipts = latestCapabilityReceipts(events, beforeSequence);
  const eligible = new Set(
    adapterPlan.targets
      .filter(
        (target) =>
          plan.target_dispositions.find((row) => row.target_id === target.target_id)?.execution ===
            "host" &&
          adapterPlan.steps
            .filter((step) => step.target_ids.includes(target.target_id))
            .every(
              (step) =>
                receipts.get(`${adapterPlan.plan_id}\0${step.step_id}`)?.state === "applied",
            ),
      )
      .map((target) => target.target_id),
  );
  return adapterPlan.health_plan
    .flatMap((probe) =>
      probe.target_ids
        .filter((targetId) => eligible.has(targetId))
        .map((targetId) => `${targetId}\0${probe.probe_id}`),
    )
    .sort(bytewise);
}

function assertHealthObservationClosure(
  storage: CapabilityStorageV1,
  plan: CapabilityFabricPlanV1,
  events: readonly CapabilityWalEventV1[],
): void {
  const batches = resolveHealthObservationBatches(storage, events);
  let planCursor = 0;
  for (const batch of batches) {
    const first = batch.events[0];
    if (!first) corrupt("selected health observation has no WAL row");
    while (planCursor < plan.adapter_plans.length) {
      const candidate = plan.adapter_plans[planCursor];
      if (!candidate) break;
      if (expectedHealthKeys(plan, events, candidate.plan_id, first.sequence).length > 0) break;
      planCursor += 1;
    }
    if (plan.adapter_plans[planCursor]?.plan_id !== batch.observation.plan_id)
      corrupt("health observation batches escaped approved dense plan order");
    const expected = expectedHealthKeys(plan, events, batch.observation.plan_id, first.sequence);
    const observed = batch.observation.results
      .map((row) => `${row.target_id}\0${row.probe_id}`)
      .sort(bytewise);
    if (!same(expected, observed))
      corrupt("retained health observation differs from its eligible approved key set");
    planCursor += 1;
  }
}

function remainingHealthFrontier(
  storage: CapabilityStorageV1,
  plan: CapabilityFabricPlanV1,
  events: readonly CapabilityWalEventV1[],
  beforeSequence: number,
): { plan_id: string; target_ids: string[] } | null {
  const batches = resolveHealthObservationBatches(
    storage,
    events.filter((event) => event.sequence < beforeSequence),
  );
  if (batches.some((batch) => !batch.complete))
    corrupt("a post-health frontier follows an incomplete health observation");
  let batchCursor = 0;
  for (const adapterPlan of plan.adapter_plans) {
    const selected = batches[batchCursor];
    if (selected?.observation.plan_id === adapterPlan.plan_id) {
      batchCursor += 1;
      continue;
    }
    const expected = expectedHealthKeys(plan, events, adapterPlan.plan_id, beforeSequence);
    if (expected.length === 0) continue;
    if (selected) corrupt("completed health observations escaped approved dense plan order");
    return {
      plan_id: adapterPlan.plan_id,
      target_ids: [...new Set(expected.map((key) => key.slice(0, key.indexOf("\0"))))].sort(
        bytewise,
      ),
    };
  }
  if (batchCursor !== batches.length)
    corrupt("completed health observations escaped the approved plan closure");
  return null;
}

function assertCheckpointClosure(
  storage: CapabilityStorageV1,
  baseLock: CapabilityLockV1 | null,
  events: readonly CapabilityWalEventV1[],
): void {
  const checkpoints = events.filter((event) => event.payload.kind === "lock-checkpoint");
  const prepared = events.find((event) => event.payload.kind === "health-inventory-prepared");
  if (baseLock === null && checkpoints.length > 0)
    corrupt("initial capability operation contains a prior-lock checkpoint");
  if (checkpoints.length > 1) corrupt("capability operation contains duplicate checkpoints");
  const selected = checkpoints[0];
  validateCapabilityLockCheckpoint({
    storage,
    base: baseLock,
    payload: selected?.payload.kind === "lock-checkpoint" ? selected.payload : null,
    required: prepared !== undefined,
  });
  if (!selected) return;
  const lastEffectOrHealth = events
    .filter(
      (event) =>
        event.payload.kind === "health" ||
        (event.payload.kind === "adapter-step" &&
          !["reverse_in_progress", "reversed"].includes(event.payload.receipt.state)),
    )
    .at(-1);
  if (
    (lastEffectOrHealth && selected.sequence <= lastEffectOrHealth.sequence) ||
    (prepared && selected.sequence >= prepared.sequence)
  )
    corrupt("capability lock checkpoint is outside its final publication frontier");
}

function selectedHealth(
  events: readonly CapabilityWalEventV1[],
  beforeSequence: number,
): Map<string, Extract<CapabilityWalEventV1["payload"], { kind: "health" }>> {
  const selected = new Map<string, Extract<CapabilityWalEventV1["payload"], { kind: "health" }>>();
  for (const event of events) {
    if (event.sequence >= beforeSequence) break;
    if (event.payload.kind === "health")
      selected.set(
        healthKey(event.payload.plan_id, event.payload.probe_id, event.payload.target_id),
        event.payload,
      );
  }
  return selected;
}

function assertPublicationReady(
  plan: CapabilityFabricPlanV1,
  events: readonly CapabilityWalEventV1[],
  sequence: number,
): void {
  const receipts = latestCapabilityReceipts(events, sequence);
  const health = selectedHealth(events, sequence);
  for (const adapterPlan of plan.adapter_plans) {
    const appliedTargets = new Set<string>();
    for (const step of adapterPlan.steps) {
      const receipt = receipts.get(`${adapterPlan.plan_id}\0${step.step_id}`);
      if (!receipt || !["applied", "failed", "reversed"].includes(receipt.state))
        corrupt("lock publication precedes a terminal receipt chain");
      if (receipt.state === "applied")
        for (const targetId of step.target_ids) appliedTargets.add(targetId);
      if (
        receipt.state === "failed" &&
        step.target_ids.some(
          (targetId) =>
            plan.targets.find((target) => target.target_id === targetId)?.target.required,
        )
      )
        corrupt("lock publication follows a required apply failure");
    }
    for (const probe of adapterPlan.health_plan) {
      for (const targetId of probe.target_ids) {
        if (adapterPlan.steps.length > 0 && !appliedTargets.has(targetId)) continue;
        const row = health.get(healthKey(adapterPlan.plan_id, probe.probe_id, targetId));
        if (!row) corrupt("lock publication precedes complete health evidence");
        if (probe.required && row.outcome !== "ready")
          corrupt("lock publication follows failed required health");
      }
    }
  }
}

function assertRefusal(
  storage: CapabilityStorageV1,
  header: CapabilityOperationV1,
  plan: CapabilityFabricPlanV1,
  refusal: Extract<CapabilityWalEventV1["payload"], { kind: "pre-effect-refusal" }>["refusal"],
  recordedAt: string,
  events: readonly CapabilityWalEventV1[],
  sequence: number,
): void {
  if (refusal.operation_id !== header.operation_id) corrupt("refusal operation identity mismatch");
  const observation = readCapabilityPreEffectObservation(storage, refusal.observation_digest);
  const copied = {
    operation_id: observation.operation_id,
    frontier_kind: observation.frontier_kind,
    plan_id: observation.plan_id,
    step_id: observation.step_id,
    target_ids: observation.row.target_ids,
    reason_code: observation.row.reason_code,
    binding_key: observation.row.binding_key,
    expected_digest: observation.row.expected_digest,
    observed_digest: observation.row.observed_digest,
    observed_state: observation.row.observed_state,
    checked_at: observation.checked_at,
    observation_digest: observation.observation_digest,
  };
  const { schema_version: _, ...refusalWithoutSchema } = refusal;
  if (!same(copied, refusalWithoutSchema) || refusal.checked_at !== recordedAt)
    corrupt("pre-effect refusal differs from its immutable observation");
  if (refusal.frontier_kind === "operation" || refusal.frontier_kind === "lock-publication") {
    if (!same(refusal.target_ids, hostTargetIds(plan)))
      corrupt("scope refusal target set escaped the header host closure");
    if (observation.row.plan_order !== null || observation.row.unit_order !== null)
      corrupt("global pre-effect refusal has adapter-local ordering");
    if (
      refusal.frontier_kind === "lock-publication" &&
      remainingHealthFrontier(storage, plan, events, sequence) !== null
    )
      corrupt("lock publication refusal preceded the complete dense health frontier");
    return;
  }
  const adapterPlan = plan.adapter_plans.find((row) => row.plan_id === refusal.plan_id);
  if (!adapterPlan) corrupt("refusal names an unknown adapter plan");
  const healthFrontier =
    refusal.frontier_kind === "health-batch"
      ? remainingHealthFrontier(storage, plan, events, sequence)
      : null;
  if (refusal.frontier_kind === "health-batch" && healthFrontier?.plan_id !== adapterPlan.plan_id)
    corrupt("health refusal escaped the approved dense health frontier");
  const expected =
    refusal.frontier_kind === "adapter-step"
      ? adapterPlan.steps.find((row) => row.step_id === refusal.step_id)?.target_ids
      : healthFrontier?.target_ids;
  if (!expected || !same(refusal.target_ids, expected))
    corrupt("refusal target set escaped its approved frontier");
  if (
    observation.row.plan_order !== plan.adapter_plans.indexOf(adapterPlan) ||
    observation.row.unit_order !==
      (refusal.step_id === null
        ? null
        : (adapterPlan.steps.find((row) => row.step_id === refusal.step_id)?.order ?? null))
  )
    corrupt("pre-effect observation ordering escaped the approved frontier");
}

export function assertCapabilityWalReferentialClosure(
  storage: CapabilityStorageV1,
  header: CapabilityOperationV1,
  plan: CapabilityFabricPlanV1,
  events: readonly CapabilityWalEventV1[],
  baseLock: CapabilityLockV1 | null,
): void {
  for (const adapterPlan of plan.adapter_plans) {
    if (
      adapterPlan.steps.some((step, index) => step.order !== index) ||
      adapterPlan.steps.some((step) =>
        step.target_ids.some(
          (targetId) => !adapterPlan.targets.some((target) => target.target_id === targetId),
        ),
      )
    )
      corrupt("approved adapter plan has non-dense or foreign step closure");
  }
  assertCapabilityForwardReceiptOrder(plan, events);
  assertHealthObservationClosure(storage, plan, events);
  assertCheckpointClosure(storage, baseLock, events);
  const priorReceipts = new Map<string, AdapterReceiptV1>();
  for (const event of events) {
    if (event.operation_id !== header.operation_id)
      corrupt("WAL event operation identity mismatch");
    if (event.payload.kind === "adapter-step") {
      const receipt = event.payload.receipt;
      const key = capabilityReceiptKey(receipt);
      assertCapabilityReceipt(storage, header, plan, receipt, priorReceipts.get(key));
      priorReceipts.set(key, receipt);
    } else if (event.payload.kind === "pre-effect-refusal")
      assertRefusal(
        storage,
        header,
        plan,
        event.payload.refusal,
        event.recorded_at,
        events,
        event.sequence,
      );
    else if (event.payload.kind === "health") {
      const payload = event.payload;
      const adapterPlan = plan.adapter_plans.find((row) => row.plan_id === payload.plan_id);
      const probe = adapterPlan?.health_plan.find(
        (row) => row.probe_id === payload.probe_id && row.target_ids.includes(payload.target_id),
      );
      const disposition = plan.target_dispositions.find(
        (row) => row.target_id === payload.target_id,
      );
      if (!adapterPlan || !probe || disposition?.execution !== "host")
        corrupt("health row escaped its approved host probe");
      const receipts = latestCapabilityReceipts(events, event.sequence);
      if (
        adapterPlan.steps.some(
          (step) =>
            step.target_ids.includes(payload.target_id) &&
            receipts.get(`${adapterPlan.plan_id}\0${step.step_id}`)?.state !== "applied",
        )
      )
        corrupt("health row precedes applied target receipts");
    } else if (
      event.payload.kind === "health-inventory-prepared" ||
      event.payload.kind === "lock-commit"
    )
      assertPublicationReady(plan, events, event.sequence);
  }
  assertCapabilityPublicationEvidence({ storage, plan, events });
}
