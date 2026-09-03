import { CAPABILITY_AUTHORITY_CHANGE } from "../../actions/capability-security-contract.js";
import {
  applyAuthorityEvent,
  authorityEpochEventDigest,
  validateAuthorityEvent,
} from "../authority/index.js";
import type {
  AuthorityEpochEventV1,
  AuthorityEpochHeadV1,
  AuthorityLogicalStateV1,
} from "../authority/index.js";
import type { AuthorityRepairOperationV1 } from "./types.js";

function logicalState(head: AuthorityEpochHeadV1): AuthorityLogicalStateV1 {
  return {
    grant_head_digest: head.grant_head_digest,
    grant_digest: head.grant_digest,
    policy_head_digest: head.policy_head_digest,
    policy_digest: head.policy_digest,
    secret_revocation_digest: head.secret_revocation_digest,
    trust_head_digest: head.trust_head_digest,
    trust_epoch: head.trust_epoch,
  };
}

/** Exact non-compound repair serialization event from the approved control base. */
export function materializeAuthorityRepairedEpochTransition(
  base: AuthorityEpochHeadV1,
  operation: AuthorityRepairOperationV1,
): { event: AuthorityEpochEventV1; next: AuthorityEpochHeadV1 } {
  const state = logicalState(base);
  const draft: AuthorityEpochEventV1 = {
    schema_version: "1.0",
    scope: base.scope,
    scope_identity_digest: base.scope_identity_digest,
    authority_epoch: base.authority_epoch + 1,
    previous_event_digest: base.event_head_digest,
    previous_head_digest: base.content_digest,
    previous_head_checkpoint_digest: base.content_digest,
    change: CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED,
    prior_state: structuredClone(state),
    next_state: structuredClone(state),
    proposal_id: operation.proposal_id,
    approval_id: operation.approval_id,
    operation_id: operation.operation_id,
    plan_digest: operation.plan_digest,
    action_root_locator: structuredClone(operation.action_root_locator),
    operation_header_digest: operation.header_digest,
    recorded_at: operation.created_at,
    event_digest: "",
  };
  const event = { ...draft, event_digest: authorityEpochEventDigest(draft) };
  validateAuthorityEvent(event);
  const next = applyAuthorityEvent(base, event, {
    change: CAPABILITY_AUTHORITY_CHANGE.AUTHORITY_REPAIRED,
    checkpoint_head: base,
  });
  return Object.freeze({ event: Object.freeze(event), next: Object.freeze(next) });
}
