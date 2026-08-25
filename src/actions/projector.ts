import { digestHex, digestV1 } from "../durability/index.js";
import { foldDomainProjection } from "./operation-projection.js";
import { assertPublicProjectionSafe } from "./public-safety.js";
import type {
  ActionOperationEventV1,
  ActionOperationViewV1,
  ActionProposalResponseV1,
  PublicActionApprovalViewV1,
  PublicActionProposalViewV1,
} from "./public-types.js";
import type { ActionAuthoritySnapshotV1 } from "./types.js";

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
  if (proposal.domain === "capability" && proposal.base.capability_scope === null)
    throw new Error("capability proposal has no public scope");
  return {
    schema_version: "1.0",
    proposal_id: proposal.proposal_id,
    proposal_digest: proposal.proposal_digest,
    origin_event_id: proposal.origin_event_id,
    action_type: proposal.action.type,
    domain: proposal.domain,
    scope:
      proposal.domain === "conversation"
        ? "conversation"
        : (proposal.base.capability_scope as "project" | "user"),
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
        schema_version: "1.0",
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
): ActionOperationViewV1 {
  const proposal = snapshot.proposal;
  const outboxApplicable =
    proposal.action.type.startsWith("capability.") &&
    proposal.action_root_locator.kind === "conversation" &&
    proposal.producer_request_binding.kind === "canonical-action-request";
  const correlation = digestV1("VF-ACTION-CORRELATION\0v1\0", {
    proposal_id: proposal.proposal_id,
    domain: proposal.domain,
    root_session_id: proposal.base.root_session_id,
    conversation_id: proposal.base.conversation_id,
    revision_id: proposal.base.revision_id,
    origin_event_id: proposal.origin_event_id,
  });
  const recovery =
    snapshot.state === "needs_recovery"
      ? (["repair"] as const)
      : snapshot.state === "failed"
        ? (["retry"] as const)
        : [];
  const correlationId = `vf-correlation-${digestHex(correlation)}`;
  const domain = foldDomainProjection(snapshot, events, correlationId);
  return {
    schema_version: "1.0",
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
    delivery: outboxApplicable ? "pending" : "not-applicable",
    result_ref: null,
    error: domain.error,
    recovery_actions: [...recovery],
    created_at: proposal.created_at,
    updated_at: domain.updated_at,
  };
}

export function projectActionSnapshot(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[] = [],
): ActionProposalResponseV1 {
  const projected = {
    schema_version: "1.0" as const,
    proposal: publicProposal(snapshot),
    approval: publicApproval(snapshot),
    operation: operation(snapshot, events),
  };
  assertPublicProjectionSafe(projected, "$.action_response");
  return projected;
}
