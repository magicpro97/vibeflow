import { CAPABILITY_SOURCE_KIND } from "../../actions/capability-security-contract.js";
import { ACTION_EFFECT_CLASS } from "../../actions/public-action-contract.js";
import { canonicalJson } from "../../durability/index.js";
import type { CapabilityAdapterRegistryV1 } from "../adapters/types.js";
import { CAPABILITY_RUNTIME_ERROR_CODE, CapabilityRuntimeError } from "../operations/errors.js";
import type { PackageAuthenticityBindingV1 } from "../source/types.js";
import type {
  CapabilityControlCredentialBindingV1,
  CapabilityExecutionJsonObjectValueV1,
  CapabilityExecutionObjectSchemaIdV1,
  CapabilityResolvedSourceAuthorityBindingV1,
  CapabilitySourceAccessAuthorityBindingV1,
  CapabilitySourceAccessDescriptorV1,
} from "./execution-types.js";
import type { CapabilityAdapterPlanV1, CapabilityDurablePlanningGraphV1 } from "./types.js";

type ExactObject = <T extends CapabilityExecutionJsonObjectValueV1>(
  schema: CapabilityExecutionObjectSchemaIdV1,
  digest: string,
) => T;

function fail(message: string): never {
  throw new CapabilityRuntimeError(message, CAPABILITY_RUNTIME_ERROR_CODE.INTEGRITY_FAILURE);
}

