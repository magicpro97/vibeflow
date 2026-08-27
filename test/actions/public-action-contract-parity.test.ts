import { describe, expect, test } from "bun:test";
import type { HOST_ACTION_KIND_VALUES } from "../../src/actions/host-action-contract.js";
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
} from "../../src/actions/preview-types.js";
import type { ACTION_OPERATION_STATES } from "../../src/actions/protocol-contract.js";
import {
  type ACTION_APPROVAL_CHALLENGE_CLASSES,
  type ACTION_APPROVAL_CHALLENGE_REQUEST_FIELDS,
  type ACTION_APPROVAL_CHALLENGE_RESPONSE_FIELDS,
  ACTION_APPROVAL_FIELDS,
  type ACTION_APPROVAL_REQUEST_FIELDS,
  ACTION_APPROVAL_RESPONSE_FIELDS,
  type ACTION_CANCEL_REQUEST_FIELDS,
  ACTION_CHALLENGE_CLASSES,
  type ACTION_COMMIT_REQUEST_FIELDS,
  ACTION_CONFIG_DIFF_FIELDS,
  type ACTION_CONFIG_DIFF_MODES,
  type ACTION_DECISIONS,
  ACTION_DELIVERY,
  type ACTION_DEPENDENCY_CHANGES,
  ACTION_DEPENDENCY_DELTA_FIELDS,
  ACTION_DOMAINS,
  type ACTION_EFFECT_CLASSES,
  ACTION_ENFORCEMENT_FIELDS,
  type ACTION_EXPECTED_SOURCE_MODES,
  ACTION_HEALTH_PLAN_FIELDS,
  type ACTION_HEALTH_PLAN_KINDS,
  type ACTION_HEALTH_PLAN_RETRIES,
  type ACTION_LINEAGE_RECOVERY_EXPECTATION_FIELDS,
  ACTION_MUTATION_RESPONSE_FIELDS,
  ACTION_OPERATIONS_PAGE_FIELDS,
  ACTION_OPERATION_FIELDS,
  ACTION_PACKAGE_PIN_FIELDS,
  type ACTION_PACKAGE_PIN_SOURCE_KINDS,
  type ACTION_PACKAGE_PIN_TRUST,
  type ACTION_PERMISSION_CHANGES,
  ACTION_PERMISSION_DELTA_FIELDS,
  type ACTION_PERMISSION_ENFORCEMENT,
  type ACTION_PLANNING_MODES,
  type ACTION_PLANNING_NETWORK_READ,
  ACTION_PLANNING_OPTIONS_FIELDS,
  ACTION_PREVIEW_FIELDS,
  ACTION_PREVIEW_PROJECTOR_VERSION,
  ACTION_PROGRESS_FIELDS,
  ACTION_PROPOSAL_FIELDS,
  ACTION_PROPOSAL_ID_PATTERN,
  type ACTION_PROPOSAL_REQUEST_FIELDS,
  ACTION_PROPOSAL_RESPONSE_FIELDS,
  ACTION_RAW_SHA256_PATTERN,
  type ACTION_REVERSIBILITY,
  ACTION_REVIEW_FIELD_FIELDS,
  ACTION_RISKS,
  ACTION_SCOPES,
  type ACTION_TARGET_BINDING_FIELDS,
  ACTION_TARGET_DISPOSITION_EXECUTION,
  ACTION_TARGET_DISPOSITION_FIELDS,
  type ACTION_TARGET_MANUAL_REASON_CODES,
  type ACTION_TARGET_REQUIRED_USER_ACTION_REASON_CODES,
  type ACTION_TARGET_UNSUPPORTED_REASON_CODES,
  ACTION_TIMELINE_ITEM_KINDS,
  type ACTION_WRITABLE_REVISION_EXPECTATION_FIELDS,
  type ACTOR_KINDS,
  type CREDENTIAL_CLASSES,
  PENDING_ACTION_RESPONSE_FIELDS,
  PUBLIC_ACTION_SCHEMA_VERSION,
  PUBLIC_ACTOR_FIELDS,
  TIMELINE_BOUNDARY_FIELDS,
  TIMELINE_EVENT_FIELDS,
  TIMELINE_HEAD_FIELDS,
  TIMELINE_RESPONSE_FIELDS,
  TIMELINE_START_FIELDS,
} from "../../src/actions/public-action-contract.js";
import type { PUBLIC_RECOVERY_ACTIONS } from "../../src/actions/public-error-contract.js";
import type {
  ActionApprovalChallengeRequestV1,
  ActionApprovalChallengeResponseV1,
  ActionApprovalRequestV1,
  ActionApprovalResponseV1,
  ActionCancelRequestV1,
  ActionCommitRequestV1,
  ActionMutationResponseV1,
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
} from "../../src/actions/public-types.js";
import type {
  ActionPlanningOptionsV1,
  ActionProposalRequestV1,
  ExpectedActionSourceV1,
  PublicActor,
} from "../../src/actions/types.js";

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

