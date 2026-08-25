import { canonicalJson } from "../../durability/index.js";
import type { CapabilityEffectBrokerV1 } from "../adapters/types.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
} from "../planning/types.js";
import { readCapabilityWal } from "../storage/operation-store.js";
import type { CapabilityScopeLockV1 } from "../storage/scope-lock.js";
import type { AdapterReceiptV1, CapabilityPreEffectRefusalReasonV1 } from "../wire/operation.js";
import { bytewise } from "../wire/primitives.js";
import {
  capabilityAuthorityFrontier,
  capabilityCompensationFrontier,
} from "./authority-frontier.js";
import {
  type AdapterHealthObservationResultV1,
  persistAdapterHealthObservation,
  readAdapterHealthObservation,
} from "./health-evidence.js";
import type { CapabilityOperationJournalV1 } from "./operation-journal.js";
import type {
  CapabilityRuntimeAuthorityReaderV1,
  CapabilityRuntimeFaultPointV1,
  CapabilityRuntimeSourceAuthorityReaderV1,
} from "./types.js";

export interface CapabilityEffectRuntimeOptionsV1 {
  broker: CapabilityEffectBrokerV1;
  authority: CapabilityRuntimeAuthorityReaderV1;
  sourceAuthority?: CapabilityRuntimeSourceAuthorityReaderV1;
  now: () => string;
}

