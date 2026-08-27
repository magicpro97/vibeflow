import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_ROOT_LOCATOR_KIND,
  type ActionApprovalV1,
  type ActionProposalDraftV1,
  type ActionProposalV1,
  type ActionRequestAuthorityV1,
  type CanonicalActionRequestV1,
  EMPTY_ADAPTER_SET_DIGEST,
  EMPTY_PERMISSION_DIGEST,
  EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
  type JsonValue,
  actionIdempotencyScopeDigest,
  canonicalActionRequestDigest,
  deriveOperationId,
  materializeApproval,
  materializeProposal,
} from "../../actions/index.js";
import {
  ACTION_AUTHORITY_BINDING_MODE,
  ACTION_CHALLENGE_CLASS,
  ACTION_DECISION,
  ACTION_DOMAIN,
  ACTION_EFFECT_CLASS,
  ACTION_EXPECTED_SOURCE_MODE,
  ACTION_PLANNING_MODE,
  ACTION_PLANNING_NETWORK_READ_VALUE,
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_REVERSIBILITY_VALUE,
  ACTION_RISK,
  CREDENTIAL_CLASS,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "../../actions/public-action-contract.js";
import { digestV1 } from "../../durability/index.js";
import type { ConversationMessageQueueTargetParticipantsV1 } from "./conversation-message-queue-contract.js";
import {
  conversationRevisionActionPlanDigest,
  materializeConversationRevisionActionPlan,
} from "./conversation-revision-action-plan.js";
import { conversationRevisionPolicyAuthorityDigest } from "./conversation-revision-policy-authority.js";
import type { LineageActionPlanBindingV1 } from "./lineage-action-authority.js";
import type { RevisionPreparationPlanV1 } from "./lineage-revision-operation.js";
import type { LineageHeadRecordV1 } from "./lineage-types.js";
import type { ConversationRevisionMutationV1 } from "./revision-action-manifest.js";
import type { MessageRequest } from "./types.js";

export interface ConversationRevisionActionPlanV1 {
  canonical_request: CanonicalActionRequestV1;
  action_plan: LineageActionPlanBindingV1;
  proposal: ActionProposalV1;
  approval: ActionApprovalV1;
  operation_id: string;
}

export type ConversationRevisionProposalPlanV1 = Omit<
  ConversationRevisionActionPlanV1,
  "approval" | "operation_id"
>;
export type ContinueMessageActionPlanV1 = ConversationRevisionActionPlanV1;
export type ContinueMessageProposalPlanV1 = ConversationRevisionProposalPlanV1;

export interface ConversationRevisionActionPlanInputV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  last_seq: number;
  conversation_lock_digest: string;
  head: LineageHeadRecordV1;
  action: ConversationRevisionMutationV1;
  anchor_event_id?: string | null;
  message_key: string;
  authority: ActionRequestAuthorityV1;
  revision_plan: RevisionPreparationPlanV1;
  topology_authority?: ConversationRevisionTopologyProposalAuthorityV1;
  created_at: string;
}

export interface ConversationRevisionTopologyProposalAuthorityV1 {
  before: JsonValue;
  after: JsonValue;
  before_topology_digest: string;
  topology_digest: string;
  resolved_binding_set_digest: string;
}

export type ContinueMessageActionPlanInputV1 = Omit<
  ConversationRevisionActionPlanInputV1,
  "action"
> & {
  request: MessageRequest & {
    target_participants: ConversationMessageQueueTargetParticipantsV1;
  };
};

export function conversationActionAuthorityHead(input: {
  root_session_id: string;
  authority: ActionRequestAuthorityV1;
}): { authority_epoch: 0; authority_head_digest: string } {
  return {
    authority_epoch: 0,
    authority_head_digest: digestV1("VF-CONVERSATION-ACTION-AUTHORITY-HEAD\0v1\0", {
      schema_version: "1.0",
      root_session_id: input.root_session_id,
      principal_digest: input.authority.principal_digest,
      authority_scope_digest: input.authority.authority_scope_digest,
      actor: input.authority.actor,
    }),
  };
}

function plusMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

export { materializeConversationRevisionActionPlan } from "./conversation-revision-action-plan.js";

