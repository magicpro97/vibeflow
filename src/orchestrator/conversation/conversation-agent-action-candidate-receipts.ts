import { exactObject } from "../../actions/index.js";
import { digestV1 } from "../../durability/index.js";
import {
  AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN,
  AGENT_ACTION_CANDIDATE_RECEIPT_STATE,
  AGENT_ACTION_CANDIDATE_RECORD_FIELDS,
  AGENT_ACTION_CANDIDATE_RECORD_KIND,
  AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
  type AgentActionCandidateSchemaVersionV1,
  type DurableAgentActionCandidateRejectionCodeV1,
  isAgentActionCandidateReceiptState,
  isAgentActionCandidateRejectionCode,
  isAgentActionCandidateSchemaVersion,
} from "./conversation-agent-action-candidate-contract.js";
import { requireDigest, requireOpaqueId } from "./conversation-agent-action-candidate-records.js";

export type { DurableAgentActionCandidateRejectionCodeV1 } from "./conversation-agent-action-candidate-contract.js";

export interface DurableAgentActionCandidateMaterializedReceiptV1 {
  schema_version: AgentActionCandidateSchemaVersionV1;
  state: typeof AGENT_ACTION_CANDIDATE_RECEIPT_STATE.MATERIALIZED;
  record_digest: string;
  origin_response_event_id: string;
  proposal_id: string;
  proposal_digest: string;
  rejection_code: null;
  receipt_digest: string;
}

export interface DurableAgentActionCandidateRejectedReceiptV1 {
  schema_version: AgentActionCandidateSchemaVersionV1;
  state: typeof AGENT_ACTION_CANDIDATE_RECEIPT_STATE.REJECTED;
  record_digest: string;
  origin_response_event_id: null;
  proposal_id: null;
  proposal_digest: null;
  rejection_code: DurableAgentActionCandidateRejectionCodeV1;
  receipt_digest: string;
}

export type DurableAgentActionCandidateReceiptV1 =
  | DurableAgentActionCandidateMaterializedReceiptV1
  | DurableAgentActionCandidateRejectedReceiptV1;

function receiptPreimage(input: {
  record_digest: string;
  origin_response_event_id: string;
  proposal_id: string;
  proposal_digest: string;
}) {
  return {
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    state: AGENT_ACTION_CANDIDATE_RECEIPT_STATE.MATERIALIZED,
    record_digest: input.record_digest,
    origin_response_event_id: input.origin_response_event_id,
    proposal_id: input.proposal_id,
    proposal_digest: input.proposal_digest,
    rejection_code: null,
  };
}

function receiptDigest(input: ReturnType<typeof receiptPreimage>): string {
  return digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.RECEIPT, input);
}

export function materializeDurableAgentActionCandidateReceipt(input: {
  record_digest: string;
  origin_response_event_id: string;
  proposal_id: string;
  proposal_digest: string;
}): DurableAgentActionCandidateMaterializedReceiptV1 {
  const preimage = receiptPreimage(input);
  const receipt = {
    ...preimage,
    receipt_digest: receiptDigest(preimage),
  };
  validateReceipt(receipt);
  return receipt;
}

function rejectionPreimage(input: {
  record_digest: string;
  rejection_code: DurableAgentActionCandidateRejectionCodeV1;
}) {
  return {
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    state: AGENT_ACTION_CANDIDATE_RECEIPT_STATE.REJECTED,
    record_digest: input.record_digest,
    origin_response_event_id: null,
    proposal_id: null,
    proposal_digest: null,
    rejection_code: input.rejection_code,
  };
}

export function materializeDurableAgentActionCandidateRejection(input: {
  record_digest: string;
  rejection_code: DurableAgentActionCandidateRejectionCodeV1;
}): DurableAgentActionCandidateRejectedReceiptV1 {
  const preimage = rejectionPreimage(input);
  const receipt = {
    ...preimage,
    receipt_digest: digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.RECEIPT, preimage),
  };
  validateReceipt(receipt);
  return receipt;
}

export function validateReceipt(
  value: unknown,
): asserts value is DurableAgentActionCandidateReceiptV1 {
  const row = exactObject(
    value,
    AGENT_ACTION_CANDIDATE_RECORD_FIELDS.RECEIPT,
    [],
    `$.${AGENT_ACTION_CANDIDATE_RECORD_KIND.RECEIPT}`,
  );
  if (!isAgentActionCandidateSchemaVersion(row.schema_version))
    throw new Error("unsupported candidate receipt version");
  const state = row.state;
  if (!isAgentActionCandidateReceiptState(state))
    throw new Error("invalid materialized candidate receipt state");
  requireDigest(row.record_digest, "candidate receipt record digest");
  requireDigest(row.receipt_digest, "candidate receipt digest");
  if (state === AGENT_ACTION_CANDIDATE_RECEIPT_STATE.REJECTED) {
    if (
      row.origin_response_event_id !== null ||
      row.proposal_id !== null ||
      row.proposal_digest !== null ||
      !isAgentActionCandidateRejectionCode(row.rejection_code)
    )
      throw new Error("invalid rejected candidate receipt");
    const preimage = rejectionPreimage({
      record_digest: row.record_digest,
      rejection_code: row.rejection_code,
    });
    if (digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.RECEIPT, preimage) !== row.receipt_digest)
      throw new Error("candidate receipt digest mismatch");
    return;
  }
  if (state !== AGENT_ACTION_CANDIDATE_RECEIPT_STATE.MATERIALIZED || row.rejection_code !== null)
    throw new Error("invalid materialized candidate receipt state");
  requireOpaqueId(row.origin_response_event_id, "candidate receipt origin event id");
  requireOpaqueId(row.proposal_id, "candidate receipt proposal id");
  requireDigest(row.proposal_digest, "candidate receipt proposal digest");
  const expected = receiptPreimage({
    record_digest: row.record_digest,
    origin_response_event_id: row.origin_response_event_id,
    proposal_id: row.proposal_id,
    proposal_digest: row.proposal_digest,
  });
  if (receiptDigest(expected) !== row.receipt_digest)
    throw new Error("candidate receipt digest mismatch");
}
