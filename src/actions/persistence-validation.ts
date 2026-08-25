import { digestV1 } from "../durability/index.js";
import type { ActionIdempotencyBindingV1 } from "./persistence.js";
import {
  assertActor,
  assertDerivedId,
  assertDigest,
  assertOpaqueId,
  assertTimestamp,
} from "./record-primitives.js";
import { assertApproval, assertProposal, deriveOperationId } from "./records.js";
import { ActionValidationError, exactObject, safeInteger } from "./strict-json.js";
import type {
  ActionAuthorityEventV1,
  ActionDispatchRecordV1,
  ApprovalChallengeFrameV1,
} from "./types.js";

const IDEMPOTENCY_FIELDS = [
  "schema_version",
  "sequence",
  "previous_frame_digest",
  "state",
  "principal_digest",
  "authority_scope_digest",
  "idempotency_key_digest",
  "canonical_request_digest",
  "proposal_id",
  "proposal_digest",
  "created_at",
  "visible_at",
  "retain_until",
  "binding_digest",
] as const;
const CHALLENGE_FIELDS = [
  "schema_version",
  "challenge_id",
  "sequence",
  "previous_frame_digest",
  "proposal_id",
  "proposal_digest",
  "challenge_class",
  "principal_digest",
  "control_session_digest",
  "csrf_epoch_digest",
  "response_hmac_sha256",
  "state",
  "failed_attempts",
  "approval_decided_by",
  "approval_expires_at",
  "issued_at",
  "expires_at",
  "consumed_at",
  "frame_digest",
] as const;

export function validateIdempotencyBinding(value: unknown): ActionIdempotencyBindingV1 {
  const row = exactObject(value, IDEMPOTENCY_FIELDS, [], "$.idempotency");
  if (row.schema_version !== "1.0") invalid("unsupported idempotency version");
  if (row.sequence !== 0 && row.sequence !== 1) invalid("idempotency sequence is not 0 or 1");
  if (row.state !== (row.sequence === 0 ? "prepared" : "visible"))
    invalid("idempotency sequence/state mismatch");
  if ((row.sequence === 0) !== (row.previous_frame_digest === null))
    invalid("idempotency previous digest nullability mismatch");
  for (const field of [
    "principal_digest",
    "authority_scope_digest",
    "idempotency_key_digest",
    "canonical_request_digest",
    "proposal_digest",
    "binding_digest",
  ])
    assertDigest(row[field], `$.idempotency.${field}`);
  assertDerivedId(row.proposal_id, "proposal", "$.idempotency.proposal_id");
  const created = assertTimestamp(row.created_at, "$.idempotency.created_at");
  const retain = assertTimestamp(row.retain_until, "$.idempotency.retain_until");
  if (retain <= created) invalid("idempotency retention is invalid");
  if (row.state === "prepared" && row.visible_at !== null)
    invalid("prepared binding has visible time");
  if (row.state === "visible") {
    const visible = assertTimestamp(row.visible_at, "$.idempotency.visible_at");
    if (visible < created || visible >= retain)
      invalid("visible idempotency time is outside its retention window");
  }
  const { binding_digest: observed, ...preimage } = row;
  if (observed !== digestV1("VF-ACTION-IDEMPOTENCY-BINDING\0v1\0", preimage))
    invalid("idempotency binding digest mismatch");
  return value as ActionIdempotencyBindingV1;
}

export function validateIdempotencyChain(values: unknown[]): ActionIdempotencyBindingV1[] {
  const rows = values.map(validateIdempotencyBinding);
  if (rows.length < 1 || rows.length > 2) invalid("idempotency chain length is invalid");
  const first = rows[0];
  for (const [index, row] of rows.entries()) {
    if (row.sequence !== index) invalid("idempotency sequence is not dense");
    if (index && row.previous_frame_digest !== rows[index - 1]?.binding_digest)
      invalid("idempotency previous digest mismatch");
    if (
      first &&
      [
        "principal_digest",
        "authority_scope_digest",
        "idempotency_key_digest",
        "canonical_request_digest",
        "proposal_id",
        "proposal_digest",
        "created_at",
        "retain_until",
      ].some(
        (key) =>
          row[key as keyof ActionIdempotencyBindingV1] !==
          first[key as keyof ActionIdempotencyBindingV1],
      )
    )
      invalid("idempotency immutable binding changed");
  }
  return rows;
}