function actionPreview(action: ConversationRevisionMutationV1): {
  title: string;
  summary: string;
  pointer: string;
  label: string;
  after: JsonValue;
} {
  if (action.type === HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE)
    return {
      title: "Continue conversation",
      summary: "Create a child revision with the verified shared context.",
      pointer: "/content",
      label: "Continuation message",
      after: action.content,
    };
  if (action.type === HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT)
    return {
      title: "Add conversation participant",
      summary: "Create a child revision with the additional fresh participant.",
      pointer: "/participant",
      label: "Participant",
      after: structuredClone(action.participant) as unknown as JsonValue,
    };
  if (action.type === HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT)
    return {
      title: "Remove conversation participant",
      summary: "Create a child revision without the selected participant.",
      pointer: "/participant_id",
      label: "Participant ID",
      after: action.participant_id,
    };
  if (action.type === HOST_ACTION_KIND.CONVERSATION_UPDATE_PARTICIPANT)
    return {
      title: "Update conversation participant",
      summary: "Create a child revision with the changed participant binding.",
      pointer: "/changes",
      label: "Participant changes",
      after: structuredClone(action.changes) as unknown as JsonValue,
    };
  return {
    title: "Update conversation settings",
    summary: "Create a child revision with the changed conversation settings.",
    pointer: "/changes",
    label: "Setting changes",
    after: structuredClone(action.changes) as unknown as JsonValue,
  };
}

export function materializeConversationRevisionProposal(
  input: ConversationRevisionActionPlanInputV1,
): ConversationRevisionProposalPlanV1 {
  const locator = {
    kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
    root_session_id: input.root_session_id,
  };
  if (input.authority.authority_scope_digest !== actionIdempotencyScopeDigest(locator))
    throw new Error("conversation revision authority scope mismatch");
  const expected = {
    mode: ACTION_EXPECTED_SOURCE_MODE.WRITABLE_REVISION,
    conversation_id: input.conversation_id,
    revision_id: input.revision_id,
    last_seq: input.last_seq,
    conversation_lock_digest: input.conversation_lock_digest,
  };
  const action = structuredClone(input.action);
  const preview = actionPreview(action);
  const canonicalRequest: CanonicalActionRequestV1 = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    origin: ACTION_DOMAIN.CONVERSATION,
    principal_digest: input.authority.principal_digest,
    authority_scope_digest: input.authority.authority_scope_digest,
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    request: {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      anchor_event_id: input.anchor_event_id ?? null,
      expected,
      candidate: action,
    },
  };
  const actionPlan = materializeConversationRevisionActionPlan(
    input.root_session_id,
    input.revision_plan,
  );
  const actionPlanDigest = conversationRevisionActionPlanDigest(
    input.root_session_id,
    input.revision_plan,
  );
  const authorityHead = conversationActionAuthorityHead(input);
  const expiresAt = plusMilliseconds(input.created_at, 60 * 60_000);
  const policyDigest = input.topology_authority
    ? conversationRevisionPolicyAuthorityDigest({
        root_session_id: input.root_session_id,
        conversation_lock_digest: input.conversation_lock_digest,
        topology_digest: input.topology_authority.topology_digest,
        resolved_binding_set_digest: input.topology_authority.resolved_binding_set_digest,
      })
    : digestV1("VF-CONVERSATION-ACTION-POLICY\0v1\0", {
        schema_version: "1.0",
        root_session_id: input.root_session_id,
        conversation_lock_digest: input.conversation_lock_digest,
      });
  const previewRules = digestV1("VF-CONVERSATION-ACTION-PREVIEW-RULES\0v1\0", {
    schema_version: "1.0",
    action_type: action.type,
    before_topology_digest: input.topology_authority?.before_topology_digest ?? null,
    topology_digest: input.topology_authority?.topology_digest ?? null,
  });
  const reviewFields = [
    {
      json_pointer: preview.pointer,
      label: preview.label,
      before: null,
      after: preview.after,
      private_binding_digest: null,
    },
    ...(input.topology_authority
      ? [
          {
            json_pointer: "/derived_topology",
            label: "Derived policy, roles, sandbox, and tools",
            before: input.topology_authority.before,
            after: input.topology_authority.after,
            private_binding_digest: policyDigest,
          },
        ]
      : []),
  ].sort((left, right) =>
    Buffer.compare(Buffer.from(left.json_pointer), Buffer.from(right.json_pointer)),
  );
  const draft: ActionProposalDraftV1 = {
    schema_version: "1.0",
    idempotency_key: input.message_key,
    origin_event_id: input.anchor_event_id ?? null,
    domain: ACTION_DOMAIN.CONVERSATION,
    action_root_locator: locator,
    producer_request_binding: {
      kind: ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST,
      digest: canonicalActionRequestDigest(canonicalRequest),
    },
    planning_options: {
      mode: ACTION_PLANNING_MODE.DURABLE,
      network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
    },
    execution_object_closure_digest: null,
    base: {
      root_session_id: input.root_session_id,
      conversation_id: input.conversation_id,
      revision_id: input.revision_id,
      last_seq: input.last_seq,
      conversation_lock_digest: input.conversation_lock_digest,
      lineage_head_digest: input.head.content_digest,
      lineage_head_epoch: input.head.head_epoch,
      capability_scope: null,
      capability_generation_ordinal: null,
      capability_generation_id: null,
      capability_lock_digest: null,
      capability_parent_generation_digests: [],
      user_prerequisites: [],
      authority_binding_mode: ACTION_AUTHORITY_BINDING_MODE.CURRENT,
      ...authorityHead,
      repair_authorization_binding_digest: null,
    },
    action,
    requested_by: structuredClone(input.authority.actor),
    risk: ACTION_RISK.MEDIUM,
    effect_classes: [ACTION_EFFECT_CLASS.PROJECT_WRITE],
    target_set: [],
    package_pins: [],
    source_authority_set_digest: EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
    adapter_set_digest: EMPTY_ADAPTER_SET_DIGEST,
    plan_digest: actionPlanDigest,
    handoff_selection_digest: input.revision_plan.handoff_selection_plan_digest,
    policy_digest: policyDigest,
    grant_digest: digestV1("VF-CONVERSATION-ACTION-GRANT\0v1\0", {
      schema_version: "1.0",
      credential_class: input.authority.actor.credential_class,
    }),
    permission_digest: EMPTY_PERMISSION_DIGEST,
    reversibility: ACTION_REVERSIBILITY_VALUE.REVERSIBLE,
    preview: {
      title: preview.title,
      summary: preview.summary,
      action_type: action.type,
      planning_options: {
        mode: ACTION_PLANNING_MODE.DURABLE,
        network_read: ACTION_PLANNING_NETWORK_READ_VALUE.ORDINARY_HOST_POLICY,
      },
      review_fields: reviewFields,
      targets: [],
      target_dispositions: [],
      package_pins: [],
      permission_delta: [],
      dependency_delta: [],
      config_diffs: [],
      effect_classes: [ACTION_EFFECT_CLASS.PROJECT_WRITE],
      enforcement: [],
      reversibility: ACTION_REVERSIBILITY_VALUE.REVERSIBLE,
      health_plan: [],
      recovery_actions: ["retry", "inspect-trace"],
      projector_version: ACTION_PREVIEW_PROJECTOR_VERSION,
      rules_digest: previewRules,
      redaction_manifest_digest: digestV1("VF-CONVERSATION-ACTION-REDACTION-MANIFEST\0v1\0", {
        schema_version: "1.0",
        rules_digest: previewRules,
        action,
        before_topology_digest: input.topology_authority?.before_topology_digest ?? null,
        topology_digest: input.topology_authority?.topology_digest ?? null,
      }),
    },
    created_at: input.created_at,
    expires_at: expiresAt,
  };
  const proposal = materializeProposal(draft);
  return { canonical_request: canonicalRequest, action_plan: actionPlan, proposal };
}

