import {
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
import { digestV1 } from "../../durability/index.js";
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
  created_at: string;
}

export type ContinueMessageActionPlanInputV1 = Omit<
  ConversationRevisionActionPlanInputV1,
  "action"
> & { request: MessageRequest & { target_participants: "all" | string[] } };

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

export function materializeConversationRevisionActionPlan(
  rootSessionId: string,
  revisionPlan: RevisionPreparationPlanV1,
): LineageActionPlanBindingV1 {
  return {
    schema_version: "1.0",
    domain: "conversation",
    action_root_locator: { kind: "conversation", root_session_id: rootSessionId },
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    execution_object_closure_digest: null,
    permission_digest: EMPTY_PERMISSION_DIGEST,
    steps: [
      {
        order: 0,
        step_id: "revision-operation-0",
        plan_kind: "revision-operation",
        plan_digest: revisionPlan.plan_digest,
        target_ids: [],
        effect_classes: ["project-write"],
        reversibility: "reversible",
      },
    ],
  };
}

function actionPreview(action: ConversationRevisionMutationV1): {
  title: string;
  summary: string;
  pointer: string;
  label: string;
  after: JsonValue;
} {
  if (action.type === "conversation.continue_message")
    return {
      title: "Continue conversation",
      summary: "Create a child revision with the verified shared context.",
      pointer: "/content",
      label: "Continuation message",
      after: action.content,
    };
  if (action.type === "conversation.add_participant")
    return {
      title: "Add conversation participant",
      summary: "Create a child revision with the additional fresh participant.",
      pointer: "/participant",
      label: "Participant",
      after: structuredClone(action.participant) as unknown as JsonValue,
    };
  if (action.type === "conversation.remove_participant")
    return {
      title: "Remove conversation participant",
      summary: "Create a child revision without the selected participant.",
      pointer: "/participant_id",
      label: "Participant ID",
      after: action.participant_id,
    };
  if (action.type === "conversation.update_participant")
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
  const locator = { kind: "conversation" as const, root_session_id: input.root_session_id };
  if (input.authority.authority_scope_digest !== actionIdempotencyScopeDigest(locator))
    throw new Error("conversation revision authority scope mismatch");
  const expected = {
    mode: "writable-revision" as const,
    conversation_id: input.conversation_id,
    revision_id: input.revision_id,
    last_seq: input.last_seq,
    conversation_lock_digest: input.conversation_lock_digest,
  };
  const action = structuredClone(input.action);
  const preview = actionPreview(action);
  const canonicalRequest: CanonicalActionRequestV1 = {
    schema_version: "1.0",
    origin: "conversation",
    principal_digest: input.authority.principal_digest,
    authority_scope_digest: input.authority.authority_scope_digest,
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    request: {
      schema_version: "1.0",
      anchor_event_id: input.anchor_event_id ?? null,
      expected,
      candidate: action,
    },
  };
  const actionPlan = materializeConversationRevisionActionPlan(
    input.root_session_id,
    input.revision_plan,
  );
  const actionPlanDigest = digestV1("VF-ACTION-PLAN\0v1\0", actionPlan);
  const authorityHead = conversationActionAuthorityHead(input);
  const expiresAt = plusMilliseconds(input.created_at, 60 * 60_000);
  const previewRules = digestV1("VF-CONVERSATION-ACTION-PREVIEW-RULES\0v1\0", {
    schema_version: "1.0",
    action_type: action.type,
  });
  const draft: ActionProposalDraftV1 = {
    schema_version: "1.0",
    idempotency_key: input.message_key,
    origin_event_id: input.anchor_event_id ?? null,
    domain: "conversation",
    action_root_locator: locator,
    producer_request_binding: {
      kind: "canonical-action-request",
      digest: canonicalActionRequestDigest(canonicalRequest),
    },
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
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
      authority_binding_mode: "current",
      ...authorityHead,
      repair_authorization_binding_digest: null,
    },
    action,
    requested_by: structuredClone(input.authority.actor),
    risk: "medium",
    effect_classes: ["project-write"],
    target_set: [],
    package_pins: [],
    source_authority_set_digest: EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
    adapter_set_digest: EMPTY_ADAPTER_SET_DIGEST,
    plan_digest: actionPlanDigest,
    handoff_selection_digest: input.revision_plan.handoff_selection_plan_digest,
    policy_digest: digestV1("VF-CONVERSATION-ACTION-POLICY\0v1\0", {
      schema_version: "1.0",
      root_session_id: input.root_session_id,
      conversation_lock_digest: input.conversation_lock_digest,
    }),
    grant_digest: digestV1("VF-CONVERSATION-ACTION-GRANT\0v1\0", {
      schema_version: "1.0",
      credential_class: input.authority.actor.credential_class,
    }),
    permission_digest: EMPTY_PERMISSION_DIGEST,
    reversibility: "reversible",
    preview: {
      title: preview.title,
      summary: preview.summary,
      action_type: action.type,
      planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
      review_fields: [
        {
          json_pointer: preview.pointer,
          label: preview.label,
          before: null,
          after: preview.after,
          private_binding_digest: null,
        },
      ],
      targets: [],
      target_dispositions: [],
      package_pins: [],
      permission_delta: [],
      dependency_delta: [],
      config_diffs: [],
      effect_classes: ["project-write"],
      enforcement: [],
      reversibility: "reversible",
      health_plan: [],
      recovery_actions: ["retry", "inspect-trace"],
      projector_version: "vf-public-projector/1",
      rules_digest: previewRules,
      redaction_manifest_digest: digestV1("VF-CONVERSATION-ACTION-REDACTION-MANIFEST\0v1\0", {
        schema_version: "1.0",
        rules_digest: previewRules,
        action,
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
      type: "conversation.continue_message",
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
    decision: "approved",
    decided_by: structuredClone(input.authority.actor),
    challenge_class:
      input.authority.actor.credential_class === "automation-grant"
        ? "automation-grant"
        : "normal-confirm",
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
      type: "conversation.continue_message",
      content: input.request.content,
      target_participants: input.request.target_participants,
      ...(input.request.quote_refs
        ? { quote_refs: structuredClone(input.request.quote_refs) }
        : {}),
    },
  });
}
