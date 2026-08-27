import type {
  ActionTargetBindingV1,
  HostRenderedPreviewV1,
  PublicPackagePinV1,
} from "./preview-types.js";
import type { ActionOperationDomainTerminalState } from "./protocol-contract.js";
import type {
  ACTION_TIMELINE_ITEM_KIND,
  ActionApprovalChallengeClass,
  ActionAuthorityBindingMode,
  ActionDecision,
  ActionDelivery,
  ActionDomain,
  ActionEffectClass,
  ActionRisk,
  ActionScope,
  ChallengeClass,
  PUBLIC_ACTION_SCHEMA_VERSION,
  Reversibility,
} from "./public-action-contract.js";
import type { PublicApiErrorBodyV1 } from "./public-error-contract.js";
import type { LineageNodeIdentityV1 } from "./public-error-details-contract.js";
import type {
  ActionOperationEventV1,
  PublicOperationProgressV1,
  PublicTargetResultV1,
} from "./public-operation-dto.js";
import type { ActionOperationState, HostActionKind, PublicActor, RecoveryAction } from "./types.js";

export type {
  ActionOperationEventV1,
  PublicActionTargetSubjectV1,
  PublicActionTargetV1,
  PublicOperationProgressV1,
  PublicTargetResultV1,
} from "./public-operation-dto.js";
export interface PublicActionProposalViewV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  proposal_id: string;
  proposal_digest: string;
  origin_event_id: string | null;
  action_type: HostActionKind;
  domain: ActionDomain;
  scope: ActionScope;
  authority_binding_mode: ActionAuthorityBindingMode;
  risk: ActionRisk;
  effect_classes: ActionEffectClass[];
  targets: ActionTargetBindingV1[];
  package_pins: PublicPackagePinV1[];
  adapter_set_digest: string;
  plan_digest: string;
  policy_digest: string;
  permission_digest: string;
  reversibility: Reversibility;
  preview: HostRenderedPreviewV1;
  created_at: string;
  expires_at: string;
}
export interface PublicActionApprovalViewV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  approval_id: string;
  approval_digest: string;
  proposal_id: string;
  proposal_digest: string;
  decision: ActionDecision;
  challenge_class: ChallengeClass;
  decided_by: PublicActor;
  decided_at: string;
  expires_at: string;
}
export interface ActionOperationViewV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  operation_id: string | null;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string | null;
  approval_digest: string | null;
  correlation_id: string;
  domain: ActionDomain;
  state: ActionOperationState;
  phase_sequence: number | null;
  latest_event_cursor: string | null;
  progress: PublicOperationProgressV1[];
  targets: PublicTargetResultV1[];
  delivery: ActionDelivery;
  result_ref: string | null;
  error: PublicApiErrorBodyV1 | null;
  recovery_actions: RecoveryAction[];
  created_at: string;
  updated_at: string;
}
export interface ActionProposalResponseV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  proposal: PublicActionProposalViewV1;
  approval: PublicActionApprovalViewV1 | null;
  operation: ActionOperationViewV1;
}
export interface ActionApprovalChallengeRequestV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  proposal_digest: string;
  challenge_class: ActionApprovalChallengeClass;
}
export interface ActionApprovalChallengeResponseV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  challenge_id: string;
  challenge_class: ActionApprovalChallengeRequestV1["challenge_class"];
  display_phrase: string;
  expires_at: string;
}
export interface ActionApprovalRequestV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  proposal_digest: string;
  decision: ActionDecision;
  challenge_id: string | null;
  challenge_response: string | null;
}
export interface ActionCommitRequestV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  proposal_digest: string;
  approval_id: string;
}
export interface ActionCancelRequestV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  proposal_digest: string;
  reason: string | null;
}
export interface PendingActionProposalListResponseV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  items: ActionProposalResponseV1[];
  next_cursor: string | null;
  authority_watermark: string;
}
export interface ActionApprovalResponseV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  approval: PublicActionApprovalViewV1;
  operation: ActionOperationViewV1;
}
export interface ActionMutationResponseV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  operation: ActionOperationViewV1;
}
export interface ActionOperationsPageV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  items: ActionOperationViewV1[];
  next_cursor: string | null;
  proposal_set_watermark: string;
}
export interface ActionTimelineBoundaryItemV1 {
  kind: typeof ACTION_TIMELINE_ITEM_KIND.REVISION_BOUNDARY;
  boundary_id: string;
  from: LineageNodeIdentityV1;
  to: LineageNodeIdentityV1;
  handoff_id: string;
  prompt_projection_digest: string;
}
export interface ActionTimelineStartItemV1 {
  kind: typeof ACTION_TIMELINE_ITEM_KIND.CONVERSATION_START;
  revision_ordinal: number;
  conversation_id: string;
  revision_id: string;
  anchor_id: string;
  action_operations: ActionOperationsPageV1;
}
export interface ActionTimelineEventItemV1<Event = unknown, Interaction = unknown> {
  kind: typeof ACTION_TIMELINE_ITEM_KIND.CONVERSATION_EVENT;
  revision_ordinal: number;
  event: Event;
  interaction: Interaction;
  action_operations: ActionOperationsPageV1;
}
export type ActionTimelineItemV1<Event = unknown, Interaction = unknown> =
  | ActionTimelineBoundaryItemV1
  | ActionTimelineStartItemV1
  | ActionTimelineEventItemV1<Event, Interaction>;
export interface ActionTimelineResponseV1<Event = unknown, Interaction = unknown> {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  root_session_id: string;
  head: LineageNodeIdentityV1;
  head_epoch: number;
  head_digest: string;
  items: ActionTimelineItemV1<Event, Interaction>[];
  next_cursor: string | null;
}
export interface ActionOperationEventsResponseV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  items: ActionOperationEventV1[];
  next_cursor: string | null;
}
export interface ActionDomainTerminalReceiptV1 {
  schema_version: typeof PUBLIC_ACTION_SCHEMA_VERSION;
  operation_id: string;
  proposal_id: string;
  proposal_digest: string;
  dispatch_record_digest: string;
  outcome: ActionOperationDomainTerminalState;
  reason_code: string | null;
  recorded_at: string;
  receipt_digest: string;
}
