import { canonicalJsonBytes } from "../durability/index.js";
import type { HostActionV1 } from "./internal-action-types.js";
import type { HostActionRequestV1 } from "./request-types.js";

type StagedRequest = Extract<
  HostActionRequestV1,
  {
    type:
      | "conversation.publish_suspected_literal"
      | "conversation.abandon_revision_operation"
      | "conversation.retry_revision_operation"
      | "conversation.reconcile_revision_operation"
      | "context.compact"
      | "capability.adopt"
      | "policy.update_authority"
      | "secret.revoke"
      | "authority.repair";
  }
>;
type DirectRequestType = Exclude<HostActionRequestV1["type"], StagedRequest["type"]>;

const DIRECT_TYPE_LIST = [
  "conversation.add_participant",
  "conversation.remove_participant",
  "conversation.update_participant",
  "conversation.update_settings",
  "conversation.select_lineage_head",
  "conversation.associate_lineages",
  "conversation.stop_operation",
  "capability.install",
  "capability.update",
  "capability.configure",
  "capability.retarget",
  "capability.remove",
  "capability.rollback_scope",
  "capability.restore_package",
  "capability.repair",
  "grant.create",
  "grant.renew",
  "grant.revoke",
  "registry.trust_key",
] as const satisfies readonly DirectRequestType[];
const DIRECT_TYPES = new Set<HostActionRequestV1["type"]>(DIRECT_TYPE_LIST);

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
  if (request.type !== action.type) mismatch();
  if (DIRECT_TYPES.has(request.type)) {
    if (!equal(request, action)) mismatch();
    return;
  }
  switch (request.type) {
    case "conversation.publish_suspected_literal": {
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
    case "conversation.abandon_revision_operation":
    case "conversation.retry_revision_operation":
    case "conversation.reconcile_revision_operation":
      if (
        action.type !== request.type ||
        action.revision_operation_id !== request.revision_operation_id
      )
        mismatch();
      return;
    case "context.compact":
      if (
        action.type !== request.type ||
        action.oversized_candidate.candidate_id !== request.oversized_candidate_id ||
        action.oversized_candidate.candidate_digest !== request.oversized_candidate_digest ||
        action.profile !== request.profile ||
        !equal(action.compaction_input, request.compaction_input)
      )
        mismatch();
      return;
    case "capability.adopt":
      if (
        action.type !== request.type ||
        action.scope !== request.scope ||
        action.candidate.scope !== request.scope ||
        action.candidate.candidate_id !== request.candidate_id ||
        action.candidate.candidate_digest !== request.candidate_digest
      )
        mismatch();
      return;
    case "policy.update_authority":
      if (
        action.type !== request.type ||
        action.scope !== request.scope ||
        action.change.scope !== request.scope ||
        !equal(action.change.replacement_authority_subtree, request.replacement_authority_subtree)
      )
        mismatch();
      return;
    case "secret.revoke":
      if (
        action.type !== request.type ||
        action.scope !== request.scope ||
        action.expected_binding_digest !== request.expected_binding_digest ||
        action.private_binding_ref !==
          `actions/v1/secret-revocation-candidates/${request.private_binding_id}.json`
      )
        mismatch();
      return;
    case "authority.repair":
      if (
        action.type !== request.type ||
        action.plan.repair_id !== request.repair_id ||
        action.plan.plan_digest !== request.plan_digest
      )
        mismatch();
      return;
    default:
      mismatch();
  }
}
