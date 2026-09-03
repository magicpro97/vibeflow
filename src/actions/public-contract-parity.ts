import type { HOST_ACTION_KIND_VALUES } from "./host-action-contract.js";
import type {
  ActionTargetBindingV1,
  CapabilityTargetDispositionV1,
  HostRenderedPreviewV1,
  PublicConfigDiffV1,
  PublicDependencyDeltaV1,
  PublicEnforcementDisclosureV1,
  PublicHealthPlanV1,
  PublicPackagePinV1,
  PublicPermissionDeltaV1,
  PublicReviewFieldV1,
} from "./preview-types.js";
import type {
  ACTION_OPERATION_EVENT_FIELDS,
  ACTION_OPERATION_STATES,
} from "./protocol-contract.js";
import type {
  ACTION_APPROVAL_CHALLENGE_CLASSES,
  ACTION_APPROVAL_CHALLENGE_REQUEST_FIELDS,
  ACTION_APPROVAL_CHALLENGE_RESPONSE_FIELDS,
  ACTION_APPROVAL_FIELDS,
  ACTION_APPROVAL_REQUEST_FIELDS,
  ACTION_APPROVAL_RESPONSE_FIELDS,
  ACTION_CANCEL_REQUEST_FIELDS,
  ACTION_COMMIT_REQUEST_FIELDS,
  ACTION_CONFIG_DIFF_FIELDS,
  ACTION_CONFIG_DIFF_MODES,
  ACTION_DECISIONS,
  ACTION_DELIVERY,
  ACTION_DEPENDENCY_CHANGES,
  ACTION_DEPENDENCY_DELTA_FIELDS,
  ACTION_DOMAINS,
  ACTION_DOMAIN_TERMINAL_RECEIPT_FIELDS,
  ACTION_EFFECT_CLASSES,
  ACTION_ENFORCEMENT_FIELDS,
  ACTION_EXPECTED_SOURCE_MODE,
  ACTION_EXPECTED_SOURCE_MODES,
  ACTION_HEALTH_PLAN_FIELDS,
  ACTION_HEALTH_PLAN_KINDS,
  ACTION_HEALTH_PLAN_RETRIES,
  ACTION_LINEAGE_RECOVERY_EXPECTATION_FIELDS,
  ACTION_MUTATION_RESPONSE_FIELDS,
  ACTION_OPERATIONS_PAGE_FIELDS,
  ACTION_OPERATION_EVENTS_RESPONSE_FIELDS,
  ACTION_OPERATION_FIELDS,
  ACTION_PACKAGE_PIN_FIELDS,
  ACTION_PACKAGE_PIN_SOURCE_KINDS,
  ACTION_PACKAGE_PIN_TRUST,
  ACTION_PERMISSION_CHANGES,
  ACTION_PERMISSION_DELTA_FIELDS,
  ACTION_PERMISSION_ENFORCEMENT,
  ACTION_PLANNING_MODES,
  ACTION_PLANNING_NETWORK_READ,
  ACTION_PLANNING_OPTIONS_FIELDS,
  ACTION_PREVIEW_FIELDS,
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_PROGRESS_FIELDS,
  ACTION_PROPOSAL_FIELDS,
  ACTION_PROPOSAL_REQUEST_FIELDS,
  ACTION_PROPOSAL_RESPONSE_FIELDS,
  ACTION_REVERSIBILITY,
  ACTION_REVIEW_FIELD_FIELDS,
  ACTION_RISKS,
  ACTION_SCOPES,
  ACTION_TARGET_BINDING_FIELDS,
  ACTION_TARGET_DISPOSITION_EXECUTION,
  ACTION_TARGET_DISPOSITION_EXECUTION_VALUE,
  ACTION_TARGET_DISPOSITION_FIELDS,
  ACTION_TARGET_MANUAL_REASON_CODES,
  ACTION_TARGET_REQUIRED_USER_ACTION_REASON_CODES,
  ACTION_TARGET_UNSUPPORTED_REASON_CODES,
  ACTION_TIMELINE_ITEM_KINDS,
  ACTION_WRITABLE_REVISION_EXPECTATION_FIELDS,
  ACTOR_KINDS,
  CREDENTIAL_CLASSES,
  PENDING_ACTION_RESPONSE_FIELDS,
  PUBLIC_ACTION_SCHEMA_VERSION,
  PUBLIC_ACTOR_FIELDS,
  TIMELINE_BOUNDARY_FIELDS,
  TIMELINE_EVENT_FIELDS,
  TIMELINE_HEAD_FIELDS,
  TIMELINE_RESPONSE_FIELDS,
  TIMELINE_START_FIELDS,
} from "./public-action-contract.js";
import type { PUBLIC_API_ERROR_FIELDS, PUBLIC_RECOVERY_ACTIONS } from "./public-error-contract.js";
import type {
  PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_FIELDS,
  PUBLIC_ACTION_TARGET_SUBJECT_KIND,
  PUBLIC_OPERATION_PROGRESS_FIELDS,
  PUBLIC_OPERATION_PROGRESS_STATUSES,
  PUBLIC_TARGET_RESULT_FIELDS,
  PUBLIC_TARGET_RESULT_HEALTHS,
  PUBLIC_TARGET_RESULT_OUTCOMES,
} from "./public-operation-contract.js";
import type {
  PublicActionTargetSubjectV1,
  PublicActionTargetV1,
  PublicOperationProgressV1,
  PublicTargetResultV1,
} from "./public-operation-dto.js";
import type {
  ActionApprovalChallengeRequestV1,
  ActionApprovalChallengeResponseV1,
  ActionApprovalRequestV1,
  ActionApprovalResponseV1,
  ActionCancelRequestV1,
  ActionCommitRequestV1,
  ActionDomainTerminalReceiptV1,
  ActionMutationResponseV1,
  ActionOperationEventV1,
  ActionOperationEventsResponseV1,
  ActionOperationViewV1,
  ActionOperationsPageV1,
  ActionProposalResponseV1,
  ActionTimelineBoundaryItemV1,
  ActionTimelineEventItemV1,
  ActionTimelineResponseV1,
  ActionTimelineStartItemV1,
  PendingActionProposalListResponseV1,
  PublicActionApprovalViewV1,
  PublicActionProposalViewV1,
} from "./public-types.js";
import type {
  ActionPlanningOptionsV1,
  ActionProposalRequestV1,
  ExpectedActionSourceV1,
  PublicActor,
} from "./types.js";

