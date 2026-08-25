import type { ActionProposalV1 } from "../../actions/index.js";
import { canonicalJson } from "../../durability/index.js";
import type { CapabilityActionPlanBindingV1 } from "../action-domain/types.js";
import { privateEffectBinding } from "../adapters/private-descriptors.js";
import type {
  CapabilityAdapterPrivateDescriptorV1,
  CapabilityEffectDescriptorV1,
} from "../adapters/types.js";
import { CapabilityRuntimeError } from "../operations/errors.js";
import { capabilityActionDigest } from "./action-materialization.js";
import { capabilityFabricPlanDigest } from "./digests.js";
import type {
  CapabilityExecutionJsonObjectValueV1,
  CapabilityPlanningLedgerV1,
} from "./execution-types.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityExecutionObjectClosureV1,
  CapabilityFabricPlanV1,
  CapabilityHostActionV1,
  ResolvedCapabilityPackageV1,
} from "./types.js";

export interface CapabilityExecutionPackageReaderV1 {
  readByPin(pinDigest: string): ResolvedCapabilityPackageV1 | null;
}

function fail(message: string): never {
  throw new CapabilityRuntimeError(message, "integrity-failure");
}

function objectsOf<T extends CapabilityExecutionJsonObjectValueV1>(
  ledger: CapabilityPlanningLedgerV1,
  schema: import("./execution-types.js").CapabilityExecutionObjectSchemaIdV1,
): T[] {
  return ledger.json_objects
    .filter((row) => row.binding.object_schema_id === schema)
    .map((row) => structuredClone(row.value) as T);
}

function oneObject<T extends CapabilityExecutionJsonObjectValueV1>(
  ledger: CapabilityPlanningLedgerV1,
  schema: import("./execution-types.js").CapabilityExecutionObjectSchemaIdV1,
): T {
  const values = objectsOf<T>(ledger, schema);
  if (values.length !== 1) fail(`execution graph requires exactly one ${schema}`);
  return values[0] as T;
}

function lifecycleIntent(action: CapabilityHostActionV1): CapabilityFabricPlanV1["intent"] {
  switch (action.type) {
    case "capability.install":
      return { kind: "install" };
    case "capability.update":
      return { kind: "update", package_id: action.package_id };
    case "capability.configure":
      return { kind: "configure", package_id: action.package_id };
    case "capability.retarget":
      return { kind: "retarget", package_id: action.package_id };
    case "capability.remove":
      return { kind: "remove", package_id: action.package_id, cascade: action.cascade };
    case "capability.rollback_scope":
      return { kind: "rollback", generation_id: action.generation_id };
    case "capability.restore_package":
      return {
        kind: "restore",
        package_id: action.package_id,
        generation_id: action.generation_id,
      };
    case "capability.repair":
      return { kind: "repair", package_id: action.package_id };
    case "capability.adopt":
      return { kind: "adopt", candidate_digest: action.candidate.candidate_digest };
  }
}

function publicDescriptor(
  descriptor: CapabilityAdapterPrivateDescriptorV1,
  root: CapabilityExecutionObjectClosureV1["action_root_locator"],
  ownerBinding: ReturnType<typeof privateEffectBinding>,
): CapabilityEffectDescriptorV1 {
  const value = descriptor.value;
  return {
    schema_version: "1.0",
    descriptor_kind: descriptor.descriptor_kind,
    descriptor_schema_id: descriptor.descriptor_schema_id,
    operation: value.operation,
    adapter: structuredClone(value.adapter),
    package_pin_digest: value.package_pin_digest,
    component_id: value.component_id,
    target_id: value.target_id,
    resource: structuredClone(value.resource),
    private_payload_binding: privateEffectBinding(descriptor, root),
    owner_binding: ownerBinding,
    projection_digest: value.projection_digest,
    descriptor_digest: descriptor.descriptor_digest,
  };
}

