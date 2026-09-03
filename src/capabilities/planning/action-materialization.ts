import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { canonicalJson, digestV1 } from "../../durability/index.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import { bytewise } from "../wire/primitives.js";
import type {
  CapabilityFabricPlanV1,
  CapabilityHostActionV1,
  CapabilityPlanningRequestV1,
  ResolvedCapabilityPackageV1,
} from "./types.js";

type InstallActionV1 = Extract<
  CapabilityHostActionV1,
  { type: typeof HOST_ACTION_KIND.CAPABILITY_INSTALL }
>;

function invalid(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.AUTHORIZATION_MISMATCH);
}

export function capabilityActionDigest(action: CapabilityHostActionV1): string {
  return digestV1("VF-CAPABILITY-CANONICAL-ACTION\0v1\0", action);
}

function packageFor(
  request: CapabilityPlanningRequestV1,
  packageId: string,
): ResolvedCapabilityPackageV1 {
  const packages = [...request.desired_packages, ...(request.effect_packages ?? [])];
  const matches = packages.filter(
    (pkg, index) =>
      pkg.pin.id === packageId &&
      packages.findIndex((candidate) => candidate.pin.pin_digest === pkg.pin.pin_digest) === index,
  );
  if (matches.length !== 1)
    invalid("canonical action package does not resolve to exactly one package");
  return matches[0] as ResolvedCapabilityPackageV1;
}

function assertSelector(
  selector: InstallActionV1["package"],
  pkg: ResolvedCapabilityPackageV1,
): void {
  const pin = pkg.pin;
  if (
    selector.id !== pin.id ||
    (selector.version !== undefined && selector.version !== pin.version) ||
    (selector.source_kind !== undefined && selector.source_kind !== pin.source.kind) ||
    (selector.content_sha256 !== undefined && selector.content_sha256 !== pin.content_sha256) ||
    (selector.package_pin_digest !== undefined && selector.package_pin_digest !== pin.pin_digest)
  )
    invalid("canonical action package selector does not match the resolved package pin");
}

function sorted<T extends { input_id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => bytewise(left.input_id, right.input_id));
}

export function privateActionInputBindingDigest(inputs: InstallActionV1["inputs"]): string {
  return digestV1("VF-CAPABILITY-PRIVATE-INPUT-BINDING-SET\0v1\0", {
    schema_version: "1.0",
    bindings: sorted(
      inputs.filter((input) => typeof input.value === "object" && input.value !== null),
    ),
  });
}

function assertInputs(inputs: InstallActionV1["inputs"], pkg: ResolvedCapabilityPackageV1): void {
  const publicInputs = inputs.filter(
    (input) => typeof input.value !== "object" || input.value === null,
  );
  const privateInputs = inputs.filter(
    (input) => typeof input.value === "object" && input.value !== null,
  );
  if (canonicalJson(sorted(publicInputs)) !== canonicalJson(sorted(pkg.public_inputs)))
    invalid("canonical action public inputs do not match materialized package inputs");
  const privateIds = privateInputs.map((input) => input.input_id).sort(bytewise);
  if (canonicalJson(privateIds) !== canonicalJson([...pkg.secret_input_ids].sort(bytewise)))
    invalid("canonical action private input IDs do not match materialized package inputs");
  if (
    privateInputs.length > 0 &&
    privateActionInputBindingDigest(inputs) !== pkg.private_input_binding_digest
  )
    invalid("canonical action private input bindings do not match materialized package authority");
}

function assertInputPatch(
  inputs: InstallActionV1["inputs"],
  pkg: ResolvedCapabilityPackageV1,
): void {
  if (inputs.length === 0) invalid("configure action input patch is empty");
  const publicInputs = new Map(pkg.public_inputs.map((row) => [row.input_id, row.value]));
  for (const input of inputs) {
    if (typeof input.value === "object" && input.value !== null) {
      if (!pkg.secret_input_ids.includes(input.input_id))
        invalid("configure private input patch is absent from resulting package inputs");
    } else if (
      !publicInputs.has(input.input_id) ||
      canonicalJson(publicInputs.get(input.input_id)) !== canonicalJson(input.value)
    ) {
      invalid("configure public input patch does not match resulting package inputs");
    }
  }
}

