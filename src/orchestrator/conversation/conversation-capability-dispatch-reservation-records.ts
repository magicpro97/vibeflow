import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type {
  ActionApprovalV1,
  ActionDispatchRecordV1,
  ActionProposalV1,
} from "../../actions/index.js";
import { deriveOperationId } from "../../actions/index.js";
import {
  canonicalJsonBytes,
  digestHex,
  digestV1,
  privateFileBytes,
} from "../../durability/index.js";
import {
  CAPABILITY_DISPATCH_RESERVATION_ERROR_NAME,
  CAPABILITY_DISPATCH_RESERVATION_SCHEMA_VERSION,
  CAPABILITY_DISPATCH_RESERVATION_STATUS,
  type CapabilityDispatchReleaseOutcomeV1,
  type CapabilityDispatchReservationSchemaVersionV1,
  type CapabilityDispatchReservationStatusV1,
  isCapabilityDispatchReleaseOutcome,
  isCapabilityDispatchReservationStatus,
} from "./conversation-capability-dispatch-reservation-contract.js";
import { lineageStorageKey } from "./lineage-storage-key.js";
import {
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

export const MAX_CAPABILITY_DISPATCH_RESERVATION_BYTES = 256 * 1024;
const PROPOSAL = /^vf-proposal-[0-9a-f]{64}$/;
const APPROVAL = /^vf-approval-[0-9a-f]{64}$/;
const OPERATION = /^vf-operation-[0-9a-f]{64}$/;

export interface ConversationCapabilityDispatchSourceV1 {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  last_seq: number;
  conversation_lock_digest: string;
  lineage_head_digest: string;
  lineage_head_epoch: number;
  participant_binding_set_digest: string;
  target_set_digest: string;
  producer_participant_id: string | null;
  producer_request_binding_digest: string;
  producer_host_tool_grant_digest: string | null;
  capability_grant_digest: string;
}

export interface ConversationCapabilityDispatchReservationV1 {
  schema_version: CapabilityDispatchReservationSchemaVersionV1;
  root_session_id: string;
  reservation_epoch: number;
  previous_reservation_digest: string | null;
  status: CapabilityDispatchReservationStatusV1;
  proposal_id: string;
  proposal_digest: string;
  approval_id: string;
  approval_digest: string;
  operation_id: string;
  dispatch_record_digest: string;
  domain_header_digest: string;
  source: ConversationCapabilityDispatchSourceV1;
  release_outcome: CapabilityDispatchReleaseOutcomeV1 | null;
  domain_terminal_digest: string | null;
  created_at: string;
  updated_at: string;
  content_digest: string;
}

export class ConversationCapabilityDispatchBusyError extends Error {
  override readonly name = CAPABILITY_DISPATCH_RESERVATION_ERROR_NAME.BUSY;
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function capabilityDispatchReservationPath(
  artifactRoot: string,
  rootSessionId: string,
): string {
  return join(
    artifactRoot,
    "lineage",
    "v1",
    "capability-dispatch-reservations",
    `${digestHex(lineageStorageKey(rootSessionId))}.json`,
  );
}

export function capabilityDispatchReservationDigest(
  value: Omit<ConversationCapabilityDispatchReservationV1, "content_digest">,
): string {
  return digestV1("VF-CONVERSATION-CAPABILITY-DISPATCH-RESERVATION\0v1\0", value);
}

export function assertConversationCapabilityDispatchSourceV1(
  value: unknown,
): asserts value is ConversationCapabilityDispatchSourceV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "capability_grant_digest",
      "conversation_id",
      "conversation_lock_digest",
      "last_seq",
      "lineage_head_digest",
      "lineage_head_epoch",
      "participant_binding_set_digest",
      "producer_host_tool_grant_digest",
      "producer_participant_id",
      "producer_request_binding_digest",
      "revision_id",
      "root_session_id",
      "target_set_digest",
    ]) ||
    !isBoundedLineageReference(value.root_session_id) ||
    !isBoundedLineageReference(value.conversation_id) ||
    !isBoundedLineageReference(value.revision_id) ||
    !Number.isSafeInteger(value.last_seq) ||
    (value.last_seq as number) < 0 ||
    !Number.isSafeInteger(value.lineage_head_epoch) ||
    (value.lineage_head_epoch as number) < 0 ||
    (value.producer_participant_id !== null &&
      !isBoundedLineageReference(value.producer_participant_id)) ||
    (value.producer_host_tool_grant_digest !== null &&
      !isLineageDigest(value.producer_host_tool_grant_digest)) ||
    ![
      value.conversation_lock_digest,
      value.lineage_head_digest,
      value.participant_binding_set_digest,
      value.target_set_digest,
      value.producer_request_binding_digest,
      value.capability_grant_digest,
    ].every(isLineageDigest)
  )
    throw new Error("invalid conversation capability dispatch source");
  if ((value.producer_participant_id === null) !== (value.producer_host_tool_grant_digest === null))
    throw new Error("conversation capability producer grant is incomplete");
}