export function validateChallengeFrame(value: unknown): ApprovalChallengeFrameV1 {
  const row = exactObject(value, CHALLENGE_FIELDS, [], "$.challenge");
  if (row.schema_version !== "1.0") invalid("unsupported challenge version");
  const challengeId = assertOpaqueId(row.challenge_id, "$.challenge.challenge_id", 43);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(challengeId) ||
    Buffer.from(challengeId, "base64url").length !== 32
  )
    invalid("challenge ID is not 256-bit base64url");
  const sequence = safeInteger(row.sequence, "$.challenge.sequence");
  if (sequence > 5) invalid("challenge sequence exceeds bounded attempts");
  if ((row.sequence === 0) !== (row.previous_frame_digest === null))
    invalid("challenge previous digest nullability mismatch");
  if (row.previous_frame_digest !== null)
    assertDigest(row.previous_frame_digest, "$.challenge.previous_frame_digest");
  assertDerivedId(row.proposal_id, "proposal", "$.challenge.proposal_id");
  for (const field of [
    "proposal_digest",
    "principal_digest",
    "control_session_digest",
    "csrf_epoch_digest",
    "frame_digest",
  ])
    assertDigest(row[field], `$.challenge.${field}`);
  if (!/^[a-f0-9]{64}$/.test(row.response_hmac_sha256 as string))
    invalid("challenge HMAC is invalid");
  if (!["fresh-user-scope", "public-literal"].includes(row.challenge_class as string))
    invalid("challenge class is invalid");
  if (!["created", "failed-attempt", "consumed", "expired", "locked"].includes(row.state as string))
    invalid("challenge state is invalid");
  const attempts = safeInteger(row.failed_attempts, "$.challenge.failed_attempts");
  if (
    attempts > 5 ||
    (row.state === "created" && attempts !== 0) ||
    (row.state === "failed-attempt" && (attempts < 1 || attempts >= 5)) ||
    (row.state === "locked" && attempts !== 5)
  )
    invalid("challenge failure counter/state mismatch");
  const issued = assertTimestamp(row.issued_at, "$.challenge.issued_at");
  const expires = assertTimestamp(row.expires_at, "$.challenge.expires_at");
  if (expires !== issued + 120_000) invalid("challenge lifetime is not 120 seconds");
  const consumed = row.state === "consumed";
  if (
    consumed !==
    (row.approval_decided_by !== null &&
      row.approval_expires_at !== null &&
      row.consumed_at !== null)
  )
    invalid("challenge consumed authority nullability mismatch");
  if (
    !consumed &&
    (row.approval_decided_by !== null ||
      row.approval_expires_at !== null ||
      row.consumed_at !== null)
  )
    invalid("non-consumed challenge carries approval authority");
  if (consumed) {
    assertActor(row.approval_decided_by, "$.challenge.approval_decided_by");
    const consumedAt = assertTimestamp(row.consumed_at, "$.challenge.consumed_at");
    const approvalExpiry = assertTimestamp(
      row.approval_expires_at,
      "$.challenge.approval_expires_at",
    );
    if (consumedAt < issued) invalid("consumed challenge timestamp is before issuance");
    if (consumedAt > expires || approvalExpiry > expires || approvalExpiry <= consumedAt)
      invalid("consumed challenge approval window is invalid");
  }
  const { frame_digest: observed, ...preimage } = row;
  if (observed !== digestV1("VF-APPROVAL-CHALLENGE-FRAME\0v1\0", preimage))
    invalid("challenge frame digest mismatch");
  return value as ApprovalChallengeFrameV1;
}

export function validateChallengeChain(values: unknown[]): ApprovalChallengeFrameV1[] {
  const rows = values.map(validateChallengeFrame);
  const first = rows[0];
  if (!first || first.sequence !== 0 || first.state !== "created")
    invalid("challenge sequence zero is invalid");
  for (const [index, row] of rows.entries()) {
    if (
      row.sequence !== index ||
      (index && row.previous_frame_digest !== rows[index - 1]?.frame_digest)
    )
      invalid("challenge sequence is not dense");
    if (index && !["created", "failed-attempt"].includes(rows[index - 1]?.state ?? ""))
      invalid("terminal challenge has a successor");
    const previous = rows[index - 1];
    if (previous) {
      const expectedAttempts =
        row.state === "failed-attempt" || row.state === "locked"
          ? previous.failed_attempts + 1
          : previous.failed_attempts;
      if (
        row.state === "created" ||
        row.failed_attempts !== expectedAttempts ||
        (row.state === "locked" && previous.failed_attempts !== 4)
      )
        invalid("challenge transition or failure counter is invalid");
    }
    if (
      first &&
      [
        "challenge_id",
        "proposal_id",
        "proposal_digest",
        "challenge_class",
        "principal_digest",
        "control_session_digest",
        "csrf_epoch_digest",
        "response_hmac_sha256",
        "issued_at",
        "expires_at",
      ].some(
        (key) =>
          row[key as keyof ApprovalChallengeFrameV1] !==
          first[key as keyof ApprovalChallengeFrameV1],
      )
    )
      invalid("challenge immutable binding changed");
  }
  return rows;
}

