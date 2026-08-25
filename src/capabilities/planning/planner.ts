import type { LegacySourceV1 } from "../../actions/legacy-adopt-types.js";
import type {
  ActionTargetBindingV1,
  CapabilityTargetDispositionV1,
} from "../../actions/preview-types.js";
import type { ActionEffectClass, Reversibility } from "../../actions/types.js";
import { digestV1 } from "../../durability/index.js";
import {
  CAPABILITY_ADAPTER_REGISTRY_V1,
  resolveCapabilityAdapter,
  resolveLegacyAdoptionAdapter,
} from "../adapters/registry.js";
import type { CapabilityEffectBrokerV1, CapabilityEffectDescriptorV1 } from "../adapters/types.js";
import { permissionBindingDigest, permissionDelta } from "../permissions/index.js";
import { bytewise } from "../wire/primitives.js";
import { capabilityActionDigest } from "./action-materialization.js";
import { buildHostAdapterPlan, buildNonHostAdapterPlan } from "./component-planner.js";
import { buildTargetBinding, resolveTargetDisposition } from "./component-target.js";
import { assembleCapabilityDurablePlanningGraph } from "./execution-graph.js";
import { finalizeCapabilityExecutionPlans } from "./execution-plan-finalization.js";
import { isProvedCapabilityNoOp } from "./no-op.js";
import { buildOrphanRemovalPlans } from "./orphan-planner.js";
import { buildPermissionBinding, validateCapabilityPlanningRequest } from "./request-validation.js";
import type {
  CapabilityAdapterPlanV1,
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
  CapabilityPlanningRequestV1,
  CapabilityProjectionSnapshotV1,
  ResolvedCapabilityPackageV1,
} from "./types.js";

function selectedTargets(
  request: CapabilityPlanningRequestV1,
  packageId: string,
  componentEngines: readonly import("../../actions/types.js").EngineName[],
): Array<{ engine: import("../../actions/types.js").EngineName; participant_id: string | null }> {
  const selected = request.selected_targets
    ? request.selected_targets
        .filter(
          (target) => target.package_id === packageId && componentEngines.includes(target.engine),
        )
        .map(({ engine, participant_id }) => ({ engine, participant_id }))
    : componentEngines
        .filter((engine) => request.selected_engines.includes(engine))
        .map((engine) => ({ engine, participant_id: null }));
  return selected.sort((left, right) =>
    bytewise(
      `${left.engine}\0${left.participant_id ?? ""}`,
      `${right.engine}\0${right.participant_id ?? ""}`,
    ),
  );
}

const EFFECT_ORDER: ActionEffectClass[] = [
  "pure-local-read",
  "local-read-with-cache",
  "network-read",
  "process-probe",
  "project-write",
  "user-write",
  "external-compensatable",
  "external-irreversible",
];
const REVERSIBILITY: Reversibility[] = ["reversible", "compensatable", "manual", "irreversible"];

export function buildCapabilityPlan(
  request: CapabilityPlanningRequestV1,
  broker: CapabilityEffectBrokerV1,
  now: string,
  persistence: "transient" | "durable" = "transient",
): CapabilityFabricPlanV1 {
  return buildCapabilityPlanningGraph(request, broker, now, persistence).plan;
}