export function runCapabilityHealth(input: {
  plan: CapabilityFabricPlanV1;
  graph: CapabilityDurablePlanningGraphV1;
  operationId: string;
  held: CapabilityScopeLockV1;
  journal: CapabilityOperationJournalV1;
  options: CapabilityEffectRuntimeOptionsV1;
  fault?: ((point: CapabilityRuntimeFaultPointV1) => void) | null;
}): "health-failed" | CapabilityPreEffectRefusalReasonV1 | null {
  const { plan, operationId, held, journal, options } = input;
  for (const adapterPlan of plan.adapter_plans) {
    const receipts = new Map(
      adapterPlan.steps.map((step) => [
        step.step_id,
        journal.latestReceipt(operationId, adapterPlan.plan_id, step.step_id),
      ]),
    );
    const eligibleTargets = new Set(
      adapterPlan.targets
        .filter((target) =>
          adapterPlan.steps
            .filter((step) => step.target_ids.includes(target.target_id))
            .every((step) => receipts.get(step.step_id)?.state === "applied"),
        )
        .map((target) => target.target_id),
    );
    const probes = adapterPlan.health_plan
      .map((probe) => ({
        probe,
        target_ids: probe.target_ids.filter((targetId) => eligibleTargets.has(targetId)),
      }))
      .filter((row) => row.target_ids.length > 0);
    const batchTargetIds = [...new Set(probes.flatMap((row) => row.target_ids))].sort(bytewise);
    const expectedKeys = probes
      .flatMap(({ probe, target_ids }) =>
        target_ids.map((targetId) => `${targetId}\0${probe.probe_id}`),
      )
      .sort(bytewise);
    const existingEvents = readCapabilityWal(journal.options.storage.paths, operationId).filter(
      (event) => event.payload.kind === "health" && event.payload.plan_id === adapterPlan.plan_id,
    );
    const selectedDigest =
      existingEvents[0]?.payload.kind === "health"
        ? existingEvents[0].payload.observation_digest
        : null;
    if (selectedDigest) {
      if (
        existingEvents.some(
          (event) =>
            event.payload.kind !== "health" || event.payload.observation_digest !== selectedDigest,
        )
      )
        throw new Error("initial health frontier selected conflicting observations");
      const retained = readAdapterHealthObservation(journal.options.storage, selectedDigest);
      const observedPrefix = existingEvents.map((event) => {
        if (event.payload.kind !== "health") throw new Error("health event narrowing failed");
        const { kind: _, ...row } = event.payload;
        return row;
      });
      for (let index = 0; index < observedPrefix.length; index += 1) {
        const expected = retained.results[index];
        const observed = observedPrefix[index];
        if (
          !expected ||
          canonicalJson(expected) !==
            canonicalJson({
              target_id: observed?.target_id,
              probe_id: observed?.probe_id,
              outcome: observed?.outcome,
              evidence_digest: observed?.evidence_digest,
              checked_at: observed?.checked_at,
              expires_at: observed?.expires_at,
            })
        )
          throw new Error("health WAL is not an exact retained observation prefix");
      }
      for (const result of retained.results.slice(observedPrefix.length)) {
        journal.append(
          operationId,
          {
            kind: "health",
            plan_id: retained.plan_id,
            observation_digest: retained.observation_digest,
            ...result,
          },
          held,
        );
        input.fault?.("after-health-row");
      }
    }
    const selectedRows = readCapabilityWal(journal.options.storage.paths, operationId)
      .filter(
        (event) => event.payload.kind === "health" && event.payload.plan_id === adapterPlan.plan_id,
      )
      .map((event) => {
        if (event.payload.kind !== "health") throw new Error("health event narrowing failed");
        return event.payload;
      });
    const selectedKeys = selectedRows
      .map((row) => `${row.target_id}\0${row.probe_id}`)
      .sort(bytewise);
    if (selectedRows.length > 0 && canonicalJson(selectedKeys) !== canonicalJson(expectedKeys))
      throw new Error("completed health observation does not cover the eligible probe key set");
    if (selectedRows.length === 0 && probes.length > 0) {
      const frontier = capabilityAuthorityFrontier({
        graph: input.graph,
        options,
        operation: `capability-health:${operationId}:${adapterPlan.plan_id}`,
        onRefusal: (authorityCheck) =>
          journal.appendRefusal({
            operationId,
            plan,
            reason: authorityCheck.reason,
            planId: adapterPlan.plan_id,
            stepId: null,
            targetIds: batchTargetIds,
            held,
            frontier: "health-batch",
            authorityCheck,
          }),
        effect: () => {
          const rows: Array<{
            probe: (typeof probes)[number]["probe"];
            targetId: string;
            health: ReturnType<CapabilityEffectBrokerV1["health"]>;
            checkedAt: string;
            expiresAt: string;
          }> = [];
          for (const { probe, target_ids } of probes)
            for (const targetId of target_ids) {
              const resources = adapterPlan.steps
                .filter((step) => step.target_ids.includes(targetId))
                .flatMap((step) => step.owned_resources);
              const health = options.broker.health({
                target_id: targetId,
                probe_id: probe.probe_id,
                kind: probe.kind,
                expected_resources: resources,
              });
              const checkedAt = options.now();
              const expiresAt = new Date(
                Date.parse(checkedAt) + probe.evidence_valid_for_ms,
              ).toISOString();
              rows.push({ probe, targetId, health, checkedAt, expiresAt });
            }
          const observation = persistAdapterHealthObservation({
            storage: journal.options.storage,
            held,
            planId: adapterPlan.plan_id,
            rows: rows.map(({ probe, targetId, health, checkedAt, expiresAt }) => ({
              evidence: health.evidence,
              result: {
                target_id: targetId,
                probe_id: probe.probe_id,
                outcome: health.outcome,
                checked_at: checkedAt,
                expires_at: expiresAt,
                evidence_digest: health.evidence_digest,
              },
            })),
          });
          input.fault?.("after-health-observation");
          for (const result of observation.results) {
            journal.append(
              operationId,
              {
                kind: "health",
                plan_id: observation.plan_id,
                observation_digest: observation.observation_digest,
                ...result,
              },
              held,
            );
            input.fault?.("after-health-row");
          }
        },
      });
      if (!frontier.authorized) {
        return frontier.reason;
      }
    }
    const evaluated = readCapabilityWal(journal.options.storage.paths, operationId)
      .filter(
        (event) => event.payload.kind === "health" && event.payload.plan_id === adapterPlan.plan_id,
      )
      .map((event) => {
        if (event.payload.kind !== "health") throw new Error("health event narrowing failed");
        return event.payload;
      });
    for (const result of evaluated) {
      const probe = adapterPlan.health_plan.find((row) => row.probe_id === result.probe_id);
      if (!probe) throw new Error("health result escaped the approved plan");
      if (probe.required && result.outcome !== "ready") {
        const target = plan.targets.find((row) => row.target_id === result.target_id)?.target;
        if (!target || target.required) return "health-failed";
        if (target.on_health_failure === "omit-after-rollback") {
          const restored = rollbackAppliedCapabilityEffects({
            plan,
            graph: input.graph,
            operationId,
            held,
            journal,
            options,
            targetIds: new Set([result.target_id]),
          });
          if (!restored) return "health-failed";
        }
      }
    }
  }
  return null;
}

