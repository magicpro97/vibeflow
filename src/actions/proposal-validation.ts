import {
  EMPTY_ADAPTER_SET_DIGEST,
  EMPTY_PERMISSION_DIGEST,
  EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
  targetId,
  validateProposalContent,
} from "./proposal-content-validation.js";
import { validateProposalOwnership } from "./proposal-ownership-validation.js";
import {
  assertActor,
  assertCanonicalSize,
  assertDerivedId,
  assertDigest,
  assertTimestamp,
} from "./record-primitives.js";
import { ActionValidationError, exactObject } from "./strict-json.js";
import type { ActionProposalDraftV1, ActionProposalV1 } from "./types.js";

export {
  EMPTY_ADAPTER_SET_DIGEST,
  EMPTY_PERMISSION_DIGEST,
  EMPTY_SOURCE_AUTHORITY_SET_DIGEST,
  targetId,
};

const PROPOSAL_FIELDS = [
  "schema_version",
  "idempotency_key",
  "origin_event_id",
  "domain",
  "action_root_locator",
  "producer_request_binding",
  "planning_options",
  "execution_object_closure_digest",
  "base",
  "action",
  "requested_by",
  "risk",
  "effect_classes",
  "target_set",
  "package_pins",
  "source_authority_set_digest",
  "adapter_set_digest",
  "plan_digest",
  "handoff_selection_digest",
  "policy_digest",
  "grant_digest",
  "permission_digest",
  "reversibility",
  "preview",
  "created_at",
  "expires_at",
] as const;

export const MAX_ACTION_PROPOSAL_BYTES = 512 * 1024;

export function validateProposalDraftShape(draft: ActionProposalDraftV1): void {
  exactObject(draft, PROPOSAL_FIELDS, [], "$.proposal");
  if (draft.schema_version !== "1.0") invalid("unsupported schema version");
  assertCanonicalSize(draft, MAX_ACTION_PROPOSAL_BYTES, "action proposal draft");
  validateProposalOwnership(draft);
  validatePlanning(draft);
  assertActor(draft.requested_by, "$.proposal.requested_by");
  validateProposalContent(draft);
  const created = assertTimestamp(draft.created_at, "$.proposal.created_at");
  const expires = assertTimestamp(draft.expires_at, "$.proposal.expires_at");
  if (expires <= created) invalid("proposal expiry must follow creation");
}

export function validateProposalRecord(proposal: ActionProposalV1): void {
  exactObject(proposal, [...PROPOSAL_FIELDS, "proposal_id", "proposal_digest"], [], "$.proposal");
  assertCanonicalSize(proposal, MAX_ACTION_PROPOSAL_BYTES, "action proposal");
  assertDerivedId(proposal.proposal_id, "proposal", "$.proposal.proposal_id");
  assertDigest(proposal.proposal_digest, "$.proposal.proposal_digest");
}

function validatePlanning(draft: ActionProposalDraftV1): void {
  const row = exactObject(
    draft.planning_options,
    ["mode", "network_read"],
    [],
    "$.proposal.planning_options",
  );
  const valid =
    (row.mode === "durable" && row.network_read === "ordinary-host-policy") ||
    (row.mode === "transient" &&
      ["forbid", "allow-if-granted"].includes(row.network_read as string));
  if (!valid) invalid("invalid planning options");
  if (draft.action_root_locator.kind === "conversation" && row.mode !== "durable")
    invalid("conversation-root planning must be durable");
}

function invalid(message: string): never {
  throw new ActionValidationError(message, "$.proposal");
}