type SameKeys<Shape, Fields extends readonly PropertyKey[]> = Exclude<
  keyof Shape,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof Shape> extends never
    ? true
    : false
  : false;

type SameUnion<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;

type FieldContracts = {
  proposalRequest: SameKeys<ActionProposalRequestV1, typeof ACTION_PROPOSAL_REQUEST_FIELDS>;
  writableExpectation: SameKeys<
    Extract<ExpectedActionSourceV1, { mode: typeof ACTION_EXPECTED_SOURCE_MODE.WRITABLE_REVISION }>,
    typeof ACTION_WRITABLE_REVISION_EXPECTATION_FIELDS
  >;
  recoveryExpectation: SameKeys<
    Extract<ExpectedActionSourceV1, { mode: typeof ACTION_EXPECTED_SOURCE_MODE.LINEAGE_RECOVERY }>,
    typeof ACTION_LINEAGE_RECOVERY_EXPECTATION_FIELDS
  >;
  challengeRequest: SameKeys<
    ActionApprovalChallengeRequestV1,
    typeof ACTION_APPROVAL_CHALLENGE_REQUEST_FIELDS
  >;
  approvalRequest: SameKeys<ActionApprovalRequestV1, typeof ACTION_APPROVAL_REQUEST_FIELDS>;
  commitRequest: SameKeys<ActionCommitRequestV1, typeof ACTION_COMMIT_REQUEST_FIELDS>;
  cancelRequest: SameKeys<ActionCancelRequestV1, typeof ACTION_CANCEL_REQUEST_FIELDS>;
  challengeResponse: SameKeys<
    ActionApprovalChallengeResponseV1,
    typeof ACTION_APPROVAL_CHALLENGE_RESPONSE_FIELDS
  >;
  proposalResponse: SameKeys<ActionProposalResponseV1, typeof ACTION_PROPOSAL_RESPONSE_FIELDS>;
  approvalResponse: SameKeys<ActionApprovalResponseV1, typeof ACTION_APPROVAL_RESPONSE_FIELDS>;
  mutationResponse: SameKeys<ActionMutationResponseV1, typeof ACTION_MUTATION_RESPONSE_FIELDS>;
  pendingResponse: SameKeys<
    PendingActionProposalListResponseV1,
    typeof PENDING_ACTION_RESPONSE_FIELDS
  >;
  operationsPage: SameKeys<ActionOperationsPageV1, typeof ACTION_OPERATIONS_PAGE_FIELDS>;
  operationEventsResponse: SameKeys<
    ActionOperationEventsResponseV1,
    typeof ACTION_OPERATION_EVENTS_RESPONSE_FIELDS
  >;
  domainTerminalReceipt: SameKeys<
    ActionDomainTerminalReceiptV1,
    typeof ACTION_DOMAIN_TERMINAL_RECEIPT_FIELDS
  >;
  operationEvent: SameKeys<ActionOperationEventV1, typeof ACTION_OPERATION_EVENT_FIELDS>;
  proposal: SameKeys<PublicActionProposalViewV1, typeof ACTION_PROPOSAL_FIELDS>;
  approval: SameKeys<PublicActionApprovalViewV1, typeof ACTION_APPROVAL_FIELDS>;
  operation: SameKeys<ActionOperationViewV1, typeof ACTION_OPERATION_FIELDS>;
  progress: SameKeys<PublicOperationProgressV1, typeof ACTION_PROGRESS_FIELDS>;
  packagePin: SameKeys<PublicPackagePinV1, typeof ACTION_PACKAGE_PIN_FIELDS>;
  preview: SameKeys<HostRenderedPreviewV1, typeof ACTION_PREVIEW_FIELDS>;
  planning: SameKeys<ActionPlanningOptionsV1, typeof ACTION_PLANNING_OPTIONS_FIELDS>;
  reviewField: SameKeys<PublicReviewFieldV1, typeof ACTION_REVIEW_FIELD_FIELDS>;
  targetDisposition: SameKeys<
    CapabilityTargetDispositionV1,
    typeof ACTION_TARGET_DISPOSITION_FIELDS
  >;
  targetBinding: SameKeys<ActionTargetBindingV1, typeof ACTION_TARGET_BINDING_FIELDS>;
  permission: SameKeys<PublicPermissionDeltaV1, typeof ACTION_PERMISSION_DELTA_FIELDS>;
  dependency: SameKeys<PublicDependencyDeltaV1, typeof ACTION_DEPENDENCY_DELTA_FIELDS>;
  configDiff: SameKeys<PublicConfigDiffV1, typeof ACTION_CONFIG_DIFF_FIELDS>;
  enforcement: SameKeys<PublicEnforcementDisclosureV1, typeof ACTION_ENFORCEMENT_FIELDS>;
  healthPlan: SameKeys<PublicHealthPlanV1, typeof ACTION_HEALTH_PLAN_FIELDS>;
  actor: SameKeys<PublicActor, typeof PUBLIC_ACTOR_FIELDS>;
  timeline: SameKeys<ActionTimelineResponseV1, typeof TIMELINE_RESPONSE_FIELDS>;
  timelineHead: SameKeys<ActionTimelineResponseV1["head"], typeof TIMELINE_HEAD_FIELDS>;
  timelineBoundary: SameKeys<ActionTimelineBoundaryItemV1, typeof TIMELINE_BOUNDARY_FIELDS>;
  timelineStart: SameKeys<ActionTimelineStartItemV1, typeof TIMELINE_START_FIELDS>;
  timelineEvent: SameKeys<ActionTimelineEventItemV1, typeof TIMELINE_EVENT_FIELDS>;
  publicProgress: SameKeys<PublicOperationProgressV1, typeof PUBLIC_OPERATION_PROGRESS_FIELDS>;
  targetResult: SameKeys<PublicTargetResultV1, typeof PUBLIC_TARGET_RESULT_FIELDS>;
  target: SameKeys<PublicActionTargetV1, typeof PUBLIC_ACTION_TARGET_FIELDS>;
  conversationSubject: SameKeys<
    Extract<
      PublicActionTargetSubjectV1,
      { kind: typeof PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION }
    >,
    typeof PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS
  >;
  capabilitySubject: SameKeys<
    Extract<
      PublicActionTargetSubjectV1,
      { kind: typeof PUBLIC_ACTION_TARGET_SUBJECT_KIND.CAPABILITY }
    >,
    typeof PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS
  >;
  error: SameKeys<NonNullable<ActionOperationViewV1["error"]>, typeof PUBLIC_API_ERROR_FIELDS>;
};

