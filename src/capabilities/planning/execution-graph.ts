import { ACTION_EFFECT_CLASSES } from "../../actions/public-action-contract.js";
import { digestV1Bytes } from "../../durability/canonical.js";
import { canonicalJson, canonicalJsonBytes } from "../../durability/index.js";
import type { CapabilityActionPlanBindingV1 } from "../action-domain/types.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityOwnedResourceV1,
} from "../adapters/types.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import { capabilityFabricPlanDigest, executionClosureDigest } from "./digests.js";
import { validateCapabilityPlanningGraph } from "./execution-graph-validation.js";
import type { CapabilityExecutionLedgerMode } from "./execution-ledger-contract.js";
import {
  CAPABILITY_EXECUTION_SCHEMA_ORDER,
  CAPABILITY_RAW_BLOB_KIND_ORDER,
  planningJsonObject,
  planningRawBlob,
} from "./execution-objects.js";
import type {
  CapabilityAdapterBoundedEvidenceV1,
  CapabilityAdapterSetBindingV1,
  CapabilityPlanningJsonObjectV1,
  CapabilityPlanningLedgerV1,
  CapabilityPlanningPrivateInputV1,
  CapabilityPlanningRawBlobV1,
  CapabilityProbeEnforcementBindingV1,
  CapabilityStepEnforcementBindingV1,
} from "./execution-types.js";
import { immutableClone } from "./freeze.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityExecutionObjectClosureV1,
  CapabilityFabricPlanV1,
  CapabilityPlanningRequestV1,
  CapabilityProjectionSnapshotV1,
  ResolvedCapabilityPackageV1,
} from "./types.js";

type FabricPlanDraft = Omit<
  CapabilityFabricPlanV1,
  "execution_closure" | "execution_closure_digest" | "plan_digest"
>;