function exact(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function expectedSource(
  pin: CapabilityAdapterPlanV1["package_pin"],
  graph: CapabilityDurablePlanningGraphV1,
): CapabilitySourceAccessDescriptorV1["source"] {
  const source = pin.source;
  if (source.kind === CAPABILITY_SOURCE_KIND.REGISTRY)
    return {
      kind: CAPABILITY_SOURCE_KIND.REGISTRY,
      registry_origin: source.registry_origin,
      package_url: source.source_url,
    };
  if (source.kind === CAPABILITY_SOURCE_KIND.GIT)
    return {
      kind: CAPABILITY_SOURCE_KIND.GIT,
      canonical_url: source.canonical_url,
      commit_oid: source.commit_oid,
    };
  if (source.kind === CAPABILITY_SOURCE_KIND.LOCAL_DEV)
    return {
      kind: CAPABILITY_SOURCE_KIND.LOCAL_DEV,
      repo_relative_alias: source.repo_relative_alias,
    };
  if (graph.plan.intent.kind !== "adopt")
    fail("legacy package source is not bound to the approved adoption intent");
  return {
    kind: CAPABILITY_SOURCE_KIND.LEGACY_ADOPT,
    phase: "candidate",
    candidate_digest: graph.plan.intent.candidate_digest,
  };
}

function assertPlanAuthority(
  graph: CapabilityDurablePlanningGraphV1,
  plan: CapabilityAdapterPlanV1,
  resolved: CapabilityResolvedSourceAuthorityBindingV1,
  registry: CapabilityAdapterRegistryV1,
): void {
  const runtime = graph.plan.runtime_closure.authority;
  const entry =
    registry.entries.find((row) => row.adapter?.fingerprint === plan.adapter.fingerprint) ??
    registry.legacy_adoption_entries.find(
      (row) => row.adapter.fingerprint === plan.adapter.fingerprint,
    );
  if (
    plan.scope !== graph.plan.scope ||
    plan.base_generation_id !== graph.plan.base_generation_id ||
    plan.authority.policy_digest !== runtime.policy_digest ||
    plan.authority.grant_digest !== runtime.grant_digest ||
    plan.authority.permission_digest !== graph.plan.permission_digest ||
    plan.authority.authority_epoch !== runtime.authority_epoch ||
    plan.authority.authority_head_digest !== runtime.authority_head_digest ||
    plan.authority.trust_epoch !== resolved.trust_epoch ||
    plan.source_authority_binding_digest !== resolved.binding_digest ||
    !entry ||
    !entry.adapter ||
    !exact(entry.adapter, plan.adapter)
  )
    fail("adapter plan authority is not the exact Fabric/runtime/source authority");
}

function assertSourceChain(input: {
  graph: CapabilityDurablePlanningGraphV1;
  pkg: CapabilityDurablePlanningGraphV1["plan"]["runtime_closure"]["effect_packages"][number];
  authenticity: PackageAuthenticityBindingV1;
  resolved: CapabilityResolvedSourceAuthorityBindingV1;
  authority: CapabilitySourceAccessAuthorityBindingV1;
  descriptor: CapabilitySourceAccessDescriptorV1;
  exactObject: ExactObject;
}): void {
  const { graph, pkg, authenticity, resolved, authority, descriptor, exactObject } = input;
  const scope = graph.execution_closure.scope;
  const identity = graph.execution_closure.scope_identity_digest;
  if (
    !exact(authenticity, pkg.authenticity_binding) ||
    resolved.scope !== scope ||
    resolved.scope_identity_digest !== identity ||
    resolved.authenticity_digest !== authenticity.authenticity_digest ||
    resolved.source_access_authority_digest !== authority.binding_digest ||
    authority.scope !== scope ||
    authority.scope_identity_digest !== identity ||
    authority.source_descriptor_digest !== descriptor.descriptor_digest ||
    authority.policy_digest !== graph.plan.runtime_closure.authority.policy_digest ||
    descriptor.credential.scope !== scope ||
    descriptor.credential.scope_identity_digest !== identity ||
    descriptor.credential.principal_digest !== descriptor.request_context.principal_digest ||
    !exact(descriptor.source, expectedSource(pkg.pin, graph)) ||
    descriptor.expected_content_sha256 !== pkg.pin.content_sha256
  )
    fail("resolved package source authority chain is not exact");
  if (authority.authorization.kind === "confirmation-free") {
    if (
      descriptor.authorization_mode !== "automatic" ||
      descriptor.intent !== "read-local-package" ||
      !exact(authority.effect_classes, [ACTION_EFFECT_CLASS.PURE_LOCAL_READ]) ||
      descriptor.required_permission_row_digests.length !== 0
    )
      fail("confirmation-free source authority exceeds a closed local read");
  } else if (authority.authorization.kind === "grant") {
    if (
      !exact(
        authority.authorization.permission_binding_digests,
        descriptor.required_permission_row_digests,
      ) ||
      authority.authorization.expires_at !== resolved.expires_at
    )
      fail("source grant does not exactly bind its requested permissions or expiry");
  } else {
    const control = exactObject<CapabilityControlCredentialBindingV1>(
      "vf.control-credential-binding/1",
      authority.authorization.control_credential_digest,
    );
    if (
      control.public_actor_id !== authority.authorization.public_actor_id ||
      control.public_actor_id !== descriptor.request_context.requested_by.public_actor_id ||
      control.principal_digest !== descriptor.request_context.principal_digest ||
      control.expires_at !== authority.authorization.expires_at ||
      authority.authorization.expires_at !== resolved.expires_at
    )
      fail("interactive source authority does not exactly bind its control credential");
  }
}

function planPackage(graph: CapabilityDurablePlanningGraphV1, plan: CapabilityAdapterPlanV1) {
  const matches = graph.plan.runtime_closure.effect_packages.filter(
    (pkg) => pkg.pin.pin_digest === plan.package_pin.pin_digest,
  );
  if (matches.length !== 1 || !exact(matches[0]?.pin, plan.package_pin))
    fail("adapter plan package pin is not exactly closed by the effect package set");
  return matches[0] as (typeof matches)[number];
}

export function assertCapabilityGraphAuthorityClosure(input: {
  graph: CapabilityDurablePlanningGraphV1;
  plans: CapabilityAdapterPlanV1[];
  registry: CapabilityAdapterRegistryV1;
  exactObject: ExactObject;
  resolvedRows: CapabilityResolvedSourceAuthorityBindingV1[];
}): CapabilityResolvedSourceAuthorityBindingV1[] {
  const { graph, plans, registry, exactObject, resolvedRows } = input;
  const runtime = graph.plan.runtime_closure.authority;
  if (
    runtime.scope !== graph.plan.scope ||
    runtime.scope_identity_digest !== graph.plan.scope_identity_digest ||
    runtime.source_authority_set_digest !== graph.plan.source_authority_set_digest
  )
    fail("runtime authority escaped the exact Fabric plan authority");
  const retained: CapabilityResolvedSourceAuthorityBindingV1[] = [];
  const packages = graph.plan.runtime_closure.effect_packages.filter(
    (pkg, index, all) =>
      all.findIndex((candidate) => candidate.pin.pin_digest === pkg.pin.pin_digest) === index,
  );
  for (const pkg of packages) {
    const authenticity = exactObject<PackageAuthenticityBindingV1>(
      "vf.package-authenticity-binding/1",
      pkg.authenticity_binding.authenticity_digest,
    );
    const matches = resolvedRows.filter(
      (row) => row.authenticity_digest === authenticity.authenticity_digest,
    );
    if (matches.length !== 1) fail("package source authority is missing or ambiguous");
    const resolved = exactObject<CapabilityResolvedSourceAuthorityBindingV1>(
      "vf.resolved-source-authority-binding/1",
      (matches[0] as CapabilityResolvedSourceAuthorityBindingV1).binding_digest,
    );
    const authority = exactObject<CapabilitySourceAccessAuthorityBindingV1>(
      "vf.source-access-authority-binding/1",
      resolved.source_access_authority_digest,
    );
    const descriptor = exactObject<CapabilitySourceAccessDescriptorV1>(
      "vf.source-access-descriptor/1",
      authority.source_descriptor_digest,
    );
    assertSourceChain({ graph, pkg, authenticity, resolved, authority, descriptor, exactObject });
    if (!retained.some((row) => row.binding_digest === resolved.binding_digest))
      retained.push(resolved);
  }
  for (const plan of plans) {
    const pkg = planPackage(graph, plan);
    const resolved = retained.find(
      (row) => row.authenticity_digest === pkg.authenticity_binding.authenticity_digest,
    );
    if (!resolved) fail("adapter plan lacks its exact resolved source authority");
    assertPlanAuthority(graph, plan, resolved, registry);
  }
  if (retained.length !== resolvedRows.length)
    fail("resolved source authority set contains an unreferenced or duplicate binding");
  return retained;
}
