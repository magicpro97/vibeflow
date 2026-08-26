import { canonicalJson, digestV1 } from "../../durability/index.js";
import { validateAdapterPrivateDescriptor } from "../adapters/private-descriptors.js";
import { validateCapabilityAdapterRegistry } from "../adapters/registry.js";
import type { CapabilityAdapterPrivateDescriptorV1 } from "../adapters/types.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import { validateCapabilityFabricPlan } from "../operations/validation.js";
import { permissionBindingDigest } from "../permissions/index.js";
import { validateExecutionPrivateInputRecord } from "../private-input/execution-binding.js";
import { emptyBindingDigest } from "../private-input/helpers.js";
import { bytewise } from "../wire/primitives.js";
import { adapterPlanDigest, adapterPlanIdentity, executionClosureDigest } from "./digests.js";
import { assertCapabilityGraphAuthorityClosure } from "./execution-graph-authority-validation.js";
import { assertCapabilityExecutionBlobs } from "./execution-graph-blob-validation.js";
import {
  assertCapabilityActionPlanStep,
  assertCapabilityAdapterSet,
  assertCapabilityGraphOuterClosure,
  assertCapabilitySnapshotSet,
} from "./execution-graph-closure-validation.js";
import { assertCapabilityExecutionObjectReferences } from "./execution-graph-references.js";
import {
  CAPABILITY_EXECUTION_SCHEMA_ORDER,
  assertExecutionObjectBinding,
  capabilityExecutionObjectDigest,
} from "./execution-objects.js";
import type {
  CapabilityExecutionJsonObjectValueV1,
  CapabilityExecutionObjectSchemaIdV1,
  CapabilityPlanningJsonObjectV1,
} from "./execution-types.js";
import { ownedProjectionRecord } from "./resource-planner.js";
import type { CapabilityAdapterPlanV1, CapabilityDurablePlanningGraphV1 } from "./types.js";

