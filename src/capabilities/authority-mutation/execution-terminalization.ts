import type { ProcessLock } from "../../durability/index.js";
import { materializeTerminalReceipt } from "./contracts.js";
import type { OrdinaryAuthorityDurableStoreV1 } from "./store.js";
import type {
  AuthorityChangeOperationV1,
  AuthorityChangeTerminalReceiptV1,
  OrdinaryAuthorityTerminalEvidenceV1,
} from "./types.js";

export function recordOrdinaryAuthorityTerminalReceipt(input: {
  store: OrdinaryAuthorityDurableStoreV1;
  header: AuthorityChangeOperationV1;
  outcome: AuthorityChangeTerminalReceiptV1["outcome"];
  reason: AuthorityChangeTerminalReceiptV1["reason_code"];
  observed_authority_head_digest: string;
  recorded_at: string;
  lock: ProcessLock;
}): OrdinaryAuthorityTerminalEvidenceV1 {
  const receipt = materializeTerminalReceipt({
    schema_version: "1.0",
    operation_id: input.header.operation_id,
    sequence: 0,
    previous_receipt_digest: null,
    proposal_id: input.header.proposal_id,
    proposal_digest: input.header.proposal_digest,
    approval_id: input.header.approval_id,
    approval_digest: input.header.approval_digest,
    plan_digest: input.header.authority_change_plan_digest,
    action_root_locator: structuredClone(input.header.action_root_locator),
    operation_header_digest: input.header.header_digest,
    scope: input.header.scope,
    scope_identity_digest: input.header.scope_identity_digest,
    change: input.header.change,
    expected_authority_head_digest: input.header.expected_authority_head_digest,
    observed_authority_head_digest: input.observed_authority_head_digest,
    outcome: input.outcome,
    reason_code: input.reason,
    recorded_at: input.recorded_at,
  });
  input.store.appendTerminalHeld(receipt, input.lock);
  return {
    operation_id: input.header.operation_id,
    outcome: input.outcome,
    domain_terminal_digest: receipt.receipt_digest,
    recorded_at: receipt.recorded_at,
    authority_head: null,
    event: null,
    receipt,
  };
}