function runtimeDescriptors(input: {
  closure: CapabilityExecutionObjectClosureV1;
  ledger: CapabilityPlanningLedgerV1;
  plans: import("./types.js").CapabilityAdapterPlanV1[];
}): CapabilityEffectDescriptorV1[] {
  const byDigest = new Map(
    objectsOf<CapabilityAdapterPrivateDescriptorV1>(
      input.ledger,
      "vf.adapter-private-descriptor/1",
    ).map((row) => [row.descriptor_digest, row]),
  );
  const result: CapabilityEffectDescriptorV1[] = [];
  for (const plan of input.plans) {
    for (const step of plan.steps) {
      const intent = byDigest.get(step.intent.descriptor_digest);
      if (!intent) fail("adapter plan intent descriptor is missing");
      const owner = privateEffectBinding(intent, input.closure.action_root_locator);
      result.push(publicDescriptor(intent, input.closure.action_root_locator, owner));
      if (step.rollback.descriptor_digest !== null) {
        const rollback = byDigest.get(step.rollback.descriptor_digest);
        if (!rollback) fail("adapter plan rollback descriptor is missing");
        result.push(publicDescriptor(rollback, input.closure.action_root_locator, owner));
      }
    }
  }
  return result;
}

function sourceExecution(ledger: CapabilityPlanningLedgerV1, authenticityDigest: string) {
  const resolved = objectsOf<
    import("./execution-types.js").CapabilityResolvedSourceAuthorityBindingV1
  >(ledger, "vf.resolved-source-authority-binding/1").find(
    (row) => row.authenticity_digest === authenticityDigest,
  );
  if (!resolved) fail("resolved source authority is absent");
  const authority = objectsOf<
    import("./execution-types.js").CapabilitySourceAccessAuthorityBindingV1
  >(ledger, "vf.source-access-authority-binding/1").find(
    (row) => row.binding_digest === resolved.source_access_authority_digest,
  );
  const descriptor = authority
    ? objectsOf<import("./execution-types.js").CapabilitySourceAccessDescriptorV1>(
        ledger,
        "vf.source-access-descriptor/1",
      ).find((row) => row.descriptor_digest === authority.source_descriptor_digest)
    : null;
  if (!authority || !descriptor) fail("source execution authority chain is incomplete");
  return { descriptor, authority, resolved };
}

function privateInputExecution(
  ledger: CapabilityPlanningLedgerV1,
  digest: string,
): ResolvedCapabilityPackageV1["private_input_execution"] {
  const row = ledger.private_input_bindings.find(
    (candidate) => candidate.binding_digest === digest,
  );
  return { binding_digest: digest, record: row?.record ?? null };
}

function loadPackages(input: {
  proposal: ActionProposalV1;
  ledger: CapabilityPlanningLedgerV1;
  plans: import("./types.js").CapabilityAdapterPlanV1[];
  packages: CapabilityExecutionPackageReaderV1;
}): ResolvedCapabilityPackageV1[] {
  return input.proposal.package_pins.map((pin) => {
    const pkg = input.packages.readByPin(pin.pin_digest);
    if (!pkg || canonicalJson(pkg.pin) !== canonicalJson(pin))
      fail("durable execution package cache binding is missing");
    const planBindings = input.plans
      .filter((plan) => plan.package_pin.pin_digest === pin.pin_digest)
      .map((plan) => plan.private_input_binding_digest);
    if (new Set(planBindings).size > 1) fail("package plans disagree on private input binding");
    const bindingDigest = planBindings[0] ?? pkg.private_input_binding_digest;
    return {
      ...pkg,
      private_input_binding_digest: bindingDigest,
      private_input_execution: privateInputExecution(input.ledger, bindingDigest),
      source_authority_binding_digest: sourceExecution(
        input.ledger,
        pkg.authenticity_binding.authenticity_digest,
      ).resolved.binding_digest,
      source_execution: sourceExecution(input.ledger, pkg.authenticity_binding.authenticity_digest),
    };
  });
}

function safePackage(pkg: ResolvedCapabilityPackageV1) {
  const { files: _, private_input_execution: __, source_execution: ___, ...safe } = pkg;
  return structuredClone(safe);
}