export function materializeContinueMessageProposal(
  input: ContinueMessageActionPlanInputV1,
): ContinueMessageProposalPlanV1 {
  return materializeConversationRevisionProposal({
    ...input,
    action: {
      type: HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE,
      content: input.request.content,
      target_participants: input.request.target_participants,
      ...(input.request.quote_refs
        ? { quote_refs: structuredClone(input.request.quote_refs) }
        : {}),
    },
  });
}

export function materializeConversationRevisionAction(
  input: ConversationRevisionActionPlanInputV1,
): ConversationRevisionActionPlanV1 {
  const planned = materializeConversationRevisionProposal(input);
  const approval = materializeApproval(planned.proposal, {
    decision: ACTION_DECISION.APPROVED,
    decided_by: structuredClone(input.authority.actor),
    challenge_class:
      input.authority.actor.credential_class === CREDENTIAL_CLASS.AUTOMATION_GRANT
        ? ACTION_CHALLENGE_CLASS.AUTOMATION_GRANT
        : ACTION_CHALLENGE_CLASS.NORMAL_CONFIRM,
    challenge_digest: null,
    decided_at: input.created_at,
    expires_at: plusMilliseconds(input.created_at, 30 * 60_000),
  });
  return {
    ...planned,
    approval,
    operation_id: deriveOperationId(planned.proposal, approval.approval_id),
  };
}

export function materializeContinueMessageAction(
  input: ContinueMessageActionPlanInputV1,
): ContinueMessageActionPlanV1 {
  return materializeConversationRevisionAction({
    ...input,
    action: {
      type: HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE,
      content: input.request.content,
      target_participants: input.request.target_participants,
      ...(input.request.quote_refs
        ? { quote_refs: structuredClone(input.request.quote_refs) }
        : {}),
    },
  });
}
