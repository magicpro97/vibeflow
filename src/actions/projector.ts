import type { CapabilityScope } from "../core/capability-contract.js";
import { digestHex, digestV1 } from "../durability/index.js";
import { isCapabilityHostActionKind } from "./host-action-contract.js";
import { foldDomainProjection } from "./operation-projection.js";
import {
  ACTION_OPERATION_STATE,
  ACTION_PRODUCER_REQUEST_BINDING_KIND,
  ACTION_ROOT_LOCATOR_KIND,
} from "./protocol-contract.js";
import {
  ACTION_DELIVERY_VALUE,
  ACTION_DOMAIN,
  ACTION_SCOPE,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import { PUBLIC_RECOVERY_ACTION } from "./public-error-contract.js";
import { assertPublicProjectionSafe } from "./public-safety.js";
import type {
  ActionOperationEventV1,
  ActionOperationViewV1,
  ActionProposalResponseV1,
  PublicActionApprovalViewV1,
  PublicActionProposalViewV1,
} from "./public-types.js";
import { assertTimestamp } from "./record-primitives.js";
import type { ActionAuthoritySnapshotV1 } from "./types.js";

const ACTION_OUTBOX_PRE_DISPATCH_TERMINAL_STATES = Object.freeze([
  ACTION_OPERATION_STATE.DENIED,
  ACTION_OPERATION_STATE.CANCELED,
  ACTION_OPERATION_STATE.EXPIRED,
  ACTION_OPERATION_STATE.STALE,
] as const);

export interface ActionProjectionOptionsV1 {
  delivery?: ActionOperationViewV1["delivery"];
  delivery_updated_at?: string;
}

export function isActionOutboxApplicable(snapshot: ActionAuthoritySnapshotV1): boolean {
  const proposal = snapshot.proposal;
  return (
    isCapabilityHostActionKind(proposal.action.type) &&
    proposal.action_root_locator.kind === ACTION_ROOT_LOCATOR_KIND.CONVERSATION &&
    proposal.producer_request_binding.kind ===
      ACTION_PRODUCER_REQUEST_BINDING_KIND.CANONICAL_ACTION_REQUEST
  );
}

export function initialActionDelivery(
  snapshot: ActionAuthoritySnapshotV1,
): typeof ACTION_DELIVERY_VALUE.NOT_APPLICABLE | typeof ACTION_DELIVERY_VALUE.PENDING {
  const abortedBeforeDispatch =
    snapshot.operation_id === null &&
    ACTION_OUTBOX_PRE_DISPATCH_TERMINAL_STATES.some((state) => state === snapshot.state);
  return !isActionOutboxApplicable(snapshot) || abortedBeforeDispatch
    ? ACTION_DELIVERY_VALUE.NOT_APPLICABLE
    : ACTION_DELIVERY_VALUE.PENDING;
}

export function actionCorrelationId(snapshot: ActionAuthoritySnapshotV1): string {
  const proposal = snapshot.proposal;
  const correlation = digestV1("VF-ACTION-CORRELATION\0v1\0", {
    proposal_id: proposal.proposal_id,
    domain: proposal.domain,
    root_session_id: proposal.base.root_session_id,
    conversation_id: proposal.base.conversation_id,
    revision_id: proposal.base.revision_id,
    origin_event_id: proposal.origin_event_id,
  });
  return `vf-correlation-${digestHex(correlation)}`;
}

function packagePin(pin: ActionAuthoritySnapshotV1["proposal"]["package_pins"][number]) {
  return {
    id: pin.id,
    version: pin.version,
    source_kind: pin.source.kind,
    content_sha256: pin.content_sha256,
    trust: pin.trust,
    nonportable: pin.nonportable,
    pin_digest: pin.pin_digest,
  };
}

function publicProposal(snapshot: ActionAuthoritySnapshotV1): PublicActionProposalViewV1 {
  const proposal = snapshot.proposal;
  if (proposal.domain === ACTION_DOMAIN.CAPABILITY && proposal.base.capability_scope === null)
    throw new Error("capability proposal has no public scope");
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    origin_event_id: proposal.origin_event_id,
    action_type: proposal.action.type,
    domain: proposal.domain,
    scope:
      proposal.domain === ACTION_DOMAIN.CONVERSATION
        ? ACTION_SCOPE.CONVERSATION
        : (proposal.base.capability_scope as CapabilityScope),
    authority_binding_mode: proposal.base.authority_binding_mode,
    risk: proposal.risk,
    effect_classes: [...proposal.effect_classes],
    targets: proposal.target_set.map((target) => structuredClone(target)),
    package_pins: proposal.package_pins.map(packagePin),
    adapter_set_digest: proposal.adapter_set_digest,
    plan_digest: proposal.plan_digest,
    policy_digest: proposal.policy_digest,
    permission_digest: proposal.permission_digest,
    reversibility: proposal.reversibility,
    preview: structuredClone(proposal.preview),
    created_at: proposal.created_at,
    expires_at: proposal.expires_at,
  };
}