type UnionContracts = {
  expectedSourceMode: SameUnion<
    ExpectedActionSourceV1["mode"],
    (typeof ACTION_EXPECTED_SOURCE_MODES)[number]
  >;
  schemaVersion: SameUnion<
    PublicActionProposalViewV1["schema_version"],
    typeof PUBLIC_ACTION_SCHEMA_VERSION
  >;
  projectorVersion: SameUnion<
    HostRenderedPreviewV1["projector_version"],
    typeof ACTION_PREVIEW_PROJECTOR_VERSION
  >;
  actionType: SameUnion<
    PublicActionProposalViewV1["action_type"],
    (typeof HOST_ACTION_KIND_VALUES)[number]
  >;
  domain: SameUnion<PublicActionProposalViewV1["domain"], (typeof ACTION_DOMAINS)[number]>;
  scope: SameUnion<PublicActionProposalViewV1["scope"], (typeof ACTION_SCOPES)[number]>;
  risk: SameUnion<PublicActionProposalViewV1["risk"], (typeof ACTION_RISKS)[number]>;
  effectClass: SameUnion<
    PublicActionProposalViewV1["effect_classes"][number],
    (typeof ACTION_EFFECT_CLASSES)[number]
  >;
  reversibility: SameUnion<
    PublicActionProposalViewV1["reversibility"],
    (typeof ACTION_REVERSIBILITY)[number]
  >;
  packageSourceKind: SameUnion<
    PublicPackagePinV1["source_kind"],
    (typeof ACTION_PACKAGE_PIN_SOURCE_KINDS)[number]
  >;
  packageTrust: SameUnion<PublicPackagePinV1["trust"], (typeof ACTION_PACKAGE_PIN_TRUST)[number]>;
  decision: SameUnion<PublicActionApprovalViewV1["decision"], (typeof ACTION_DECISIONS)[number]>;
  challenge: SameUnion<
    ActionApprovalChallengeResponseV1["challenge_class"],
    (typeof ACTION_APPROVAL_CHALLENGE_CLASSES)[number]
  >;
  operationState: SameUnion<
    ActionOperationViewV1["state"],
    (typeof ACTION_OPERATION_STATES)[number]
  >;
  delivery: SameUnion<ActionOperationViewV1["delivery"], (typeof ACTION_DELIVERY)[number]>;
  recovery: SameUnion<
    ActionOperationViewV1["recovery_actions"][number],
    (typeof PUBLIC_RECOVERY_ACTIONS)[number]
  >;
  actorKind: SameUnion<PublicActor["kind"], (typeof ACTOR_KINDS)[number]>;
  credentialClass: SameUnion<PublicActor["credential_class"], (typeof CREDENTIAL_CLASSES)[number]>;
  planningMode: SameUnion<ActionPlanningOptionsV1["mode"], (typeof ACTION_PLANNING_MODES)[number]>;
  planningNetworkRead: SameUnion<
    ActionPlanningOptionsV1["network_read"],
    (typeof ACTION_PLANNING_NETWORK_READ)[number]
  >;
  targetDispositionExecution: SameUnion<
    CapabilityTargetDispositionV1["execution"],
    (typeof ACTION_TARGET_DISPOSITION_EXECUTION)[number]
  >;
  targetManualReason: SameUnion<
    Extract<
      CapabilityTargetDispositionV1,
      { execution: typeof ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.MANUAL }
    >["reason_code"],
    (typeof ACTION_TARGET_MANUAL_REASON_CODES)[number]
  >;
  targetRequiredUserActionReason: SameUnion<
    Extract<
      CapabilityTargetDispositionV1,
      { execution: typeof ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.REQUIRED_USER_ACTION }
    >["reason_code"],
    (typeof ACTION_TARGET_REQUIRED_USER_ACTION_REASON_CODES)[number]
  >;
  targetUnsupportedReason: SameUnion<
    Extract<
      CapabilityTargetDispositionV1,
      { execution: typeof ACTION_TARGET_DISPOSITION_EXECUTION_VALUE.UNSUPPORTED }
    >["reason_code"],
    (typeof ACTION_TARGET_UNSUPPORTED_REASON_CODES)[number]
  >;
  permissionChange: SameUnion<
    PublicPermissionDeltaV1["change"],
    (typeof ACTION_PERMISSION_CHANGES)[number]
  >;
  permissionEnforcement: SameUnion<
    PublicPermissionDeltaV1["enforcement"],
    (typeof ACTION_PERMISSION_ENFORCEMENT)[number]
  >;
  dependencyChange: SameUnion<
    PublicDependencyDeltaV1["change"],
    (typeof ACTION_DEPENDENCY_CHANGES)[number]
  >;
  configMode: SameUnion<PublicConfigDiffV1["mode"], (typeof ACTION_CONFIG_DIFF_MODES)[number]>;
  healthPlanKind: SameUnion<PublicHealthPlanV1["kind"], (typeof ACTION_HEALTH_PLAN_KINDS)[number]>;
  healthPlanRetry: SameUnion<
    PublicHealthPlanV1["retries"],
    (typeof ACTION_HEALTH_PLAN_RETRIES)[number]
  >;
  timelineKind: SameUnion<
    ActionTimelineResponseV1["items"][number]["kind"],
    (typeof ACTION_TIMELINE_ITEM_KINDS)[number]
  >;
  progressStatus: SameUnion<
    PublicOperationProgressV1["status"],
    (typeof PUBLIC_OPERATION_PROGRESS_STATUSES)[number]
  >;
  targetOutcome: SameUnion<
    PublicTargetResultV1["outcome"],
    (typeof PUBLIC_TARGET_RESULT_OUTCOMES)[number]
  >;
  targetHealth: SameUnion<
    PublicTargetResultV1["health"],
    (typeof PUBLIC_TARGET_RESULT_HEALTHS)[number]
  >;
};

type InvalidContract<Contracts> = {
  [Key in keyof Contracts]: Contracts[Key] extends true ? never : Key;
}[keyof Contracts];

export const PUBLIC_ACTION_FIELD_CONTRACTS_EXACT: [InvalidContract<FieldContracts>] extends [never]
  ? true
  : false = true;

export const PUBLIC_ACTION_UNION_CONTRACTS_EXACT: [InvalidContract<UnionContracts>] extends [never]
  ? true
  : false = true;