function fail(message: string): never {
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

function assertDense(rows: readonly { order: number }[], label: string): void {
  if (rows.some((row, index) => row.order !== index)) fail(`${label} is not dense`);
}

function objectKey(schema: CapabilityExecutionObjectSchemaIdV1, digest: string): string {
  return `${schema}\0${digest}`;
}

function exactObject<T extends CapabilityExecutionJsonObjectValueV1>(
  objects: Map<string, CapabilityPlanningJsonObjectV1>,
  schema: CapabilityExecutionObjectSchemaIdV1,
  digest: string,
  used: Set<string>,
): T {
  const key = objectKey(schema, digest);
  const row = objects.get(key);
  if (!row) fail(`execution closure is missing ${schema} ${digest}`);
  used.add(key);
  return row.value as T;
}

function assertObjectOrder(rows: CapabilityPlanningJsonObjectV1[]): void {
  const sorted = [...rows].sort((left, right) => {
    const schema =
      CAPABILITY_EXECUTION_SCHEMA_ORDER.indexOf(left.binding.object_schema_id) -
      CAPABILITY_EXECUTION_SCHEMA_ORDER.indexOf(right.binding.object_schema_id);
    return schema || bytewise(left.binding.object_digest, right.binding.object_digest);
  });
  if (
    canonicalJson(rows.map((row) => row.binding)) !==
    canonicalJson(sorted.map((row) => row.binding))
  )
    fail("execution JSON object bindings are not canonically ordered");
}

function indexObjects(graph: CapabilityDurablePlanningGraphV1) {
  assertObjectOrder(graph.ledger.json_objects);
  const objects = new Map<string, CapabilityPlanningJsonObjectV1>();
  const digests = new Map<string, CapabilityPlanningJsonObjectV1>();
  for (const row of graph.ledger.json_objects) {
    assertExecutionObjectBinding(row.binding, row.value);
    const key = objectKey(row.binding.object_schema_id, row.binding.object_digest);
    if (objects.has(key)) fail("execution closure contains a duplicate JSON object");
    const prior = digests.get(row.binding.object_digest);
    if (prior && canonicalJson(prior) !== canonicalJson(row))
      fail("execution closure reuses one digest for conflicting objects");
    objects.set(key, row);
    digests.set(row.binding.object_digest, row);
  }
  if (
    canonicalJson(graph.execution_closure.json_objects) !==
    canonicalJson(graph.ledger.json_objects.map((row) => row.binding))
  )
    fail("execution closure JSON membership differs from its ledger");
  return objects;
}

function assertPrivateInputs(
  graph: CapabilityDurablePlanningGraphV1,
  plans: CapabilityAdapterPlanV1[],
): void {
  const rows = graph.execution_closure.private_input_bindings;
  assertDense(rows, "private input closure");
  if (rows.length !== plans.length) fail("private input closure cardinality mismatch");
  const records = new Map(
    graph.ledger.private_input_bindings.map((row) => [row.binding_digest, row]),
  );
  for (const [order, plan] of plans.entries()) {
    const row = rows[order];
    if (
      !row ||
      row.plan_id !== plan.plan_id ||
      row.binding_digest !== plan.private_input_binding_digest
    )
      fail("private input closure does not bind its adapter plan");
    const pkg = graph.plan.runtime_closure.effect_packages.find(
      (candidate) => candidate.pin.pin_digest === plan.package_pin.pin_digest,
    );
    if (!pkg) fail("private input closure references an unknown package");
    const empty = emptyBindingDigest({
      scope: plan.scope,
      scope_identity_digest: graph.execution_closure.scope_identity_digest,
      package_id: pkg.pin.id,
      package_pin_digest: pkg.pin.pin_digest,
      manifest_digest: pkg.manifest_digest,
    });
    if (row.binding_digest === empty) {
      if (row.binding_ref !== null || records.has(row.binding_digest))
        fail("empty private input sentinel has durable payload");
      continue;
    }
    const retained = records.get(row.binding_digest);
    if (!retained || row.binding_ref !== retained.binding_ref)
      fail("non-empty private input binding is missing");
    const record = validateExecutionPrivateInputRecord(retained.record);
    if (
      record.binding_digest !== row.binding_digest ||
      canonicalJson(record.action_root_locator) !==
        canonicalJson(graph.execution_closure.action_root_locator) ||
      record.scope !== graph.execution_closure.scope ||
      record.scope_identity_digest !== graph.execution_closure.scope_identity_digest ||
      record.package_pin_digest !== plan.package_pin.pin_digest
    )
      fail("private input record escaped the execution closure");
    records.delete(row.binding_digest);
  }
  if (records.size !== 0) fail("private input ledger contains an unreferenced record");
}

function planObjects(
  graph: CapabilityDurablePlanningGraphV1,
  objects: Map<string, CapabilityPlanningJsonObjectV1>,
  used: Set<string>,
): CapabilityAdapterPlanV1[] {
  assertDense(graph.execution_closure.plans, "capability plan closure");
  const actionSteps = graph.action_plan.steps.filter(
    (step) => step.plan_kind === "capability-adapter",
  );
  if (actionSteps.length !== graph.execution_closure.plans.length)
    fail("action plan and execution closure plan counts differ");
  return graph.execution_closure.plans.map((row, order) => {
    const action = actionSteps[order];
    if (!action || action.step_id !== row.plan_id || action.plan_digest !== row.plan_digest)
      fail("execution closure is not the dense action-plan subsequence");
    const plan = exactObject<CapabilityAdapterPlanV1>(
      objects,
      "vf.adapter-plan/1",
      row.plan_digest,
      used,
    );
    const digest = adapterPlanDigest(plan);
    if (
      plan.plan_digest !== digest ||
      plan.plan_id !== adapterPlanIdentity(digest) ||
      plan.plan_id !== row.plan_id
    )
      fail("adapter plan identity mismatch");
    assertCapabilityActionPlanStep(action, plan, order);
    return plan;
  });
}

export function validateCapabilityPlanningGraph(
  graph: CapabilityDurablePlanningGraphV1,
): CapabilityDurablePlanningGraphV1 {
  validateCapabilityFabricPlan(graph.plan);
  const closure = graph.execution_closure;
  if (
    closure.schema_version !== "1.0" ||
    closure.closure_digest !== executionClosureDigest(closure) ||
    graph.plan.execution_closure_digest !== closure.closure_digest ||
    canonicalJson(graph.plan.execution_closure) !== canonicalJson(closure) ||
    graph.action_plan.execution_object_closure_digest !== closure.closure_digest ||
    graph.action_plan.permission_digest !== closure.permission_digest ||
    canonicalJson(graph.action_plan.action_root_locator) !==
      canonicalJson(closure.action_root_locator)
  )
    fail("execution closure identity mismatch");
  assertCapabilityGraphOuterClosure(graph);
  assertCapabilityExecutionObjectReferences(graph.ledger.json_objects);
  const objects = indexObjects(graph);
  const used = new Set<string>();
  const registry = exactObject<import("../adapters/types.js").CapabilityAdapterRegistryV1>(
    objects,
    "vf.capability-adapter-registry/1",
    closure.adapter_registry_digest,
    used,
  );
  validateCapabilityAdapterRegistry(registry);
  const permission = exactObject<import("../permissions/types.js").PermissionBindingV1>(
    objects,
    "vf.permission-binding/1",
    closure.permission_digest,
    used,
  );
  if (permissionBindingDigest(permission) !== closure.permission_digest)
    fail("permission closure mismatch");
  const adapterSet = exactObject<import("./execution-types.js").CapabilityAdapterSetBindingV1>(
    objects,
    "vf.adapter-set-binding/1",
    closure.adapter_set_digest,
    used,
  );
  if (
    capabilityExecutionObjectDigest("vf.adapter-set-binding/1", adapterSet) !==
      closure.adapter_set_digest ||
    adapterSet.adapter_registry_digest !== closure.adapter_registry_digest
  )
    fail("adapter-set closure mismatch");
  const plans = planObjects(graph, objects, used);
  assertCapabilityAdapterSet(adapterSet, plans, closure.adapter_registry_digest);
  assertCapabilitySnapshotSet(graph, plans);
  if (canonicalJson(plans) !== canonicalJson(graph.plan.adapter_plans))
    fail("in-memory plan differs from its durable adapter plans");
  const descriptors: CapabilityAdapterPrivateDescriptorV1[] = [];
  for (const plan of plans) {
    if (
      plan.scope !== closure.scope ||
      plan.authority.permission_digest !== closure.permission_digest
    )
      fail("adapter plan escaped closure scope or permission authority");
    const snapshot = exactObject<import("./types.js").CapabilityProjectionSnapshotV1>(
      objects,
      "vf.projection-snapshot/1",
      plan.inspection_snapshot_digest,
      used,
    );
    const stepResources = plan.steps
      .flatMap((step) => step.owned_resources)
      .sort((left, right) => bytewise(left.ownership_key, right.ownership_key));
    const snapshotResources = [...snapshot.owned_resources].sort((left, right) =>
      bytewise(left.ownership_key, right.ownership_key),
    );
    if (
      new Set(snapshotResources.map((resource) => resource.ownership_key)).size !==
        snapshotResources.length ||
      stepResources.some(
        (resource) =>
          !snapshotResources.some(
            (snapshotResource) => canonicalJson(snapshotResource) === canonicalJson(resource),
          ),
      )
    )
      fail("adapter step resource is not exactly bound by its inspection snapshot");
    for (const step of plan.steps) {
      exactObject(objects, "vf.step-enforcement-binding/1", step.enforcement_digest, used);
      const intent = exactObject<CapabilityAdapterPrivateDescriptorV1>(
        objects,
        "vf.adapter-private-descriptor/1",
        step.intent.descriptor_digest,
        used,
      );
      validateAdapterPrivateDescriptor(intent);
      if (
        intent.descriptor_kind !== "intent" ||
        step.intent.private_descriptor_ref !== intentRef(intent) ||
        !descriptorMatchesStep(intent, plan, step)
      )
        fail("adapter intent descriptor binding mismatch");
      descriptors.push(intent);
      if (step.rollback.descriptor_digest !== null) {
        const rollback = exactObject<CapabilityAdapterPrivateDescriptorV1>(
          objects,
          "vf.adapter-private-descriptor/1",
          step.rollback.descriptor_digest,
          used,
        );
        validateAdapterPrivateDescriptor(rollback);
        if (
          rollback.descriptor_kind !== "rollback" ||
          step.rollback.private_descriptor_ref !== intentRef(rollback) ||
          !descriptorMatchesStep(rollback, plan, step)
        )
          fail("adapter rollback descriptor binding mismatch");
        descriptors.push(rollback);
      } else if (
        step.rollback.schema_id !== null ||
        step.rollback.private_descriptor_ref !== null
      ) {
        fail("non-reversible adapter step has a partial rollback binding");
      }
    }
    for (const probe of plan.health_plan)
      exactObject(objects, "vf.probe-enforcement-binding/1", probe.enforcement_digest, used);
  }
  const evidence: import("./execution-types.js").CapabilityAdapterBoundedEvidenceV1[] = [];
  for (const snapshot of graph.plan.runtime_closure.snapshots) {
    exactObject(objects, "vf.projection-snapshot/1", snapshot.snapshot_digest, used);
    evidence.push(
      exactObject(
        objects,
        "vf.adapter-bounded-evidence/1",
        snapshot.ownership_evidence_digest,
        used,
      ),
    );
  }
  assertSourceObjects(graph, plans, registry, objects, used);
  if (used.size !== objects.size) fail("execution closure contains an unreferenced JSON object");
  assertPrivateInputs(graph, plans);
  assertCapabilityExecutionBlobs(graph, descriptors, evidence);
  return structuredClone(graph);
}

function intentRef(value: CapabilityAdapterPrivateDescriptorV1): string {
  return `actions/v1/objects/${value.descriptor_digest.slice("sha256:".length)}.json`;
}

function descriptorMatchesStep(
  descriptor: CapabilityAdapterPrivateDescriptorV1,
  plan: CapabilityAdapterPlanV1,
  step: CapabilityAdapterPlanV1["steps"][number],
): boolean {
  const value = descriptor.value;
  return (
    canonicalJson(value.adapter) === canonicalJson(plan.adapter) &&
    value.package_pin_digest === plan.package_pin.pin_digest &&
    value.component_id === plan.component_id &&
    step.target_ids.includes(value.target_id) &&
    step.owned_resources.length === 1 &&
    canonicalJson(value.resource) === canonicalJson(step.owned_resources[0]) &&
    value.projection_digest ===
      ownedProjectionRecord(value.resource, value.target_id).projection_digest &&
    value.private_payload.ownership_key === value.resource.ownership_key &&
    value.private_payload.expected_preimage_sha256 === value.resource.expected_preimage_sha256 &&
    value.private_payload.expected_postimage_sha256 === value.resource.expected_postimage_sha256
  );
}

function assertSourceObjects(
  graph: CapabilityDurablePlanningGraphV1,
  plans: CapabilityAdapterPlanV1[],
  registry: import("../adapters/types.js").CapabilityAdapterRegistryV1,
  objects: Map<string, CapabilityPlanningJsonObjectV1>,
  used: Set<string>,
): void {
  const resolvedRows = [...objects.values()]
    .filter((row) => row.binding.object_schema_id === "vf.resolved-source-authority-binding/1")
    .map(
      (row) =>
        row.value as import("./execution-types.js").CapabilityResolvedSourceAuthorityBindingV1,
    );
  const retained = assertCapabilityGraphAuthorityClosure({
    graph,
    plans,
    registry,
    resolvedRows,
    exactObject: <T extends CapabilityExecutionJsonObjectValueV1>(
      schema: CapabilityExecutionObjectSchemaIdV1,
      digest: string,
    ) => exactObject<T>(objects, schema, digest, used),
  });
  const sourceSetDigest = digestV1(
    "VF-RESOLVED-SOURCE-AUTHORITY-SET\0v1\0",
    retained.sort((left, right) => bytewise(left.authenticity_digest, right.authenticity_digest)),
  );
  if (sourceSetDigest !== graph.execution_closure.source_authority_set_digest)
    fail("resolved source authority set mismatch");
}