export function validateAuthorityEvent(value: unknown): ActionAuthorityEventV1 {
  const row = exactObject(
    value,
    [
      "schema_version",
      "proposal_id",
      "sequence",
      "previous_event_digest",
      "payload",
      "recorded_at",
      "event_digest",
    ],
    [],
    "$.authority_event",
  );
  if (row.schema_version !== "1.0") invalid("unsupported action authority version");
  assertDerivedId(row.proposal_id, "proposal", "$.authority_event.proposal_id");
  safeInteger(row.sequence, "$.authority_event.sequence");
  if (row.previous_event_digest !== null)
    assertDigest(row.previous_event_digest, "$.authority_event.previous_event_digest");
  assertTimestamp(row.recorded_at, "$.authority_event.recorded_at");
  assertDigest(row.event_digest, "$.authority_event.event_digest");
  const payload = exactObject(
    row.payload,
    ["kind"],
    [
      "proposal",
      "from",
      "to",
      "approval",
      "operation_id",
      "dispatch_record_digest",
      "domain_terminal_digest",
      "reason_code",
    ],
    "$.authority_event.payload",
  );
  if (payload.kind === "proposal-created") {
    exactObject(row.payload, ["kind", "proposal"], [], "$.authority_event.payload");
    assertProposal(payload.proposal as never);
  } else if (payload.kind === "approval-decision") {
    exactObject(row.payload, ["kind", "from", "to", "approval"], [], "$.authority_event.payload");
  } else if (payload.kind === "state-transition") {
    exactObject(
      row.payload,
      [
        "kind",
        "from",
        "to",
        "operation_id",
        "dispatch_record_digest",
        "domain_terminal_digest",
        "reason_code",
      ],
      [],
      "$.authority_event.payload",
    );
  } else invalid("unknown action authority payload");
  const { event_digest: observed, ...preimage } = row;
  if (observed !== digestV1("VF-ACTION-AUTHORITY-EVENT\0v1\0", preimage))
    invalid("action authority event digest mismatch");
  return value as ActionAuthorityEventV1;
}

export function validateDispatchRecord(value: unknown): ActionDispatchRecordV1 {
  const row = exactObject(
    value,
    [
      "schema_version",
      "operation_id",
      "proposal_id",
      "proposal_digest",
      "approval_id",
      "approval_digest",
      "domain",
      "action_type",
      "action_root_locator",
      "execution_object_closure_digest",
      "plan_digest",
      "domain_header_digest",
      "created_at",
      "dispatch_record_digest",
    ],
    [],
    "$.dispatch",
  );
  if (row.schema_version !== "1.0") invalid("unsupported dispatch version");
  assertDerivedId(row.operation_id, "operation", "$.dispatch.operation_id");
  assertDerivedId(row.proposal_id, "proposal", "$.dispatch.proposal_id");
  assertDerivedId(row.approval_id, "approval", "$.dispatch.approval_id");
  for (const field of [
    "proposal_digest",
    "approval_digest",
    "plan_digest",
    "dispatch_record_digest",
  ])
    assertDigest(row[field], `$.dispatch.${field}`);
  if (row.execution_object_closure_digest !== null)
    assertDigest(row.execution_object_closure_digest, "$.dispatch.execution_object_closure_digest");
  if (row.domain_header_digest !== null)
    assertDigest(row.domain_header_digest, "$.dispatch.domain_header_digest");
  assertTimestamp(row.created_at, "$.dispatch.created_at");
  const { dispatch_record_digest: observed, ...preimage } = row;
  if (observed !== digestV1("VF-ACTION-DISPATCH-RECORD\0v1\0", preimage))
    invalid("dispatch record digest mismatch");
  return value as ActionDispatchRecordV1;
}

export function validateDispatchClosure(
  record: ActionDispatchRecordV1,
  proposal: Parameters<typeof deriveOperationId>[0],
  approvalId: string,
): void {
  if (record.operation_id !== deriveOperationId(proposal, approvalId))
    invalid("dispatch operation identity mismatch");
}

function invalid(message: string): never {
  throw new ActionValidationError(message, "$.durable_action");
}