export function rehydrateCapabilityPlanningGraph(input: {
  proposal: ActionProposalV1;
  action_plan: CapabilityActionPlanBindingV1;
  execution_closure: CapabilityExecutionObjectClosureV1;
  ledger: CapabilityPlanningLedgerV1;
  packages: CapabilityExecutionPackageReaderV1;
}): CapabilityDurablePlanningGraphV1 {
  if (
    !input.proposal.action.type.startsWith("capability.") ||
    input.proposal.base.capability_scope === null
  )
    fail("proposal is outside the capability domain");
  const action = input.proposal.action as CapabilityHostActionV1;
  const plans = objectsOf<import("./types.js").CapabilityAdapterPlanV1>(
    input.ledger,
    "vf.adapter-plan/1",
  ).sort((left, right) => {
    const leftOrder =
      input.execution_closure.plans.find((row) => row.plan_id === left.plan_id)?.order ?? -1;
    const rightOrder =
      input.execution_closure.plans.find((row) => row.plan_id === right.plan_id)?.order ?? -1;
    return leftOrder - rightOrder;
  });
  const allPackages = loadPackages({ ...input, plans });
  const descriptors = runtimeDescriptors({
    closure: input.execution_closure,
    ledger: input.ledger,
    plans,
  });
  const removedPins = new Set(
    descriptors
      .filter((row) => row.descriptor_kind === "intent" && row.operation === "remove")
      .map((row) => row.package_pin_digest),
  );
  const effectPins = new Set(plans.map((row) => row.package_pin.pin_digest));
  const runtimeAuthority = {
    schema_version: "1.0" as const,
    scope: input.proposal.base.capability_scope,
    scope_identity_digest: input.execution_closure.scope_identity_digest,
    authority_epoch: input.proposal.base.authority_epoch,
    authority_head_digest: input.proposal.base.authority_head_digest,
    policy_digest: input.proposal.policy_digest,
    grant_digest: input.proposal.grant_digest,
    permission_digest: input.proposal.permission_digest,
    source_authority_set_digest: input.proposal.source_authority_set_digest,
  };
  const draft = {
    schema_version: "1.0" as const,
    status: "planned" as const,
    intent: lifecycleIntent(action),
    action_binding: {
      schema_version: "1.0" as const,
      action_type: action.type,
      action_digest: capabilityActionDigest(action),
    },
    scope: input.proposal.base.capability_scope,
    scope_identity_digest: input.execution_closure.scope_identity_digest,
    action_root_locator: structuredClone(input.execution_closure.action_root_locator),
    base_generation_id: input.proposal.base.capability_generation_id,
    base_lock_digest: input.proposal.base.capability_lock_digest,
    targets: structuredClone(input.proposal.target_set),
    target_dispositions: structuredClone(input.proposal.preview.target_dispositions),
    permission_binding: oneObject<import("../permissions/types.js").PermissionBindingV1>(
      input.ledger,
      "vf.permission-binding/1",
    ),
    permission_digest: input.execution_closure.permission_digest,
    permission_delta: structuredClone(input.proposal.preview.permission_delta),
    adapter_registry_digest: input.execution_closure.adapter_registry_digest,
    adapter_set_digest: input.execution_closure.adapter_set_digest,
    source_authority_set_digest: input.execution_closure.source_authority_set_digest,
    effect_classes: [...input.proposal.effect_classes],
    reversibility: input.proposal.reversibility,
    adapter_plans: plans,
    runtime_closure: {
      authority: runtimeAuthority,
      adapter_registry: oneObject<import("../adapters/types.js").CapabilityAdapterRegistryV1>(
        input.ledger,
        "vf.capability-adapter-registry/1",
      ),
      packages: allPackages.filter((pkg) => !removedPins.has(pkg.pin.pin_digest)).map(safePackage),
      effect_packages: allPackages
        .filter((pkg) => effectPins.has(pkg.pin.pin_digest))
        .map(safePackage),
      snapshots: objectsOf<import("./types.js").CapabilityProjectionSnapshotV1>(
        input.ledger,
        "vf.projection-snapshot/1",
      ),
      inspection_evidence: objectsOf<
        import("./execution-types.js").CapabilityAdapterBoundedEvidenceV1
      >(input.ledger, "vf.adapter-bounded-evidence/1"),
      descriptors,
    },
    execution_closure: structuredClone(input.execution_closure),
    execution_closure_digest: input.execution_closure.closure_digest,
    created_at: input.proposal.created_at,
    plan_digest: "",
  };
  const plan = { ...draft, plan_digest: capabilityFabricPlanDigest(draft) };
  return {
    plan,
    action_plan: input.action_plan,
    execution_closure: input.execution_closure,
    ledger: input.ledger,
  };
}