const keyParity = {
  proposalRequest: true satisfies SameKeys<
    ActionProposalRequestV1,
    typeof ACTION_PROPOSAL_REQUEST_FIELDS
  >,
  writableExpectation: true satisfies SameKeys<
    Extract<ExpectedActionSourceV1, { mode: "writable-revision" }>,
    typeof ACTION_WRITABLE_REVISION_EXPECTATION_FIELDS
  >,
  recoveryExpectation: true satisfies SameKeys<
    Extract<ExpectedActionSourceV1, { mode: "lineage-recovery" }>,
    typeof ACTION_LINEAGE_RECOVERY_EXPECTATION_FIELDS
  >,
  challengeRequest: true satisfies SameKeys<
    ActionApprovalChallengeRequestV1,
    typeof ACTION_APPROVAL_CHALLENGE_REQUEST_FIELDS
  >,
  approvalRequest: true satisfies SameKeys<
    ActionApprovalRequestV1,
    typeof ACTION_APPROVAL_REQUEST_FIELDS
  >,
  commitRequest: true satisfies SameKeys<
    ActionCommitRequestV1,
    typeof ACTION_COMMIT_REQUEST_FIELDS
  >,
  cancelRequest: true satisfies SameKeys<
    ActionCancelRequestV1,
    typeof ACTION_CANCEL_REQUEST_FIELDS
  >,
  challengeResponse: true satisfies SameKeys<
    ActionApprovalChallengeResponseV1,
    typeof ACTION_APPROVAL_CHALLENGE_RESPONSE_FIELDS
  >,
  actionResponse: true satisfies SameKeys<
    ActionProposalResponseV1,
    typeof ACTION_PROPOSAL_RESPONSE_FIELDS
  >,
  pendingResponse: true satisfies SameKeys<
    PendingActionProposalListResponseV1,
    typeof PENDING_ACTION_RESPONSE_FIELDS
  >,
  approvalResponse: true satisfies SameKeys<
    ActionApprovalResponseV1,
    typeof ACTION_APPROVAL_RESPONSE_FIELDS
  >,
  mutationResponse: true satisfies SameKeys<
    ActionMutationResponseV1,
    typeof ACTION_MUTATION_RESPONSE_FIELDS
  >,
  operationsPage: true satisfies SameKeys<
    ActionOperationsPageV1,
    typeof ACTION_OPERATIONS_PAGE_FIELDS
  >,
  proposal: true satisfies SameKeys<PublicActionProposalViewV1, typeof ACTION_PROPOSAL_FIELDS>,
  approval: true satisfies SameKeys<PublicActionApprovalViewV1, typeof ACTION_APPROVAL_FIELDS>,
  operation: true satisfies SameKeys<ActionOperationViewV1, typeof ACTION_OPERATION_FIELDS>,
  progress: true satisfies SameKeys<
    ActionOperationViewV1["progress"][number],
    typeof ACTION_PROGRESS_FIELDS
  >,
  packagePin: true satisfies SameKeys<PublicPackagePinV1, typeof ACTION_PACKAGE_PIN_FIELDS>,
  preview: true satisfies SameKeys<HostRenderedPreviewV1, typeof ACTION_PREVIEW_FIELDS>,
  planning: true satisfies SameKeys<ActionPlanningOptionsV1, typeof ACTION_PLANNING_OPTIONS_FIELDS>,
  reviewField: true satisfies SameKeys<PublicReviewFieldV1, typeof ACTION_REVIEW_FIELD_FIELDS>,
  disposition: true satisfies SameKeys<
    CapabilityTargetDispositionV1,
    typeof ACTION_TARGET_DISPOSITION_FIELDS
  >,
  targetBinding: true satisfies SameKeys<
    ActionTargetBindingV1,
    typeof ACTION_TARGET_BINDING_FIELDS
  >,
  permission: true satisfies SameKeys<
    PublicPermissionDeltaV1,
    typeof ACTION_PERMISSION_DELTA_FIELDS
  >,
  dependency: true satisfies SameKeys<
    PublicDependencyDeltaV1,
    typeof ACTION_DEPENDENCY_DELTA_FIELDS
  >,
  configDiff: true satisfies SameKeys<PublicConfigDiffV1, typeof ACTION_CONFIG_DIFF_FIELDS>,
  enforcement: true satisfies SameKeys<
    PublicEnforcementDisclosureV1,
    typeof ACTION_ENFORCEMENT_FIELDS
  >,
  healthPlan: true satisfies SameKeys<PublicHealthPlanV1, typeof ACTION_HEALTH_PLAN_FIELDS>,
  actor: true satisfies SameKeys<PublicActor, typeof PUBLIC_ACTOR_FIELDS>,
  timeline: true satisfies SameKeys<ActionTimelineResponseV1, typeof TIMELINE_RESPONSE_FIELDS>,
  timelineHead: true satisfies SameKeys<
    ActionTimelineResponseV1["head"],
    typeof TIMELINE_HEAD_FIELDS
  >,
  boundaryItem: true satisfies SameKeys<
    ActionTimelineBoundaryItemV1,
    typeof TIMELINE_BOUNDARY_FIELDS
  >,
  startItem: true satisfies SameKeys<ActionTimelineStartItemV1, typeof TIMELINE_START_FIELDS>,
  eventItem: true satisfies SameKeys<ActionTimelineEventItemV1, typeof TIMELINE_EVENT_FIELDS>,
} as const;

