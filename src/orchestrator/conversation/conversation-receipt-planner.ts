import {
  type ActionEffectClass,
  type ActionProposalDraftV1,
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  type CanonicalActionRequestV1,
  EMPTY_ADAPTER_SET_DIGEST,
  EMPTY_PERMISSION_DIGEST,
  EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
  type HostActionV1,
  type JsonValue,
  type Reversibility,
  actionIdempotencyScopeDigest,
  canonicalActionRequestDigest,
  materializeProposal,
} from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import { conversationActionAuthorityHead } from "./conversation-action-planner.js";
import type {
  ConversationReceiptNativePlanV1,
  ConversationReceiptProposalPlanV1,
} from "./conversation-action-receipt-store.js";
import type { LineageActionPlanBindingV1, LineagePlanKindV1 } from "./lineage-action-authority.js";
import type { LineageHeadRecordV1 } from "./lineage-types.js";

export interface ConversationReceiptPlanningSourceV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  last_seq: number;
  conversation_lock_digest: string;
  head: LineageHeadRecordV1;
}

interface ReceiptPlanningInputV1 {
  source: ConversationReceiptPlanningSourceV1;
  request: ActionProposalRequestV1;
  action: HostActionV1;
  authority: ActionRequestAuthorityV1;
  effect_binding: JsonValue;
  native_step: { kind: LineagePlanKindV1; digest: string };
  created_at: string;
}

function plus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function effect(action: HostActionV1): {
  classes: ActionEffectClass[];
  reversibility: Reversibility;
  risk: "medium" | "critical";
} {
  if (
    action.type === "conversation.publish_suspected_literal" ||
    action.type === "conversation.stop_operation" ||
    action.type === "conversation.abandon_revision_operation"
  )
    return {
      classes: ["project-write"],
      reversibility: "irreversible",
      risk: "critical",
    };
  return { classes: ["project-write"], reversibility: "reversible", risk: "medium" };
}

function preview(action: HostActionV1, publicCandidate: ActionProposalRequestV1["candidate"]) {
  const titles: Record<string, [string, string]> = {
    "conversation.select_lineage_head": [
      "Select lineage head",
      "Commit the reviewed lineage leaf.",
    ],
    "conversation.associate_lineages": [
      "Associate lineages",
      "Record an explicit unverified lineage association.",
    ],
    "conversation.publish_suspected_literal": [
      "Publish suspected literal",
      "Publish reviewed staged content to the public conversation.",
    ],
    "conversation.stop_operation": [
      "Stop operation",
      "Request durable cancellation of the selected operation.",
    ],
    "context.compact": ["Compact context", "Commit a bounded public context compaction artifact."],
    "conversation.abandon_revision_operation": [
      "Abandon revision operation",
      "Prove quiescence and abandon the selected revision operation.",
    ],
    "conversation.retry_revision_operation": [
      "Retry revision operation",
      "Start a new reviewed attempt for the failed revision operation.",
    ],
    "conversation.reconcile_revision_operation": [
      "Reconcile revision operation",
      "Resolve the selected recovery state from durable evidence.",
    ],
  };
  const selected = titles[action.type];
  if (!selected) throw new Error("unsupported conversation receipt preview");
  return {
    title: selected[0],
    summary: selected[1],
    after: publicCandidate as unknown as JsonValue,
  };
}

function materializeNativePlan(input: ReceiptPlanningInputV1): ConversationReceiptNativePlanV1 {
  const preimage = {
    schema_version: "1.0" as const,
    action_type: input.action.type as ConversationReceiptNativePlanV1["action_type"],
    root_session_id: input.source.root_session_id,
    expected: {
      conversation_id: input.source.conversation_id,
      revision_id: input.source.revision_id,
      last_seq: input.source.last_seq,
      conversation_lock_digest: input.source.conversation_lock_digest,
      lineage_head_digest: input.source.head.content_digest,
      lineage_head_epoch: input.source.head.head_epoch,
    },
    action: structuredClone(input.action),
    effect_binding: structuredClone(input.effect_binding),
    created_at: input.created_at,
    expires_at: plus(input.created_at, 60 * 60_000),
  };
  return {
    ...preimage,
    plan_digest: digestV1("VF-CONVERSATION-RECEIPT-NATIVE-PLAN\0v1\0", preimage),
  };
}