export function rollbackAppliedCapabilityEffects(input: {
  plan: CapabilityFabricPlanV1;
  graph: CapabilityDurablePlanningGraphV1;
  operationId: string;
  held: CapabilityScopeLockV1;
  journal: CapabilityOperationJournalV1;
  options: CapabilityEffectRuntimeOptionsV1;
  targetIds?: ReadonlySet<string>;
}): boolean {
  const { plan, graph, operationId, held, journal, options, targetIds } = input;
  const applied = readCapabilityWal(journal.options.storage.paths, operationId)
    .filter(
      (event) => event.payload.kind === "adapter-step" && event.payload.receipt.state === "applied",
    )
    .map((event) => (event.payload.kind === "adapter-step" ? event.payload.receipt : null))
    .filter((receipt): receipt is AdapterReceiptV1 => receipt !== null)
    .filter(
      (receipt) =>
        journal.latestReceipt(operationId, receipt.plan_id, receipt.step_id)?.state === "applied",
    )
    .filter(
      (receipt) => !targetIds || receipt.target_ids.some((targetId) => targetIds.has(targetId)),
    )
    .reverse();
  for (const receipt of applied) {
    try {
      capabilityCompensationFrontier({
        graph,
        options,
        operation: `capability-rollback:${operationId}:${receipt.step_id}`,
        effect: () => {
          const descriptor = journal.descriptorFor(
            plan,
            receipt.plan_id,
            receipt.step_id,
            "rollback",
          );
          journal.appendReceipt({
            operationId,
            plan,
            planId: receipt.plan_id,
            stepId: receipt.step_id,
            state: "reverse_in_progress",
            evidence: receipt.bounded_evidence_digest,
            error: null,
            held,
          });
          const privatePayload = options.broker.resolvePrivatePayload(
            descriptor.private_payload_binding,
          );
          const observed = options.broker.rollback(descriptor, privatePayload);
          if (observed.content_sha256 !== descriptor.resource.expected_preimage_sha256)
            throw new Error("rollback did not restore the exact preimage");
          const observedAt = options.now();
          journal.appendReceipt({
            operationId,
            plan,
            planId: receipt.plan_id,
            stepId: receipt.step_id,
            state: "reversed",
            evidence: journal.receiptEvidence({
              operationId,
              plan,
              planId: receipt.plan_id,
              stepId: receipt.step_id,
              descriptor,
              state: "reversed",
              error: null,
              observedAt,
              held,
            }),
            error: null,
            observedAt,
            held,
          });
        },
      });
    } catch {
      const descriptor = journal.descriptorFor(plan, receipt.plan_id, receipt.step_id, "rollback");
      if (journal.latestReceipt(operationId, receipt.plan_id, receipt.step_id)?.state === "applied")
        return false;
      const observedAt = options.now();
      journal.appendReceipt({
        operationId,
        plan,
        planId: receipt.plan_id,
        stepId: receipt.step_id,
        state: "uncertain",
        evidence: journal.receiptEvidence({
          operationId,
          plan,
          planId: receipt.plan_id,
          stepId: receipt.step_id,
          descriptor,
          state: "uncertain",
          error: "rollback-failed",
          observedAt,
          held,
        }),
        error: "rollback-failed",
        observedAt,
        held,
      });
      return false;
    }
  }
  return true;
}
