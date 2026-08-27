import { HOST_ACTION_KIND } from "./host-action-contract.js";
import {
  ACTION_EXPECTED_SOURCE_MODE,
  ACTION_EXPECTED_SOURCE_OPTIONAL_FIELDS,
  ACTION_LINEAGE_RECOVERY_EXPECTATION_FIELDS,
  ACTION_PROPOSAL_REQUEST_FIELDS,
  ACTION_WRITABLE_REVISION_EXPECTATION_FIELDS,
  PUBLIC_ACTION_SCHEMA_VERSION,
} from "./public-action-contract.js";
import { PUBLIC_ERROR_CODE } from "./public-error-contract.js";
import { assertDigest, assertOpaqueId } from "./record-primitives.js";
import {
  ActionValidationError,
  boundedString,
  exactObject,
  parseStrictJson,
  safeInteger,
} from "./strict-json.js";
import type { ActionProposalRequestV1 } from "./types.js";
import { validateHostActionRequest } from "./validation.js";

export function parseActionProposalRequestJson(source: string): ActionProposalRequestV1 {
  const value = parseStrictJson(source);
  return validateActionProposalRequestValue(value);
}

export function validateActionProposalRequestValue(value: unknown): ActionProposalRequestV1 {
  validateProposalRequest(value, true);
  return value as ActionProposalRequestV1;
}

/** Canonical persistence may bind the CLI-only repair request without exposing it to browsers. */
export function assertCanonicalConversationActionRequestValue(value: unknown): void {
  validateProposalRequest(value, false);
}

function validateProposalRequest(value: unknown, browser: boolean): void {
  const row = exactObject(value, ACTION_PROPOSAL_REQUEST_FIELDS);
  if (row.schema_version !== PUBLIC_ACTION_SCHEMA_VERSION)
    throw new ActionValidationError(
      "unsupported schema version",
      "$.schema_version",
      PUBLIC_ERROR_CODE.UNSUPPORTED_SCHEMA_VERSION,
    );
  const key = boundedString(row.idempotency_key, "$.idempotency_key", { min: 1, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(key))
    throw new ActionValidationError("invalid idempotency_key grammar", "$.idempotency_key");
  if (row.anchor_event_id !== null) assertOpaqueId(row.anchor_event_id, "$.anchor_event_id");
  const expected = validateExpected(row.expected);
  const candidate = validateHostActionRequest(row.candidate, browser);
  if (
    (candidate.type === HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD) !==
    (expected.mode === ACTION_EXPECTED_SOURCE_MODE.LINEAGE_RECOVERY)
  )
    throw new ActionValidationError("action and expected source mode disagree", "$.expected.mode");
}

function validateExpected(value: unknown): ActionProposalRequestV1["expected"] {
  const base = exactObject(value, ["mode"], ACTION_EXPECTED_SOURCE_OPTIONAL_FIELDS, "$.expected");
  const recovery = base.mode === ACTION_EXPECTED_SOURCE_MODE.LINEAGE_RECOVERY;
  if (!recovery && base.mode !== ACTION_EXPECTED_SOURCE_MODE.WRITABLE_REVISION)
    throw new ActionValidationError("unsupported expected mode", "$.expected.mode");
  const required = recovery
    ? ACTION_LINEAGE_RECOVERY_EXPECTATION_FIELDS
    : ACTION_WRITABLE_REVISION_EXPECTATION_FIELDS;
  const row = exactObject(value, required, [], "$.expected");
  for (const field of required.filter((field) =>
    ["root_session_id", "conversation_id", "revision_id"].includes(field),
  ))
    assertOpaqueId(row[field], `$.expected.${field}`);
  assertDigest(row.conversation_lock_digest, "$.expected.conversation_lock_digest");
  if (recovery) assertDigest(row.lineage_head_digest, "$.expected.lineage_head_digest");
  safeInteger(row.last_seq, "$.expected.last_seq");
  if (recovery) safeInteger(row.lineage_head_epoch, "$.expected.lineage_head_epoch");
  return value as ActionProposalRequestV1["expected"];
}