function assertTargets(
  targets: InstallActionV1["requested_targets"],
  request: CapabilityPlanningRequestV1,
  packageId: string,
): void {
  const expected = [...targets].sort((left, right) =>
    bytewise(canonicalJson(left), canonicalJson(right)),
  );
  const observed = request.selected_targets
    ? request.selected_targets
        .filter((target) => target.package_id === packageId)
        .map(({ engine, participant_id }) => ({ engine, participant_id }))
        .sort((left, right) => bytewise(canonicalJson(left), canonicalJson(right)))
    : [...new Set(request.selected_engines)]
        .sort(bytewise)
        .map((engine) => ({ engine, participant_id: null }));
  if (canonicalJson(expected) !== canonicalJson(observed))
    invalid("canonical action targets do not match exact materialized package targets");
}

export function assertActionMaterialization(
  action: CapabilityHostActionV1,
  request: CapabilityPlanningRequestV1,
): void {
  if (request.scope !== action.scope) invalid("materialized scope does not match canonical action");
  switch (action.type) {
    case HOST_ACTION_KIND.CAPABILITY_INSTALL: {
      if (request.intent.kind !== "install")
        invalid("install action materialized as another lifecycle");
      const pkg = packageFor(request, action.package.id);
      assertSelector(action.package, pkg);
      assertTargets(action.requested_targets, request, pkg.pin.id);
      assertInputs(action.inputs, pkg);
      return;
    }
    case HOST_ACTION_KIND.CAPABILITY_UPDATE: {
      if (request.intent.kind !== "update" || request.intent.package_id !== action.package_id)
        invalid("update action materialization mismatch");
      const pkg = packageFor(request, action.package_id);
      assertSelector(action.selector, pkg);
      if (action.requested_targets !== null)
        assertTargets(action.requested_targets, request, pkg.pin.id);
      if (action.inputs !== null) assertInputs(action.inputs, pkg);
      return;
    }
    case HOST_ACTION_KIND.CAPABILITY_CONFIGURE:
      if (request.intent.kind !== "configure" || request.intent.package_id !== action.package_id)
        invalid("configure action materialization mismatch");
      assertInputPatch(action.inputs, packageFor(request, action.package_id));
      return;
    case HOST_ACTION_KIND.CAPABILITY_RETARGET:
      if (request.intent.kind !== "retarget" || request.intent.package_id !== action.package_id)
        invalid("retarget action materialization mismatch");
      packageFor(request, action.package_id);
      assertTargets(action.requested_targets, request, action.package_id);
      return;
    case HOST_ACTION_KIND.CAPABILITY_REMOVE:
      if (
        request.intent.kind !== "remove" ||
        request.intent.package_id !== action.package_id ||
        request.intent.cascade !== action.cascade
      )
        invalid("remove action materialization mismatch");
      packageFor(request, action.package_id);
      return;
    case HOST_ACTION_KIND.CAPABILITY_ROLLBACK_SCOPE:
      if (
        request.intent.kind !== "rollback" ||
        request.intent.generation_id !== action.generation_id
      )
        invalid("rollback action materialization mismatch");
      return;
    case HOST_ACTION_KIND.CAPABILITY_RESTORE_PACKAGE:
      if (
        request.intent.kind !== "restore" ||
        request.intent.package_id !== action.package_id ||
        request.intent.generation_id !== action.generation_id
      )
        invalid("restore action materialization mismatch");
      packageFor(request, action.package_id);
      return;
    case HOST_ACTION_KIND.CAPABILITY_REPAIR:
      if (request.intent.kind !== "repair" || request.intent.package_id !== action.package_id)
        invalid("repair action materialization mismatch");
      if (action.package_id !== null) packageFor(request, action.package_id);
      return;
    case HOST_ACTION_KIND.CAPABILITY_ADOPT:
      if (
        request.intent.kind !== "adopt" ||
        request.intent.candidate_digest !== action.candidate.candidate_digest ||
        request.adopt_candidate?.candidate_id !== action.candidate.candidate_id ||
        request.adopt_candidate.candidate_digest !== action.candidate.candidate_digest
      )
        invalid("adopt action materialization mismatch");
      return;
  }
}

export function assertActionMatchesPlan(
  action: CapabilityHostActionV1,
  plan: CapabilityFabricPlanV1,
): void {
  if (
    plan.action_binding === null ||
    plan.action_binding.action_type !== action.type ||
    plan.action_binding.action_digest !== capabilityActionDigest(action)
  )
    invalid("approved canonical action does not match the exact planned action binding");
}
