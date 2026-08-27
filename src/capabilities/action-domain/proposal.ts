import {
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_ROOT_LOCATOR_KIND,
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  type CanonicalActionRequestV1,
  actionIdempotencyScopeDigest,
  canonicalActionRequestDigest,
  materializeProposal,
} from "../../actions/index.js";
import {
  ACTION_AUTHORITY_BINDING_MODE,
  ACTION_DOMAIN,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "../../actions/public-action-contract.js";
import type { CapabilityConversationProposalBaseV1 as ConversationBase } from "../../orchestrator/conversation/conversation-action-service.js";
import { capabilityClosurePackagePins } from "../planning/closure-packages.js";
import type {
  CapabilityDurablePlanningGraphV1,
  CapabilityFabricPlanV1,
  CapabilityHostActionV1,
} from "../planning/types.js";
import type { CapabilityLockV1 } from "../wire/lock.js";
import { bytewise } from "../wire/primitives.js";
import { capabilityActionPlanDigest } from "./action-plan.js";
import { capabilityPreviewRisk, materializeCapabilityPreview } from "./preview.js";

// Kept local so this module does not make the actions package depend on conversation internals.
type CapabilityConversationProposalBaseV1 = ConversationBase;

function plus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function prerequisites(plan: CapabilityFabricPlanV1) {
  const values = new Map<
    string,
    CapabilityFabricPlanV1["adapter_plans"][number]["user_prerequisites"][number]
  >();
  for (const adapterPlan of plan.adapter_plans)
    for (const row of adapterPlan.user_prerequisites) values.set(JSON.stringify(row), row);
  return [...values.values()].sort((left, right) =>
    bytewise(JSON.stringify(left), JSON.stringify(right)),
  );
}

export function materializeCapabilityConversationProposal(input: {
  request: ActionProposalRequestV1;
  authority: ActionRequestAuthorityV1;
  conversation: CapabilityConversationProposalBaseV1;
  action: CapabilityHostActionV1;
  graph: CapabilityDurablePlanningGraphV1;
  base_lock: CapabilityLockV1 | null;
}) {
  const { request, authority, conversation, action, graph, base_lock } = input;
  const { plan } = graph;
  const locator = {
    kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
    root_session_id: conversation.root_session_id,
  };
  if (authority.authority_scope_digest !== actionIdempotencyScopeDigest(locator))
    throw new Error("capability conversation authority scope mismatch");
  const canonicalRequest: CanonicalActionRequestV1 = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    origin: "conversation",
    principal_digest: authority.principal_digest,
    authority_scope_digest: authority.authority_scope_digest,
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    request: {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      anchor_event_id: request.anchor_event_id,
      expected: structuredClone(request.expected),
      candidate: structuredClone(request.candidate),
    },
  };
  const actionPlan = graph.action_plan;
  const preview = materializeCapabilityPreview({ action, plan, base: base_lock });
  const pins = capabilityClosurePackagePins(
    plan.runtime_closure.packages,
    plan.runtime_closure.effect_packages,
  );
  const proposal = materializeProposal({
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    idempotency_key: request.idempotency_key,
    origin_event_id: request.anchor_event_id,
    domain: ACTION_DOMAIN.CAPABILITY,
    action_root_locator: locator,
    producer_request_binding: {
      kind: ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST,
      digest: canonicalActionRequestDigest(canonicalRequest),
    },
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    execution_object_closure_digest: plan.execution_closure_digest,
    base: {
      root_session_id: conversation.root_session_id,
      conversation_id: conversation.conversation_id,
      revision_id: conversation.revision_id,
      last_seq: conversation.last_seq,
      conversation_lock_digest: conversation.conversation_lock_digest,
      lineage_head_digest: conversation.lineage_head_digest,
      lineage_head_epoch: conversation.lineage_head_epoch,
      capability_scope: plan.scope,
      capability_generation_ordinal: base_lock?.generation_ordinal ?? null,
      capability_generation_id: plan.base_generation_id,
      capability_lock_digest: plan.base_lock_digest,
      capability_parent_generation_digests: plan.base_lock_digest ? [plan.base_lock_digest] : [],
      user_prerequisites: prerequisites(plan),
      authority_binding_mode: ACTION_AUTHORITY_BINDING_MODE.CURRENT,
      authority_epoch: plan.runtime_closure.authority.authority_epoch,
      authority_head_digest: plan.runtime_closure.authority.authority_head_digest,
      repair_authorization_binding_digest: null,
    },
    action: structuredClone(action),
    requested_by: structuredClone(authority.actor),
    risk: capabilityPreviewRisk(preview, plan.scope, action.type),
    effect_classes: [...plan.effect_classes],
    target_set: structuredClone(plan.targets),
    package_pins: pins,
    source_authority_set_digest: plan.source_authority_set_digest,
    adapter_set_digest: plan.adapter_set_digest,
    plan_digest: capabilityActionPlanDigest(actionPlan),
    handoff_selection_digest: null,
    policy_digest: plan.runtime_closure.authority.policy_digest,
    grant_digest: plan.runtime_closure.authority.grant_digest,
    permission_digest: plan.permission_digest,
    reversibility: plan.reversibility,
    preview,
    created_at: plan.created_at,
    expires_at: plus(plan.created_at, 60 * 60_000),
  });
  return { canonical_request: canonicalRequest, action_plan: actionPlan, proposal };
}