export function buildCapabilityPlanningGraph(
  request: CapabilityPlanningRequestV1,
  broker: CapabilityEffectBrokerV1,
  now: string,
  persistence: "transient" | "durable" = "transient",
): CapabilityDurablePlanningGraphV1 {
  validateCapabilityPlanningRequest(request);
  const actionRootLocator = request.action_root_locator ?? {
    kind: "capability" as const,
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
  };
  const effectPackages = request.effect_packages ?? request.desired_packages;
  const targets = effectPackages
    .flatMap((pkg) =>
      pkg.manifest.components.flatMap((component) =>
        selectedTargets(request, pkg.pin.id, component.targets).map((target) =>
          buildTargetBinding(pkg, component, target.engine, request.scope, target.participant_id),
        ),
      ),
    )
    .sort((left, right) => bytewise(left.target_id, right.target_id));
  const binding = buildPermissionBinding(request.desired_packages, targets);
  const permission_digest = permissionBindingDigest(binding);
  const plans: CapabilityAdapterPlanV1[] = [];
  const snapshots: CapabilityProjectionSnapshotV1[] = [];
  const descriptors: CapabilityEffectDescriptorV1[] = [];
  const privateDescriptors: import("../adapters/types.js").CapabilityAdapterPrivateDescriptorV1[] =
    [];
  const privatePreimages: Array<{
    resource: import("../adapters/types.js").CapabilityOwnedResourceV1;
    bytes: Uint8Array;
  }> = [];
  const privateInspectionEvidence = new Map<string, Uint8Array>();
  const target_dispositions: CapabilityTargetDispositionV1[] = [];
  for (const pkg of effectPackages) {
    for (const component of pkg.manifest.components) {
      for (const selected of selectedTargets(request, pkg.pin.id, component.targets)) {
        const { engine, participant_id } = selected;
        const target = targets.find(
          (item) =>
            item.subject.kind === "capability" &&
            item.subject.package_id === pkg.pin.id &&
            item.subject.component_id === component.component_id &&
            item.target.engine === engine &&
            item.target.participant_id === participant_id,
        ) as ActionTargetBindingV1;
        const adoptingPackage =
          request.intent.kind === "adopt" &&
          request.adopt_candidate?.synthetic_pin.pin_digest === pkg.pin.pin_digest;
        const entry = adoptingPackage
          ? {
              component_type: component.type,
              engine,
              ...resolveLegacyAdoptionAdapter(
                request.adopt_candidate?.legacy_source as LegacySourceV1,
              ),
            }
          : resolveCapabilityAdapter(component.type, engine);
        const resolvedDisposition = adoptingPackage
          ? { target_id: target.target_id, execution: "host" as const, reason_code: null }
          : resolveTargetDisposition(
              entry,
              target.target_id,
              component,
              participant_id,
              request.scope,
            );
        target_dispositions.push(resolvedDisposition);
        if (entry.adapter === null || resolvedDisposition.execution === "unsupported") continue;
        if (resolvedDisposition.execution !== "host") {
          const empty = buildNonHostAdapterPlan({
            request,
            pkg,
            component,
            target,
            adapter: entry.adapter,
            now,
          });
          empty.plan.authority.permission_digest = permission_digest;
          plans.push(empty.plan);
          snapshots.push(empty.snapshot);
          continue;
        }
        const built = buildHostAdapterPlan({
          request,
          pkg,
          component,
          target,
          adapter: entry.adapter,
          broker,
          now,
          persistence,
        });
        built.plan.authority.permission_digest = permission_digest;
        plans.push(built.plan);
        snapshots.push(built.snapshot);
        descriptors.push(...built.descriptors);
        privateDescriptors.push(...built.private_descriptors);
        privatePreimages.push(...built.private_preimages);
        if (built.private_inspection_evidence_bytes)
          privateInspectionEvidence.set(
            built.snapshot.snapshot_digest,
            built.private_inspection_evidence_bytes,
          );
      }
    }
  }
  const orphaned = buildOrphanRemovalPlans({
    request,
    effectPackages,
    plannedSnapshots: snapshots,
    broker,
    now,
    persistence,
  });
  for (const target of orphaned.targets)
    if (!targets.some((row) => row.target_id === target.target_id)) targets.push(target);
  for (const resolvedDisposition of orphaned.dispositions)
    if (!target_dispositions.some((row) => row.target_id === resolvedDisposition.target_id))
      target_dispositions.push(resolvedDisposition);
  for (const plan of orphaned.plans) plan.authority.permission_digest = permission_digest;
  plans.push(...orphaned.plans);
  snapshots.push(...orphaned.snapshots);
  descriptors.push(...orphaned.descriptors);
  privateDescriptors.push(...orphaned.private_descriptors);
  privatePreimages.push(...orphaned.private_preimages);
  targets.sort((left, right) => bytewise(left.target_id, right.target_id));
  const finalized = finalizeCapabilityExecutionPlans({
    request,
    plans,
    snapshots,
    packages: effectPackages,
    permissionBinding: binding,
    now,
    privateInspectionEvidence,
  });
  const finalizedPlans = finalized.plans.sort((left, right) =>
    bytewise(left.plan_id, right.plan_id),
  );
  const finalizedSnapshots = finalized.snapshots.sort((left, right) =>
    bytewise(left.snapshot_digest, right.snapshot_digest),
  );
  descriptors.sort((left, right) => bytewise(left.descriptor_digest, right.descriptor_digest));
  target_dispositions.sort((left, right) => bytewise(left.target_id, right.target_id));
  const adapter_set_digest = digestV1("VF-ADAPTER-SET\0v1\0", {
    schema_version: "1.0",
    adapter_registry_digest: CAPABILITY_ADAPTER_REGISTRY_V1.registry_digest,
    adapters: finalizedPlans.map((plan) => ({
      ...plan.adapter,
      target_ids: plan.targets.map((target) => target.target_id),
    })),
  });
  const safePackage = ({
    files: _,
    private_input_execution: __,
    source_execution: ___,
    ...pkg
  }: ResolvedCapabilityPackageV1) => structuredClone(pkg);
  const packages = request.desired_packages.map(safePackage);
  const closureEffectPackages = effectPackages.map(safePackage);
  const effect_classes = EFFECT_ORDER.filter((effect) =>
    finalizedPlans.some((plan) => plan.steps.some((step) => step.effect_classes.includes(effect))),
  );
  const reversibility = REVERSIBILITY[
    Math.max(0, ...finalizedPlans.map((plan) => REVERSIBILITY.indexOf(plan.reversibility)))
  ] as Reversibility;
  const possibleSurvivors = target_dispositions.filter((row) => row.execution === "host").length;
  const hasRequiredNonHost = target_dispositions.some(
    (row) =>
      row.execution !== "host" &&
      targets.find((target) => target.target_id === row.target_id)?.target.required,
  );
  const effectCount = finalizedPlans.reduce((sum, plan) => sum + plan.steps.length, 0);
  const provedNoOp = isProvedCapabilityNoOp({
    request,
    plans: finalizedPlans,
    snapshots: finalizedSnapshots,
    dispositions: target_dispositions,
    permissionDigest: permission_digest,
    permissionBinding: binding,
    effectCount,
  });
  const status: CapabilityFabricPlanV1["status"] =
    hasRequiredNonHost || (targets.length > 0 && possibleSurvivors === 0)
      ? "action-required"
      : provedNoOp
        ? "no-op"
        : "planned";
  const planDraft = {
    schema_version: "1.0" as const,
    status,
    intent: request.intent,
    action_binding:
      request.canonical_action === undefined
        ? null
        : {
            schema_version: "1.0" as const,
            action_type: request.canonical_action.type,
            action_digest: capabilityActionDigest(request.canonical_action),
          },
    scope: request.scope,
    scope_identity_digest: request.scope_identity_digest,
    action_root_locator: structuredClone(actionRootLocator),
    base_generation_id: request.base_lock?.generation_id ?? null,
    base_lock_digest: request.base_lock?.content_digest ?? null,
    targets,
    target_dispositions,
    permission_binding: binding,
    permission_digest,
    permission_delta: permissionDelta(
      request.current_permissions?.permissions ?? [],
      binding.permissions,
    ),
    adapter_registry_digest: CAPABILITY_ADAPTER_REGISTRY_V1.registry_digest,
    adapter_set_digest,
    source_authority_set_digest: request.authority.source_authority_set_digest,
    effect_classes,
    reversibility,
    adapter_plans: finalizedPlans,
    runtime_closure: {
      authority: structuredClone(request.authority),
      adapter_registry: CAPABILITY_ADAPTER_REGISTRY_V1,
      packages,
      effect_packages: closureEffectPackages,
      snapshots: finalizedSnapshots,
      inspection_evidence: finalized.evidence,
      descriptors,
    },
    created_at: now,
  };
  const adapterSet = {
    schema_version: "1.0" as const,
    adapter_registry_digest: CAPABILITY_ADAPTER_REGISTRY_V1.registry_digest,
    adapters: finalizedPlans.map((plan) => ({
      ...plan.adapter,
      target_ids: plan.targets.map((target) => target.target_id).sort(bytewise),
    })),
  };
  return assembleCapabilityDurablePlanningGraph({
    request,
    planDraft,
    adapterSet,
    snapshots: finalizedSnapshots,
    evidence: finalized.evidence,
    privateDescriptors,
    privatePreimages,
    privateEvidence: finalized.privateEvidence,
    stepEnforcement: finalized.stepEnforcement,
    probeEnforcement: finalized.probeEnforcement,
    packages: effectPackages,
    mode: persistence === "durable" ? "durable-proposal" : "transient-preview",
  });
}
