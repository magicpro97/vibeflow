import { assertDigest, assertOpaqueId } from "./record-primitives.js";
import type { BrowserHostActionRequestV1 } from "./request-types.js";
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
  const row = exactObject(value, [
    "schema_version",
    "idempotency_key",
    "anchor_event_id",
    "expected",
    "candidate",
  ]);
  if (row.schema_version !== "1.0")
    throw new ActionValidationError(
      "unsupported schema version",
      "$.schema_version",
      "unsupported_schema_version",
    );
  const key = boundedString(row.idempotency_key, "$.idempotency_key", { min: 1, max: 128 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(key))
    throw new ActionValidationError("invalid idempotency_key grammar", "$.idempotency_key");
  if (row.anchor_event_id !== null) assertOpaqueId(row.anchor_event_id, "$.anchor_event_id");
  const expected = validateExpected(row.expected);
  const candidate = validateHostActionRequest(row.candidate, true) as BrowserHostActionRequestV1;
  if (
    (candidate.type === "conversation.select_lineage_head") !==
    (expected.mode === "lineage-recovery")
  )
    throw new ActionValidationError("action and expected source mode disagree", "$.expected.mode");
  return value as ActionProposalRequestV1;
}

function validateExpected(value: unknown): ActionProposalRequestV1["expected"] {
  const base = exactObject(
    value,
    ["mode"],
    [
      "root_session_id",
      "conversation_id",
      "revision_id",
      "last_seq",
      "conversation_lock_digest",
      "lineage_head_digest",
      "lineage_head_epoch",
    ],
    "$.expected",
  );
  const recovery = base.mode === "lineage-recovery";
  if (!recovery && base.mode !== "writable-revision")
    throw new ActionValidationError("unsupported expected mode", "$.expected.mode");
  const required = recovery
    ? [
        "mode",
        "root_session_id",
        "conversation_id",
        "revision_id",
        "last_seq",
        "conversation_lock_digest",
        "lineage_head_digest",
        "lineage_head_epoch",
      ]
    : ["mode", "conversation_id", "revision_id", "last_seq", "conversation_lock_digest"];
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
