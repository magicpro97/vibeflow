import type { PublicTargetResultV1 } from "../../actions/public-types.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import type { CapabilityAdapterPlanV1, CapabilityFabricPlanV1 } from "../planning/types.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import type { AdapterReceiptV1, CapabilityWalEventV1 } from "../wire/operation.js";
import { bytewise } from "../wire/primitives.js";
import { CapabilityRuntimeError } from "./errors.js";

type TerminalState = "committing" | "succeeded" | "failed" | "needs_recovery";
type ReceiptRow = { sequence: number; receipt: AdapterReceiptV1 };
type HealthRow = {
  sequence: number;
  planOrder: number;
  probeOrder: number;
  required: boolean;
  row: Extract<CapabilityWalEventV1["payload"], { kind: "health" }>;
};

const HEALTH_SEVERITY = {
  ready: 0,
  degraded: 1,
  unknown: 2,
  stale: 3,
  failed: 4,
} as const;

function corrupt(message: string): never {
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

function receiptRows(events: CapabilityWalEventV1[], targetId: string): ReceiptRow[] {
  return events.flatMap((event) => {
    if (
      event.payload.kind !== "adapter-step" ||
      !event.payload.receipt.target_ids.includes(targetId)
    )
      return [];
    return [{ sequence: event.sequence, receipt: event.payload.receipt }];
  });
}

function selectedChains(rows: ReceiptRow[]): ReceiptRow[] {
  const selected = new Map<string, ReceiptRow>();
  for (const row of rows) selected.set(`${row.receipt.plan_id}\0${row.receipt.step_id}`, row);
  return [...selected.values()];
}

function healthRows(
  plan: CapabilityFabricPlanV1,
  events: CapabilityWalEventV1[],
  targetId: string,
): HealthRow[] {
  const selected = new Map<string, HealthRow>();
  for (const event of events) {
    if (event.payload.kind !== "health" || event.payload.target_id !== targetId) continue;
    const payload = event.payload;
    const planOrder = plan.adapter_plans.findIndex((row) => row.plan_id === payload.plan_id);
    const adapterPlan = plan.adapter_plans[planOrder];
    const probeOrder =
      adapterPlan?.health_plan.findIndex(
        (row) => row.probe_id === payload.probe_id && row.target_ids.includes(targetId),
      ) ?? -1;
    const probe = adapterPlan?.health_plan[probeOrder];
    if (
      planOrder < 0 ||
      probeOrder < 0 ||
      !probe ||
      Date.parse(payload.expires_at) - Date.parse(payload.checked_at) !==
        probe.evidence_valid_for_ms
    )
      corrupt("health result escaped its approved probe closure");
    const key = `${planOrder}\0${probeOrder}\0${targetId}`;
    const prior = selected.get(key);
    if (prior) {
      const priorTime = Date.parse(prior.row.checked_at);
      const nextTime = Date.parse(payload.checked_at);
      if (
        nextTime < priorTime ||
        (nextTime === priorTime && canonicalJson(prior.row) !== canonicalJson(payload))
      )
        corrupt("health reconciliation is ambiguous");
      if (nextTime === priorTime) continue;
    }
    selected.set(key, {
      sequence: event.sequence,
      planOrder,
      probeOrder,
      required: probe.required,
      row: payload,
    });
  }
  return [...selected.values()].sort(
    (left, right) =>
      left.planOrder - right.planOrder ||
      left.probeOrder - right.probeOrder ||
      bytewise(left.row.target_id, right.row.target_id),
  );
}

function healthWitness(rows: HealthRow[]): HealthRow | null {
  return (
    [...rows].sort(
      (left, right) =>
        HEALTH_SEVERITY[right.row.outcome] - HEALTH_SEVERITY[left.row.outcome] ||
        left.planOrder - right.planOrder ||
        left.probeOrder - right.probeOrder ||
        bytewise(left.row.target_id, right.row.target_id),
    )[0] ?? null
  );
}

function declaredHealth(
  plan: CapabilityFabricPlanV1,
  targetId: string,
): Array<{ planOrder: number; probeOrder: number; required: boolean }> {
  return plan.adapter_plans.flatMap((adapterPlan, planOrder) =>
    adapterPlan.health_plan.flatMap((probe, probeOrder) =>
      probe.target_ids.includes(targetId)
        ? [{ planOrder, probeOrder, required: probe.required }]
        : [],
    ),
  );
}

function noOpWitness(
  plan: CapabilityFabricPlanV1,
  targetId: string,
  base: CapabilityLockV1 | null,
): string | null {
  const covering = plan.adapter_plans.filter((row) =>
    row.targets.some((target) => target.target_id === targetId),
  );
  if (covering.length !== 1) return null;
  const adapterPlan = covering[0] as CapabilityAdapterPlanV1;
  if (
    adapterPlan.steps.some((step) => step.target_ids.includes(targetId)) ||
    adapterPlan.health_plan.some((probe) => probe.target_ids.includes(targetId))
  )
    return null;
  const snapshot = plan.runtime_closure.snapshots.find(
    (row) => row.snapshot_digest === adapterPlan.inspection_snapshot_digest,
  );
  const state = snapshot?.target_states.find((row) => row.target_id === targetId);
  const target = plan.targets.find((row) => row.target_id === targetId);
  if (!target || target.subject.kind !== "capability" || !base) return null;
  const subject = target.subject;
  const baseEntry = base.packages.find((row) => row.package_id === subject.package_id);
  const baseTarget = baseEntry?.targets.find((row) => row.target_id === targetId);
  const pkg = plan.runtime_closure.packages.find((row) => row.pin.id === subject.package_id);
  if (!baseEntry || !baseTarget || !pkg || state?.state !== "owned") return null;
  const portablePackage = {
    package_id: pkg.pin.id,
    pin: pkg.pin,
    manifest_digest: pkg.manifest_digest,
    authenticity_binding: pkg.authenticity_binding,
    dependencies: pkg.dependencies,
    public_inputs: pkg.public_inputs,
    secret_input_ids: pkg.secret_input_ids,
  };
  const portableBase = {
    package_id: baseEntry.package_id,
    pin: baseEntry.pin,
    manifest_digest: baseEntry.manifest_digest,
    authenticity_binding: baseEntry.authenticity_binding,
    dependencies: baseEntry.dependencies,
    public_inputs: baseEntry.public_inputs,
    secret_input_ids: baseEntry.secret_input_ids,
  };
  const permissionRows = plan.permission_binding.permissions.filter((row) =>
    row.target_ids.includes(targetId),
  );
  const expectedEnforcement = digestV1("VF-TARGET-ENFORCEMENT\0v1\0", {
    schema_version: "1.0",
    target_id: targetId,
    permissions: permissionRows,
  });
  const expectedHealth = digestV1("VF-TARGET-HEALTH-PLAN\0v1\0", {
    schema_version: "1.0",
    target_id: targetId,
    health: [],
  });
  if (
    canonicalJson(portablePackage) !== canonicalJson(portableBase) ||
    base.permission_digest !== plan.permission_digest ||
    baseTarget.state !== "installed" ||
    canonicalJson(baseTarget.adapter_fingerprints) !==
      canonicalJson([adapterPlan.adapter.fingerprint]) ||
    baseTarget.enforcement_digest !== expectedEnforcement ||
    baseTarget.health_plan_digest !== expectedHealth ||
    canonicalJson(state.live_projection_digests) !==
      canonicalJson(baseTarget.projections.map((row) => row.projection_digest).sort(bytewise))
  )
    return null;
  return snapshot?.ownership_evidence_digest ?? null;
}

function nonHostOutcome(
  execution: "manual" | "required-user-action" | "unsupported",
): PublicTargetResultV1["outcome"] {
  return execution;
}

export function foldCapabilityTarget(input: {
  plan: CapabilityFabricPlanV1;
  events: CapabilityWalEventV1[];
  targetId: string;
  terminal: TerminalState;
  baseLock: CapabilityLockV1 | null;
}): PublicTargetResultV1 {
  const { plan, events, targetId, terminal, baseLock } = input;
  const target = plan.targets.find((row) => row.target_id === targetId);
  const disposition = plan.target_dispositions.find((row) => row.target_id === targetId);
  if (!target || !disposition) corrupt("operation target closure is incomplete");
  const receipts = receiptRows(events, targetId);
  const health = healthRows(plan, events, targetId);
  const publicHealth = healthWitness(health)?.row.outcome ?? "unknown";
  if (disposition.execution !== "host") {
    if (receipts.length > 0 || health.length > 0)
      corrupt("non-host target acquired host runtime evidence");
    return {
      ...target,
      outcome: nonHostOutcome(disposition.execution),
      health: "unknown",
      evidence_digest: null,
    };
  }
  const chains = selectedChains(receipts);
  const unresolved = chains.filter((row) =>
    ["effect_in_progress", "reverse_in_progress", "uncertain"].includes(row.receipt.state),
  );
  if (unresolved.length > 1) corrupt("target has multiple unresolved receipt chains");
  if (unresolved[0])
    return {
      ...target,
      outcome: "needs-recovery",
      health: publicHealth,
      evidence_digest: unresolved[0].receipt.bounded_evidence_digest,
    };
  const failed = receipts.find((row) => row.receipt.state === "failed");
  const causalHealth = healthWitness(
    health.filter((row) => row.required && row.row.outcome !== "ready"),
  );
  if (failed)
    return {
      ...target,
      outcome: target.target.required ? "failed" : "omitted",
      health: publicHealth,
      evidence_digest: failed.receipt.bounded_evidence_digest,
    };
  if (causalHealth) {
    const outcome = target.target.required
      ? "failed"
      : target.target.on_health_failure === "commit-degraded"
        ? "degraded"
        : "omitted";
    return {
      ...target,
      outcome,
      health: publicHealth,
      evidence_digest: causalHealth.row.evidence_digest,
    };
  }
  const reversed = [...receipts].reverse().find((row) => row.receipt.state === "reversed");
  if (reversed)
    return {
      ...target,
      outcome: "reversed",
      health: publicHealth,
      evidence_digest: reversed.receipt.bounded_evidence_digest,
    };
  const steps = plan.adapter_plans.flatMap((row) =>
    row.steps.filter((step) => step.target_ids.includes(targetId)),
  );
  const declared = declaredHealth(plan, targetId);
  const requiredDeclared = declared.filter((row) => row.required);
  const requiredComplete = requiredDeclared.every((expected) =>
    health.some(
      (row) =>
        row.planOrder === expected.planOrder &&
        row.probeOrder === expected.probeOrder &&
        row.row.outcome === "ready",
    ),
  );
  const applied = [...receipts].reverse().find((row) => row.receipt.state === "applied");
  const requiredSuccess = requiredComplete
    ? healthWitness(health.filter((row) => row.required && row.row.outcome === "ready"))
    : null;
  const optionalProbeOnly =
    steps.length === 0 && health.length > 0 && health.every((row) => !row.required)
      ? healthWitness(health)
      : null;
  const inspection = noOpWitness(plan, targetId, baseLock);
  const allApplied =
    steps.length > 0 &&
    chains.length === steps.length &&
    chains.every((row) => row.receipt.state === "applied") &&
    requiredComplete;
  const requiredProbeOnly = steps.length === 0 && requiredDeclared.length > 0 && requiredComplete;
  if (allApplied || requiredProbeOnly || optionalProbeOnly || inspection)
    return {
      ...target,
      outcome: "applied",
      health: publicHealth,
      evidence_digest:
        requiredSuccess?.row.evidence_digest ??
        applied?.receipt.bounded_evidence_digest ??
        optionalProbeOnly?.row.evidence_digest ??
        inspection,
    };
  if (terminal !== "succeeded")
    return { ...target, outcome: "blocked", health: publicHealth, evidence_digest: null };
  return corrupt("successful host target has no causal terminal witness");
}
