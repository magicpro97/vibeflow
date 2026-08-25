import {
  type ActionRequestAuthorityV1,
  type CanonicalActionRequestV1,
  canonicalActionRequestDigest,
  materializeProposal,
} from "../../actions/index.js";
import { capabilityActionPlanDigest } from "../../capabilities/action-domain/action-plan.js";
import {
  capabilityPreviewRisk,
  materializeCapabilityPreview,
} from "../../capabilities/action-domain/preview.js";
import type { CapabilityCliMutationRequestExecutionV1 } from "../../capabilities/cli/ports.js";
import { capabilityClosurePackagePins } from "../../capabilities/planning/closure-packages.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityHostActionV1,
} from "../../capabilities/planning/types.js";
import type { CapabilityFabricServiceV1 } from "../../capabilities/service.js";

type CapabilityRequest = CapabilityCliMutationRequestExecutionV1["request"];

function plus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function prerequisites(plan: CapabilityDurablePlanningGraphV1["plan"]) {
  const rows = new Map<
    string,
    CapabilityDurablePlanningGraphV1["plan"]["adapter_plans"][number]["user_prerequisites"][number]
  >();
  for (const adapterPlan of plan.adapter_plans)
    for (const row of adapterPlan.user_prerequisites) rows.set(JSON.stringify(row), row);
  return [...rows.values()].sort((left, right) =>
    Buffer.from(JSON.stringify(left)).compare(Buffer.from(JSON.stringify(right))),
  );
}

export function standaloneCapabilityCanonicalRequest(
  authority: ActionRequestAuthorityV1,
  request: CapabilityRequest,
): CanonicalActionRequestV1 {
  return {
    schema_version: "1.0",
    origin: "standalone",
    principal_digest: authority.principal_digest,
    authority_scope_digest: authority.authority_scope_digest,
    scope: request.scope,
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    action: structuredClone(request.action),
  };
}

export function materializeStandaloneCapabilityProposal(input: {
  service: CapabilityFabricServiceV1;
  authority: ActionRequestAuthorityV1;
  request: CapabilityRequest;
  action: CapabilityHostActionV1;
  graph: CapabilityDurablePlanningGraphV1;
}) {
  const { service, authority, request, action, graph } = input;
  const canonical_request = standaloneCapabilityCanonicalRequest(authority, request);
  const baseLock = service.options.storage.readStatus().lock;
  const { plan } = graph;
  const preview = materializeCapabilityPreview({ action, plan, base: baseLock });
  const proposal = materializeProposal({
    schema_version: "1.0",
    idempotency_key: request.idempotency_key,
    origin_event_id: null,
    domain: "capability",
    action_root_locator: {
      kind: "capability",
      scope: request.scope,
      scope_identity_digest: service.options.storage.scopeIdentityDigest,
    },
    producer_request_binding: {
      kind: "canonical-action-request",
      digest: canonicalActionRequestDigest(canonical_request),
    },
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    execution_object_closure_digest: plan.execution_closure_digest,
    base: {
      root_session_id: null,
      conversation_id: null,
      revision_id: null,
      last_seq: null,
      conversation_lock_digest: null,
      lineage_head_digest: null,
      lineage_head_epoch: null,
      capability_scope: plan.scope,
      capability_generation_ordinal: baseLock?.generation_ordinal ?? null,
      capability_generation_id: plan.base_generation_id,
      capability_lock_digest: plan.base_lock_digest,
      capability_parent_generation_digests: plan.base_lock_digest ? [plan.base_lock_digest] : [],
      user_prerequisites: prerequisites(plan),
      authority_binding_mode: "current",
      authority_epoch: plan.runtime_closure.authority.authority_epoch,
      authority_head_digest: plan.runtime_closure.authority.authority_head_digest,
      repair_authorization_binding_digest: null,
    },
    action: structuredClone(action),
    requested_by: structuredClone(authority.actor),
    risk: capabilityPreviewRisk(preview, plan.scope, action.type),
    effect_classes: [...plan.effect_classes],
    target_set: structuredClone(plan.targets),
    package_pins: capabilityClosurePackagePins(
      plan.runtime_closure.packages,
      plan.runtime_closure.effect_packages,
    ),
    source_authority_set_digest: plan.source_authority_set_digest,
    adapter_set_digest: plan.adapter_set_digest,
    plan_digest: capabilityActionPlanDigest(graph.action_plan),
    handoff_selection_digest: null,
    policy_digest: plan.runtime_closure.authority.policy_digest,
    grant_digest: plan.runtime_closure.authority.grant_digest,
    permission_digest: plan.permission_digest,
    reversibility: plan.reversibility,
    preview,
    created_at: plan.created_at,
    expires_at: plus(plan.created_at, 60 * 60_000),
  });
  return { canonical_request, proposal };
}