export function assertConversationCapabilityDispatchReservationV1(
  value: unknown,
): asserts value is ConversationCapabilityDispatchReservationV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, [
      "approval_digest",
      "approval_id",
      "content_digest",
      "created_at",
      "dispatch_record_digest",
      "domain_header_digest",
      "domain_terminal_digest",
      "operation_id",
      "previous_reservation_digest",
      "proposal_digest",
      "proposal_id",
      "release_outcome",
      "reservation_epoch",
      "root_session_id",
      "schema_version",
      "source",
      "status",
      "updated_at",
    ]) ||
    value.schema_version !== CAPABILITY_DISPATCH_RESERVATION_SCHEMA_VERSION ||
    !isBoundedLineageReference(value.root_session_id) ||
    !Number.isSafeInteger(value.reservation_epoch) ||
    (value.reservation_epoch as number) < 1 ||
    !isCapabilityDispatchReservationStatus(value.status) ||
    typeof value.proposal_id !== "string" ||
    !PROPOSAL.test(value.proposal_id) ||
    typeof value.approval_id !== "string" ||
    !APPROVAL.test(value.approval_id) ||
    typeof value.operation_id !== "string" ||
    !OPERATION.test(value.operation_id) ||
    ![
      value.proposal_digest,
      value.approval_digest,
      value.dispatch_record_digest,
      value.domain_header_digest,
      value.content_digest,
    ].every(isLineageDigest) ||
    (value.previous_reservation_digest !== null &&
      !isLineageDigest(value.previous_reservation_digest)) ||
    !isMillisecondIsoDate(value.created_at) ||
    !isMillisecondIsoDate(value.updated_at) ||
    (value.updated_at as string) < (value.created_at as string) ||
    (value.release_outcome !== null &&
      !isCapabilityDispatchReleaseOutcome(value.release_outcome)) ||
    (value.domain_terminal_digest !== null && !isLineageDigest(value.domain_terminal_digest)) ||
    (value.status === CAPABILITY_DISPATCH_RESERVATION_STATUS.ACTIVE) !==
      (value.release_outcome === null && value.domain_terminal_digest === null) ||
    (value.status === CAPABILITY_DISPATCH_RESERVATION_STATUS.RELEASED) !==
      (value.release_outcome !== null && value.domain_terminal_digest !== null)
  )
    throw new Error("invalid conversation capability dispatch reservation");
  assertConversationCapabilityDispatchSourceV1(value.source);
  if (value.source.root_session_id !== value.root_session_id)
    throw new Error("conversation capability dispatch reservation root mismatch");
  const { content_digest: _digest, ...preimage } = value;
  if (
    capabilityDispatchReservationDigest(
      preimage as Omit<ConversationCapabilityDispatchReservationV1, "content_digest">,
    ) !== value.content_digest
  )
    throw new Error("conversation capability dispatch reservation digest mismatch");
}

export function decodeCapabilityDispatchRecord<T>(
  bytes: Buffer,
  validate: (value: unknown) => void,
): T {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validate(value);
  if (
    !sameBytes(
      bytes,
      canonicalJsonBytes(value, { maxBytes: MAX_CAPABILITY_DISPATCH_RESERVATION_BYTES }),
    )
  )
    throw new Error("conversation capability dispatch reservation is non-canonical");
  return structuredClone(value) as T;
}

export function readConversationCapabilityDispatchReservation(
  artifactRoot: string,
  rootSessionId: string,
): ConversationCapabilityDispatchReservationV1 | null {
  const bytes = privateFileBytes(
    capabilityDispatchReservationPath(artifactRoot, rootSessionId),
    MAX_CAPABILITY_DISPATCH_RESERVATION_BYTES,
  );
  if (bytes === null) return null;
  const record = decodeCapabilityDispatchRecord<ConversationCapabilityDispatchReservationV1>(
    bytes,
    assertConversationCapabilityDispatchReservationV1,
  );
  if (record.root_session_id !== rootSessionId)
    throw new Error("conversation capability dispatch reservation storage key mismatch");
  return record;
}

export function materializeActiveCapabilityDispatchReservation(input: {
  prior: ConversationCapabilityDispatchReservationV1 | null;
  proposal: ActionProposalV1;
  approval: ActionApprovalV1;
  dispatch: ActionDispatchRecordV1;
  source: ConversationCapabilityDispatchSourceV1;
  now: string;
}): ConversationCapabilityDispatchReservationV1 {
  if (input.dispatch.domain_header_digest === null)
    throw new Error("capability dispatch reservation requires a domain header");
  const preimage = {
    schema_version: CAPABILITY_DISPATCH_RESERVATION_SCHEMA_VERSION,
    root_session_id: input.source.root_session_id,
    reservation_epoch: (input.prior?.reservation_epoch ?? 0) + 1,
    previous_reservation_digest: input.prior?.content_digest ?? null,
    status: CAPABILITY_DISPATCH_RESERVATION_STATUS.ACTIVE,
    proposal_id: input.proposal.proposal_id,
    proposal_digest: input.proposal.proposal_digest,
    approval_id: input.approval.approval_id,
    approval_digest: input.approval.approval_digest,
    operation_id: deriveOperationId(input.proposal, input.approval.approval_id),
    dispatch_record_digest: input.dispatch.dispatch_record_digest,
    domain_header_digest: input.dispatch.domain_header_digest,
    source: structuredClone(input.source),
    release_outcome: null,
    domain_terminal_digest: null,
    created_at: input.now,
    updated_at: input.now,
  };
  return { ...preimage, content_digest: capabilityDispatchReservationDigest(preimage) };
}

export function isSameCapabilityDispatchReservationAuthority(
  current: ConversationCapabilityDispatchReservationV1,
  proposal: ActionProposalV1,
  approval: ActionApprovalV1,
  dispatch: ActionDispatchRecordV1,
  source: ConversationCapabilityDispatchSourceV1,
): boolean {
  return (
    current.proposal_id === proposal.proposal_id &&
    current.proposal_digest === proposal.proposal_digest &&
    current.approval_id === approval.approval_id &&
    current.approval_digest === approval.approval_digest &&
    current.operation_id === deriveOperationId(proposal, approval.approval_id) &&
    current.dispatch_record_digest === dispatch.dispatch_record_digest &&
    current.domain_header_digest === dispatch.domain_header_digest &&
    sameBytes(canonicalJsonBytes(current.source), canonicalJsonBytes(source))
  );
}