const unionParity = {
  expectedSourceMode: true satisfies SameUnion<
    ExpectedActionSourceV1["mode"],
    (typeof ACTION_EXPECTED_SOURCE_MODES)[number]
  >,
  approvalChallengeClass: true satisfies SameUnion<
    ActionApprovalChallengeResponseV1["challenge_class"],
    (typeof ACTION_APPROVAL_CHALLENGE_CLASSES)[number]
  >,
  schemaVersion: true satisfies SameUnion<
    PublicActionProposalViewV1["schema_version"],
    typeof PUBLIC_ACTION_SCHEMA_VERSION
  >,
  projectorVersion: true satisfies SameUnion<
    HostRenderedPreviewV1["projector_version"],
    typeof ACTION_PREVIEW_PROJECTOR_VERSION
  >,
  actionType: true satisfies SameUnion<
    PublicActionProposalViewV1["action_type"],
    (typeof HOST_ACTION_KIND_VALUES)[number]
  >,
  domain: true satisfies SameUnion<
    PublicActionProposalViewV1["domain"],
    (typeof ACTION_DOMAINS)[number]
  >,
  scope: true satisfies SameUnion<
    PublicActionProposalViewV1["scope"],
    (typeof ACTION_SCOPES)[number]
  >,
  risk: true satisfies SameUnion<PublicActionProposalViewV1["risk"], (typeof ACTION_RISKS)[number]>,
  effectClass: true satisfies SameUnion<
    PublicActionProposalViewV1["effect_classes"][number],
    (typeof ACTION_EFFECT_CLASSES)[number]
  >,
  reversibility: true satisfies SameUnion<
    PublicActionProposalViewV1["reversibility"],
    (typeof ACTION_REVERSIBILITY)[number]
  >,
  sourceKind: true satisfies SameUnion<
    PublicPackagePinV1["source_kind"],
    (typeof ACTION_PACKAGE_PIN_SOURCE_KINDS)[number]
  >,
  pinTrust: true satisfies SameUnion<
    PublicPackagePinV1["trust"],
    (typeof ACTION_PACKAGE_PIN_TRUST)[number]
  >,
  decision: true satisfies SameUnion<
    PublicActionApprovalViewV1["decision"],
    (typeof ACTION_DECISIONS)[number]
  >,
  challenge: true satisfies SameUnion<
    PublicActionApprovalViewV1["challenge_class"],
    (typeof ACTION_CHALLENGE_CLASSES)[number]
  >,
  operationState: true satisfies SameUnion<
    ActionOperationViewV1["state"],
    (typeof ACTION_OPERATION_STATES)[number]
  >,
  delivery: true satisfies SameUnion<
    ActionOperationViewV1["delivery"],
    (typeof ACTION_DELIVERY)[number]
  >,
  recovery: true satisfies SameUnion<
    ActionOperationViewV1["recovery_actions"][number],
    (typeof PUBLIC_RECOVERY_ACTIONS)[number]
  >,
  actorKind: true satisfies SameUnion<PublicActor["kind"], (typeof ACTOR_KINDS)[number]>,
  credential: true satisfies SameUnion<
    PublicActor["credential_class"],
    (typeof CREDENTIAL_CLASSES)[number]
  >,
  planningMode: true satisfies SameUnion<
    ActionPlanningOptionsV1["mode"],
    (typeof ACTION_PLANNING_MODES)[number]
  >,
  planningNetwork: true satisfies SameUnion<
    ActionPlanningOptionsV1["network_read"],
    (typeof ACTION_PLANNING_NETWORK_READ)[number]
  >,
  execution: true satisfies SameUnion<
    CapabilityTargetDispositionV1["execution"],
    (typeof ACTION_TARGET_DISPOSITION_EXECUTION)[number]
  >,
  manualReason: true satisfies SameUnion<
    Extract<CapabilityTargetDispositionV1, { execution: "manual" }>["reason_code"],
    (typeof ACTION_TARGET_MANUAL_REASON_CODES)[number]
  >,
  requiredReason: true satisfies SameUnion<
    Extract<CapabilityTargetDispositionV1, { execution: "required-user-action" }>["reason_code"],
    (typeof ACTION_TARGET_REQUIRED_USER_ACTION_REASON_CODES)[number]
  >,
  unsupportedReason: true satisfies SameUnion<
    Extract<CapabilityTargetDispositionV1, { execution: "unsupported" }>["reason_code"],
    (typeof ACTION_TARGET_UNSUPPORTED_REASON_CODES)[number]
  >,
  permissionChange: true satisfies SameUnion<
    PublicPermissionDeltaV1["change"],
    (typeof ACTION_PERMISSION_CHANGES)[number]
  >,
  permissionEnforcement: true satisfies SameUnion<
    PublicPermissionDeltaV1["enforcement"],
    (typeof ACTION_PERMISSION_ENFORCEMENT)[number]
  >,
  dependencyChange: true satisfies SameUnion<
    PublicDependencyDeltaV1["change"],
    (typeof ACTION_DEPENDENCY_CHANGES)[number]
  >,
  configMode: true satisfies SameUnion<
    PublicConfigDiffV1["mode"],
    (typeof ACTION_CONFIG_DIFF_MODES)[number]
  >,
  healthKind: true satisfies SameUnion<
    PublicHealthPlanV1["kind"],
    (typeof ACTION_HEALTH_PLAN_KINDS)[number]
  >,
  healthRetry: true satisfies SameUnion<
    PublicHealthPlanV1["retries"],
    (typeof ACTION_HEALTH_PLAN_RETRIES)[number]
  >,
  timelineKind: true satisfies SameUnion<
    ActionTimelineResponseV1["items"][number]["kind"],
    (typeof ACTION_TIMELINE_ITEM_KINDS)[number]
  >,
} as const;

