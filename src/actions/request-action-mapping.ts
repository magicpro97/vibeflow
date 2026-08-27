import { canonicalJsonBytes } from "../durability/index.js";
import { HOST_ACTION_KIND, isHostActionKind } from "./host-action-contract.js";
import type { HostActionV1 } from "./internal-action-types.js";
import type { HostActionRequestV1 } from "./request-types.js";

function equal(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

function mismatch(): never {
  throw new Error("canonical request and resolved proposal action disagree");
}

/**
 * Bind every public request byte to the corresponding immutable internal action.
 * Direct variants are byte-identical. Staged variants admit only the documented
 * server-resolved fields in addition to the complete public intent.
 */
export function assertRequestActionMapping(
  request: HostActionRequestV1,
  action: HostActionV1,
): void {
  if (!isHostActionKind(request.type) || !isHostActionKind(action.type)) mismatch();
  if (request.type !== action.type) mismatch();
  switch (request.type) {
    case HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL: {
      if (
        action.type !== request.type ||
        action.binding.private_staging_id !== request.private_staging_id ||
        action.binding.staging_record_digest !== request.staging_record_digest ||
        action.binding.staged_content_digest !== request.staged_content_digest ||
        action.binding.findings_digest !== request.findings_digest
      )
        mismatch();
      return;
    }
    case HOST_ACTION_KIND.CONVERSATION_ABANDON_REVISION_OPERATION:
    case HOST_ACTION_KIND.CONVERSATION_RETRY_REVISION_OPERATION:
    case HOST_ACTION_KIND.CONVERSATION_RECONCILE_REVISION_OPERATION:
      if (
        action.type !== request.type ||
        action.revision_operation_id !== request.revision_operation_id
      )
        mismatch();
      return;
    case HOST_ACTION_KIND.CONTEXT_COMPACT:
      if (
        action.type !== request.type ||
        action.oversized_candidate.candidate_id !== request.oversized_candidate_id ||
        action.oversized_candidate.candidate_digest !== request.oversized_candidate_digest ||
        action.profile !== request.profile ||
        !equal(action.compaction_input, request.compaction_input)
      )
        mismatch();
      return;
    case HOST_ACTION_KIND.CAPABILITY_ADOPT:
      if (
        action.type !== request.type ||
        action.scope !== request.scope ||
        action.candidate.scope !== request.scope ||
        action.candidate.candidate_id !== request.candidate_id ||
        action.candidate.candidate_digest !== request.candidate_digest
      )
        mismatch();
      return;
    case HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY:
      if (
        action.type !== request.type ||
        action.scope !== request.scope ||
        action.change.scope !== request.scope ||
        !equal(action.change.replacement_authority_subtree, request.replacement_authority_subtree)
      )
        mismatch();
      return;
    case HOST_ACTION_KIND.SECRET_REVOKE:
      if (
        action.type !== request.type ||
        action.scope !== request.scope ||
        action.expected_binding_digest !== request.expected_binding_digest ||
        action.private_binding_ref !==
          `actions/v1/secret-revocation-candidates/${request.private_binding_id}.json`
      )
        mismatch();
      return;
    case HOST_ACTION_KIND.AUTHORITY_REPAIR:
      if (
        action.type !== request.type ||
        action.plan.repair_id !== request.repair_id ||
        action.plan.plan_digest !== request.plan_digest
      )
        mismatch();
      return;
    default:
      if (!equal(request, action)) mismatch();
  }
}