export function dedupeCapabilityPlanningJsonObjects(
  rows: CapabilityPlanningJsonObjectV1[],
): CapabilityPlanningJsonObjectV1[] {
  const byDigest = new Map<string, CapabilityPlanningJsonObjectV1>();
  for (const row of rows) {
    const prior = byDigest.get(row.binding.object_digest);
    if (
      prior &&
      (prior.binding.object_schema_id !== row.binding.object_schema_id ||
        canonicalJson(prior.value) !== canonicalJson(row.value))
    )
      throw new CapabilityRuntimeError(
        "conflicting execution object digest",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    byDigest.set(row.binding.object_digest, row);
  }
  return [...byDigest.values()].sort((a, b) => {
    const schema =
      CAPABILITY_EXECUTION_SCHEMA_ORDER.indexOf(a.binding.object_schema_id) -
      CAPABILITY_EXECUTION_SCHEMA_ORDER.indexOf(b.binding.object_schema_id);
    return schema || bytewise(a.binding.object_digest, b.binding.object_digest);
  });
}

function dedupeBlobs(rows: CapabilityPlanningRawBlobV1[]): CapabilityPlanningRawBlobV1[] {
  const byDigest = new Map<string, CapabilityPlanningRawBlobV1>();
  for (const row of rows) {
    const prior = byDigest.get(row.binding.content_digest);
    if (
      prior &&
      (canonicalJson(prior.binding) !== canonicalJson(row.binding) ||
        prior.bytes_base64 !== row.bytes_base64)
    )
      throw new CapabilityRuntimeError(
        "conflicting execution blob digest",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    byDigest.set(row.binding.content_digest, row);
  }
  return [...byDigest.values()].sort((a, b) => {
    const kind =
      CAPABILITY_RAW_BLOB_KIND_ORDER.indexOf(a.binding.blob_kind) -
      CAPABILITY_RAW_BLOB_KIND_ORDER.indexOf(b.binding.blob_kind);
    return kind || bytewise(a.binding.content_digest, b.binding.content_digest);
  });
}

function privateInputs(
  packages: readonly ResolvedCapabilityPackageV1[],
): CapabilityPlanningPrivateInputV1[] {
  const rows = new Map<string, CapabilityPlanningPrivateInputV1>();
  for (const pkg of packages) {
    const binding = pkg.private_input_execution;
    if (!binding || binding.binding_digest !== pkg.private_input_binding_digest)
      throw new CapabilityRuntimeError(
        "package lacks exact private input execution binding",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    if (binding.record === null) continue;
    const ref = `actions/v1/private-input-bindings/${binding.record.private_binding_id}.json`;
    const row = {
      stratum: 1 as const,
      binding_digest: binding.binding_digest,
      binding_ref: ref,
      record: structuredClone(binding.record),
    };
    const prior = rows.get(binding.binding_digest);
    if (prior && canonicalJson(prior.record) !== canonicalJson(row.record))
      throw new CapabilityRuntimeError(
        "conflicting private input binding",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    rows.set(binding.binding_digest, row);
  }
  return [...rows.values()].sort((a, b) => bytewise(a.binding_digest, b.binding_digest));
}

function actionPlan(
  request: CapabilityPlanningRequestV1,
  draft: FabricPlanDraft,
  closureDigest: string,
): CapabilityActionPlanBindingV1 {
  if (!request.source_request_context)
    throw new CapabilityRuntimeError(
      "source request context is absent",
      CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
    );
  const effectOrder = ACTION_EFFECT_CLASSES;
  return {
    schema_version: "1.0",
    domain: "capability",
    action_root_locator: structuredClone(draft.action_root_locator),
    planning_options: structuredClone(request.source_request_context.planning_options),
    execution_object_closure_digest: closureDigest,
    permission_digest: draft.permission_digest,
    steps: draft.adapter_plans.map((plan, order) => ({
      order,
      step_id: plan.plan_id,
      plan_kind: "capability-adapter",
      plan_digest: plan.plan_digest,
      target_ids: plan.targets.map((target) => target.target_id).sort(bytewise),
      effect_classes: effectOrder.filter((effect) =>
        plan.steps.some((step) => step.effect_classes.includes(effect)),
      ),
      reversibility: plan.reversibility,
    })),
  };
}

export function assembleCapabilityDurablePlanningGraph(input: {
  request: CapabilityPlanningRequestV1;
  planDraft: FabricPlanDraft;
  adapterSet: CapabilityAdapterSetBindingV1;
  snapshots: CapabilityProjectionSnapshotV1[];
  evidence: CapabilityAdapterBoundedEvidenceV1[];
  privateDescriptors: CapabilityAdapterPrivateDescriptorV1[];
  privatePreimages: Array<{ resource: CapabilityOwnedResourceV1; bytes: Uint8Array }>;
  privateEvidence: Array<{ content_digest: string; bytes: Uint8Array }>;
  stepEnforcement: CapabilityStepEnforcementBindingV1[];
  probeEnforcement: CapabilityProbeEnforcementBindingV1[];
  packages: ResolvedCapabilityPackageV1[];
  mode: CapabilityExecutionLedgerMode;
}): CapabilityDurablePlanningGraphV1 {
  const jsonObjects: CapabilityPlanningJsonObjectV1[] = [
    planningJsonObject(
      "vf.capability-adapter-registry/1",
      input.planDraft.runtime_closure.adapter_registry,
    ),
    planningJsonObject("vf.permission-binding/1", input.planDraft.permission_binding),
    planningJsonObject("vf.adapter-set-binding/1", input.adapterSet),
    ...input.snapshots.map((row) => planningJsonObject("vf.projection-snapshot/1", row)),
    ...input.evidence.map((row) => planningJsonObject("vf.adapter-bounded-evidence/1", row)),
    ...input.privateDescriptors.map((row) =>
      planningJsonObject("vf.adapter-private-descriptor/1", row),
    ),
    ...input.stepEnforcement.map((row) => planningJsonObject("vf.step-enforcement-binding/1", row)),
    ...input.probeEnforcement.map((row) =>
      planningJsonObject("vf.probe-enforcement-binding/1", row),
    ),
    ...input.planDraft.adapter_plans.map((row) => planningJsonObject("vf.adapter-plan/1", row)),
  ];
  for (const pkg of input.packages) {
    const source = pkg.source_execution;
    if (!source)
      throw new CapabilityRuntimeError(
        "package source execution proof is absent",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    jsonObjects.push(
      planningJsonObject("vf.package-authenticity-binding/1", pkg.authenticity_binding),
      planningJsonObject("vf.source-access-descriptor/1", source.descriptor),
      planningJsonObject("vf.source-access-authority-binding/1", source.authority),
      planningJsonObject("vf.resolved-source-authority-binding/1", source.resolved),
    );
  }
  const objects = dedupeCapabilityPlanningJsonObjects(jsonObjects);
  const blobs = dedupeBlobs([
    ...input.privatePreimages.map(({ resource, bytes }) => {
      if (!resource.private_preimage_digest)
        throw new CapabilityRuntimeError(
          "private preimage digest is absent",
          CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
        );
      const row = planningRawBlob(
        "owned-resource-preimage",
        resource.private_preimage_digest,
        bytes,
      );
      if (row.binding.blob_ref !== resource.private_preimage_ref)
        throw new CapabilityRuntimeError(
          "private preimage binding mismatch",
          CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
        );
      return row;
    }),
    ...input.privateEvidence.map(({ content_digest, bytes }) => {
      const row = planningRawBlob("inspection-private-evidence", content_digest, bytes);
      if (digestV1Bytes("VF-ADAPTER-PRIVATE-EVIDENCE\0v1\0", bytes) !== content_digest)
        throw new CapabilityRuntimeError(
          "private inspection evidence binding mismatch",
          CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
        );
      return row;
    }),
  ]);
  const planPackages = new Map(input.packages.map((pkg) => [pkg.pin.pin_digest, pkg]));
  const privateBindingRows = input.planDraft.adapter_plans.map((plan, order) => {
    const pkg = planPackages.get(plan.package_pin.pin_digest);
    if (!pkg?.private_input_execution)
      throw new CapabilityRuntimeError(
        "adapter plan private input binding is absent",
        CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE,
      );
    const record = pkg.private_input_execution.record;
    return {
      order,
      plan_id: plan.plan_id,
      binding_digest: pkg.private_input_execution.binding_digest,
      binding_ref:
        record === null
          ? null
          : `actions/v1/private-input-bindings/${record.private_binding_id}.json`,
    };
  });
  const closureDraft = {
    schema_version: "1.0" as const,
    action_root_locator: structuredClone(input.planDraft.action_root_locator),
    scope: input.planDraft.scope,
    scope_identity_digest: input.planDraft.scope_identity_digest,
    adapter_registry_digest: input.planDraft.adapter_registry_digest,
    adapter_set_digest: input.planDraft.adapter_set_digest,
    permission_digest: input.planDraft.permission_digest,
    source_authority_set_digest: input.planDraft.source_authority_set_digest,
    plans: input.planDraft.adapter_plans.map((plan, order) => ({
      order,
      plan_id: plan.plan_id,
      plan_digest: plan.plan_digest,
    })),
    json_objects: objects.map((row) => structuredClone(row.binding)),
    private_input_bindings: privateBindingRows,
    raw_blobs: blobs.map((row) => structuredClone(row.binding)),
  };
  const closure: CapabilityExecutionObjectClosureV1 = {
    ...closureDraft,
    closure_digest: executionClosureDigest({ ...closureDraft, closure_digest: "" }),
  };
  const planValue = {
    ...input.planDraft,
    execution_closure: closure,
    execution_closure_digest: closure.closure_digest,
    plan_digest: "",
  };
  const plan: CapabilityFabricPlanV1 = {
    ...planValue,
    plan_digest: capabilityFabricPlanDigest(planValue),
  };
  const ledger: CapabilityPlanningLedgerV1 = {
    schema_version: "1.0",
    mode: input.mode,
    json_objects: objects,
    private_input_bindings: privateInputs(input.packages),
    raw_blobs: blobs,
  };
  const graph = {
    plan,
    action_plan: actionPlan(input.request, input.planDraft, closure.closure_digest),
    execution_closure: closure,
    ledger,
  };
  // Ensure no typed ledger value hides a non-canonical or cyclic JSON graph.
  canonicalJsonBytes(graph.action_plan);
  return immutableClone(validateCapabilityPlanningGraph(graph));
}