export function materializeConversationReceiptProposal(input: ReceiptPlanningInputV1): {
  proposal_plan: ConversationReceiptProposalPlanV1;
  proposal: ReturnType<typeof materializeProposal>;
} {
  const locator = {
    kind: "conversation" as const,
    root_session_id: input.source.root_session_id,
  };
  if (input.authority.authority_scope_digest !== actionIdempotencyScopeDigest(locator))
    throw new Error("conversation receipt authority scope mismatch");
  const canonicalRequest: CanonicalActionRequestV1 = {
    schema_version: "1.0",
    origin: "conversation",
    principal_digest: input.authority.principal_digest,
    authority_scope_digest: input.authority.authority_scope_digest,
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    request: structuredClone(input.request),
  };
  const nativePlan = materializeNativePlan(input);
  const effectRule = effect(input.action);
  const actionPlan: LineageActionPlanBindingV1 = {
    schema_version: "1.0",
    domain: "conversation",
    action_root_locator: locator,
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    execution_object_closure_digest: null,
    permission_digest: EMPTY_PERMISSION_DIGEST,
    steps: [
      {
        order: 0,
        step_id: "conversation-receipt-0",
        plan_kind: input.native_step.kind,
        plan_digest: input.native_step.digest,
        target_ids: [],
        effect_classes: effectRule.classes,
        reversibility: effectRule.reversibility,
      },
    ],
  };
  const actionPlanDigest = digestV1("VF-ACTION-PLAN\0v1\0", actionPlan);
  const visible = preview(input.action, input.request.candidate);
  const rules = digestV1("VF-CONVERSATION-RECEIPT-PREVIEW-RULES\0v1\0", {
    schema_version: "1.0",
    action_type: input.action.type,
  });
  const draft: ActionProposalDraftV1 = {
    schema_version: "1.0",
    idempotency_key: input.request.idempotency_key,
    origin_event_id: input.request.anchor_event_id,
    domain: "conversation",
    action_root_locator: locator,
    producer_request_binding: {
      kind: "canonical-action-request",
      digest: canonicalActionRequestDigest(canonicalRequest),
    },
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    execution_object_closure_digest: null,
    base: {
      root_session_id: input.source.root_session_id,
      conversation_id: input.source.conversation_id,
      revision_id: input.source.revision_id,
      last_seq: input.source.last_seq,
      conversation_lock_digest: input.source.conversation_lock_digest,
      lineage_head_digest: input.source.head.content_digest,
      lineage_head_epoch: input.source.head.head_epoch,
      capability_scope: null,
      capability_generation_ordinal: null,
      capability_generation_id: null,
      capability_lock_digest: null,
      capability_parent_generation_digests: [],
      user_prerequisites: [],
      authority_binding_mode: "current",
      ...conversationActionAuthorityHead({
        root_session_id: input.source.root_session_id,
        authority: input.authority,
      }),
      repair_authorization_binding_digest: null,
    },
    action: structuredClone(input.action),
    requested_by: structuredClone(input.authority.actor),
    risk: effectRule.risk,
    effect_classes: effectRule.classes,
    target_set: [],
    package_pins: [],
    source_authority_set_digest: EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
    adapter_set_digest: EMPTY_ADAPTER_SET_DIGEST,
    plan_digest: actionPlanDigest,
    handoff_selection_digest: null,
    policy_digest: digestV1("VF-CONVERSATION-RECEIPT-POLICY\0v1\0", {
      schema_version: "1.0",
      root_session_id: input.source.root_session_id,
      conversation_lock_digest: input.source.conversation_lock_digest,
    }),
    grant_digest: digestV1("VF-CONVERSATION-RECEIPT-GRANT\0v1\0", {
      schema_version: "1.0",
      credential_class: input.authority.actor.credential_class,
    }),
    permission_digest: EMPTY_PERMISSION_DIGEST,
    reversibility: effectRule.reversibility,
    preview: {
      title: visible.title,
      summary: visible.summary,
      action_type: input.action.type,
      planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
      review_fields: [
        {
          json_pointer: "/candidate",
          label: "Requested action",
          before: null,
          after: visible.after,
          private_binding_digest: null,
        },
      ],
      targets: [],
      target_dispositions: [],
      package_pins: [],
      permission_delta: [],
      dependency_delta: [],
      config_diffs: [],
      effect_classes: effectRule.classes,
      enforcement: [],
      reversibility: effectRule.reversibility,
      health_plan: [],
      recovery_actions: ["retry", "inspect-trace"],
      projector_version: "vf-public-projector/1",
      rules_digest: rules,
      redaction_manifest_digest: digestV1("VF-CONVERSATION-RECEIPT-REDACTION-MANIFEST\0v1\0", {
        schema_version: "1.0",
        rules_digest: rules,
        candidate: input.request.candidate,
      }),
    },
    created_at: input.created_at,
    expires_at: plus(input.created_at, 60 * 60_000),
  };
  const proposal = materializeProposal(draft);
  const withoutDigest = {
    schema_version: "1.0" as const,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    proposal,
    canonical_request: canonicalRequest,
    action_plan: actionPlan,
    native_plan: nativePlan,
  };
  return {
    proposal,
    proposal_plan: {
      ...withoutDigest,
      record_digest: digestV1("VF-CONVERSATION-RECEIPT-PROPOSAL-PLAN\0v1\0", withoutDigest),
    },
  };
}