function publicApproval(snapshot: ActionAuthoritySnapshotV1): PublicActionApprovalViewV1 | null {
  const approval = snapshot.approval;
  return approval
    ? {
        schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
        approval_id: approval.approval_id,
        approval_digest: approval.approval_digest,
        proposal_id: approval.proposal_id,
        proposal_digest: approval.proposal_digest,
        decision: approval.decision,
        challenge_class: approval.challenge_class,
        decided_by: structuredClone(approval.decided_by),
        decided_at: approval.decided_at,
        expires_at: approval.expires_at,
      }
    : null;
}

function operation(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[],
  options: ActionProjectionOptionsV1,
): ActionOperationViewV1 {
  const proposal = snapshot.proposal;
  const correlationId = actionCorrelationId(snapshot);
  const domain = foldDomainProjection(snapshot, events, correlationId);
  const initialDelivery = initialActionDelivery(snapshot);
  const delivery = options.delivery ?? initialDelivery;
  if (
    (initialDelivery === ACTION_DELIVERY_VALUE.NOT_APPLICABLE &&
      delivery !== ACTION_DELIVERY_VALUE.NOT_APPLICABLE) ||
    (initialDelivery === ACTION_DELIVERY_VALUE.PENDING &&
      delivery === ACTION_DELIVERY_VALUE.NOT_APPLICABLE) ||
    (snapshot.operation_id === null && delivery !== initialDelivery)
  )
    throw new Error("action delivery projection escaped its applicability boundary");
  const recovery =
    domain.error !== null
      ? domain.error.recovery_action === null
        ? []
        : [domain.error.recovery_action]
      : snapshot.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY
        ? ([PUBLIC_RECOVERY_ACTION.REPAIR] as const)
        : snapshot.state === ACTION_OPERATION_STATE.FAILED
          ? ([PUBLIC_RECOVERY_ACTION.RETRY] as const)
          : [];
  const deliveryUpdatedAt = options.delivery_updated_at;
  if (
    deliveryUpdatedAt !== undefined &&
    assertTimestamp(deliveryUpdatedAt, "$.delivery_updated_at") <
      assertTimestamp(proposal.created_at, "$.proposal.created_at")
  )
    throw new Error("action delivery timestamp predates its proposal");
  const updatedAt =
    deliveryUpdatedAt !== undefined && Date.parse(deliveryUpdatedAt) > Date.parse(domain.updated_at)
      ? deliveryUpdatedAt
      : domain.updated_at;
  return {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    operation_id: snapshot.operation_id,
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    approval_id: snapshot.approval?.approval_id ?? null,
    approval_digest: snapshot.approval?.approval_digest ?? null,
    correlation_id: correlationId,
    domain: proposal.domain,
    state: snapshot.state,
    phase_sequence: domain.phase_sequence,
    latest_event_cursor: domain.latest_event_cursor,
    progress: domain.progress,
    targets: domain.targets,
    delivery,
    result_ref: null,
    error: domain.error,
    recovery_actions: [...recovery],
    created_at: proposal.created_at,
    updated_at: updatedAt,
  };
}

export function projectActionSnapshot(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[] = [],
  options: ActionProjectionOptionsV1 = {},
): ActionProposalResponseV1 {
  const projected = {
    schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
    proposal: publicProposal(snapshot),
    approval: publicApproval(snapshot),
    operation: operation(snapshot, events, options),
  };
  assertPublicProjectionSafe(projected, "$.action_response");
  return projected;
}
