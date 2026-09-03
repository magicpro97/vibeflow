import {
  ACTION_APPROVAL_CHALLENGE_CLASSES,
  ACTION_APPROVAL_CHALLENGE_ID_PATTERN,
  ACTION_APPROVAL_CHALLENGE_REQUEST_FIELDS,
  ACTION_APPROVAL_REQUEST_FIELDS,
  ACTION_CANCEL_REQUEST_FIELDS,
  ACTION_COMMIT_REQUEST_FIELDS,
  ACTION_DECISION,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import { PUBLIC_ERROR_CODE } from "./public-error-contract.js";
import type {
  ActionApprovalChallengeRequestV1,
  ActionApprovalRequestV1,
  ActionCancelRequestV1,
  ActionCommitRequestV1,
} from "./public-types.js";
import { assertDerivedId, assertDigest } from "./record-primitives.js";
import {
  ActionValidationError,
  boundedString,
  exactObject,
  parseStrictJson,
} from "./strict-json.js";

export function parseActionApprovalChallengeRequestJson(
  source: string,
): ActionApprovalChallengeRequestV1 {
  const value = parseStrictJson(source);
  const row = versioned(value, ACTION_APPROVAL_CHALLENGE_REQUEST_FIELDS);
  assertDigest(row.proposal_digest, "$.proposal_digest");
  if (!ACTION_APPROVAL_CHALLENGE_CLASSES.some((value) => value === row.challenge_class))
    throw new ActionValidationError("invalid challenge class", "$.challenge_class");
  return value as unknown as ActionApprovalChallengeRequestV1;
}

export function parseActionApprovalRequestJson(source: string): ActionApprovalRequestV1 {
  const value = parseStrictJson(source);
  const row = versioned(value, ACTION_APPROVAL_REQUEST_FIELDS);
  assertDigest(row.proposal_digest, "$.proposal_digest");
  if (row.decision !== ACTION_DECISION.APPROVED && row.decision !== ACTION_DECISION.DENIED)
    throw new ActionValidationError("invalid approval decision", "$.decision");
  const hasId = row.challenge_id !== null;
  const hasResponse = row.challenge_response !== null;
  if (hasId !== hasResponse)
    throw new ActionValidationError("challenge fields must be jointly null or non-null", "$");
  if (hasId) {
    assertChallengeId(row.challenge_id);
    boundedString(row.challenge_response, "$.challenge_response", { max: 128 });
  }
  if (row.decision === ACTION_DECISION.DENIED && hasId)
    throw new ActionValidationError("denial cannot carry a challenge", "$");
  return value as unknown as ActionApprovalRequestV1;
}

export function parseActionCommitRequestJson(source: string): ActionCommitRequestV1 {
  const value = parseStrictJson(source);
  const row = versioned(value, ACTION_COMMIT_REQUEST_FIELDS);
  assertDigest(row.proposal_digest, "$.proposal_digest");
  assertDerivedId(row.approval_id, "approval", "$.approval_id");
  return value as unknown as ActionCommitRequestV1;
}

export function parseActionCancelRequestJson(source: string): ActionCancelRequestV1 {
  const value = parseStrictJson(source);
  const row = versioned(value, ACTION_CANCEL_REQUEST_FIELDS);
  assertDigest(row.proposal_digest, "$.proposal_digest");
  if (row.reason !== null) boundedString(row.reason, "$.reason", { max: 512 });
  return value as unknown as ActionCancelRequestV1;
}

function versioned(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const row = exactObject(value, fields, [], "$.");
  if (row.schema_version !== PUBLIC_ACTION_SCHEMA_VERSION)
    throw new ActionValidationError(
      "unsupported schema version",
      "$.schema_version",
      PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION,
    );
  return row;
}

function assertChallengeId(value: unknown): void {
  const id = boundedString(value, "$.challenge_id", { min: 43, max: 43 });
  if (!ACTION_APPROVAL_CHALLENGE_ID_PATTERN.test(id) || Buffer.from(id, "base64url").length !== 32)
    throw new ActionValidationError("challenge ID must be 256-bit base64url", "$.challenge_id");
}