const hasValue = (values: readonly string[] | readonly number[], value: unknown) =>
  values.some((candidate) => candidate === value);

describe("public action contract parity", () => {
  test("keeps public action field tuples and inferred unions exact", () => {
    expect(Object.values(keyParity).every(Boolean)).toBeTrue();
    expect(Object.values(unionParity).every(Boolean)).toBeTrue();
    for (const tuple of [
      ACTION_PROPOSAL_RESPONSE_FIELDS,
      ACTION_APPROVAL_RESPONSE_FIELDS,
      ACTION_MUTATION_RESPONSE_FIELDS,
      PENDING_ACTION_RESPONSE_FIELDS,
      TIMELINE_RESPONSE_FIELDS,
      TIMELINE_HEAD_FIELDS,
      TIMELINE_BOUNDARY_FIELDS,
      TIMELINE_START_FIELDS,
      TIMELINE_EVENT_FIELDS,
      ACTION_OPERATIONS_PAGE_FIELDS,
      ACTION_PROPOSAL_FIELDS,
      ACTION_APPROVAL_FIELDS,
      ACTION_OPERATION_FIELDS,
      ACTION_PROGRESS_FIELDS,
      ACTION_PACKAGE_PIN_FIELDS,
      ACTION_PREVIEW_FIELDS,
      ACTION_PLANNING_OPTIONS_FIELDS,
      ACTION_REVIEW_FIELD_FIELDS,
      ACTION_TARGET_DISPOSITION_FIELDS,
      ACTION_PERMISSION_DELTA_FIELDS,
      ACTION_DEPENDENCY_DELTA_FIELDS,
      ACTION_CONFIG_DIFF_FIELDS,
      ACTION_ENFORCEMENT_FIELDS,
      ACTION_HEALTH_PLAN_FIELDS,
      PUBLIC_ACTOR_FIELDS,
    ]) {
      expect(Object.isFrozen(tuple)).toBeTrue();
      expect(new Set(tuple).size).toBe(tuple.length);
    }
  });

  test("accepts canonical values and rejects unknown or prototype-shaped variants", () => {
    expect(PUBLIC_ACTION_SCHEMA_VERSION).toBe("1.0");
    expect(ACTION_PREVIEW_PROJECTOR_VERSION).toBe("vf-public-projector/1");
    expect(ACTION_PROPOSAL_ID_PATTERN.test(`vf-proposal-${"a".repeat(64)}`)).toBeTrue();
    expect(ACTION_RAW_SHA256_PATTERN.test("a".repeat(64))).toBeTrue();
    for (const value of ["__proto__", "constructor", "toString", "future"]) {
      expect(ACTION_PROPOSAL_ID_PATTERN.test(value)).toBeFalse();
      expect(ACTION_RAW_SHA256_PATTERN.test(value)).toBeFalse();
      expect(hasValue(ACTION_DOMAINS, value)).toBeFalse();
      expect(hasValue(ACTION_SCOPES, value)).toBeFalse();
      expect(hasValue(ACTION_RISKS, value)).toBeFalse();
      expect(hasValue(ACTION_CHALLENGE_CLASSES, value)).toBeFalse();
      expect(hasValue(ACTION_DELIVERY, value)).toBeFalse();
      expect(hasValue(ACTION_TARGET_DISPOSITION_EXECUTION, value)).toBeFalse();
      expect(hasValue(ACTION_TIMELINE_ITEM_KINDS, value)).toBeFalse();
    }
  });
});
