import { digestHex } from "../durability/index.js";
import type { PublicErrorCode } from "./errors.js";
import { assertDigest, assertOpaqueId, assertTimestamp, bytewise } from "./record-primitives.js";
import { boundedString, exactObject, safeInteger } from "./strict-json.js";
import type { JsonScalar, JsonValue } from "./types.js";

export interface LineageNodeIdentityV1 {
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
}

export interface PublicOversizedHandoffCandidateV1 {
  schema_version: "1.0";
  candidate_id: string;
  candidate_digest: string;
  source: JsonValue;
  source_public_head_digest: string;
  selection_plan_digest: string;
  mandatory_projection_digest: string;
  prompt_budget_bytes: number;
  encoded_candidate_bytes: number;
  overflow_bytes: number;
  created_at: string;
  expires_at: string;
}

export interface PublicErrorSpecialDetailsV1 {
  stale_action_projection_cursor: { restart_cursor: string; proposal_set_watermark: string };
  stale_catalog_cursor: { restart_cursor: string; catalog_generation: string };
  stale_capability_cursor: { restart_cursor: string; source_watermark: string };
  stale_pending_proposal_cursor: { restart_cursor: string; authority_watermark: string };
  stale_lineage_cursor: { restart_cursor: string; head_digest: string; head_epoch: number };
  stale_timeline_cursor: {
    restart_cursor: string;
    head: LineageNodeIdentityV1;
    head_digest: string;
    head_epoch: number;
  };
  stale_operation_cursor: {
    restart_cursor: string;
    proposal_id: string;
    operation_id: string | null;
  };
  future_event_cursor: { current_last_seq: number };
  not_lineage_head: {
    root_session_id: string;
    current_head: LineageNodeIdentityV1;
    head_digest: string;
    head_epoch: number;
  };
  lineage_head_unresolved: {
    root_session_id: string;
    head_status: "ambiguous" | "unclaimed";
    candidate_heads: LineageNodeIdentityV1[];
    head_digest: string;
    head_epoch: number;
  };
  handoff_too_large: { candidate: PublicOversizedHandoffCandidateV1 };
  pre_effect_refused: {
    operation_id: string;
    reason_code:
      | "scope-base-stale"
      | "authority-head-stale"
      | "policy-stale"
      | "grant-stale"
      | "permission-stale"
      | "user-prerequisite-stale"
      | "source-authority-stale"
      | "private-input-stale"
      | "enforcement-stale"
      | "owned-preimage-stale";
    frontier_kind: "operation" | "adapter-step" | "health-batch" | "lock-publication";
  };
  private_input_head_conflict: {
    scope: "project" | "user";
    package_id: string;
    input_ids: string[];
  };
  scope_locked: { scope: "project" | "user" };
}

export type PublicErrorDetailsV1<C extends PublicErrorCode> =
  C extends keyof PublicErrorSpecialDetailsV1
    ? PublicErrorSpecialDetailsV1[C]
    : Record<string, JsonScalar> | null;

export function validatePublicErrorDetails(code: PublicErrorCode, value: unknown): void {
  const schemas: Partial<Record<PublicErrorCode, readonly string[]>> = {
    stale_action_projection_cursor: ["restart_cursor", "proposal_set_watermark"],
    stale_catalog_cursor: ["restart_cursor", "catalog_generation"],
    stale_capability_cursor: ["restart_cursor", "source_watermark"],
    stale_pending_proposal_cursor: ["restart_cursor", "authority_watermark"],
    stale_lineage_cursor: ["restart_cursor", "head_digest", "head_epoch"],
    stale_timeline_cursor: ["restart_cursor", "head", "head_digest", "head_epoch"],
    stale_operation_cursor: ["restart_cursor", "proposal_id", "operation_id"],
    future_event_cursor: ["current_last_seq"],
    not_lineage_head: ["root_session_id", "current_head", "head_digest", "head_epoch"],
    lineage_head_unresolved: [
      "root_session_id",
      "head_status",
      "candidate_heads",
      "head_digest",
      "head_epoch",
    ],
    handoff_too_large: ["candidate"],
    pre_effect_refused: ["operation_id", "reason_code", "frontier_kind"],
    private_input_head_conflict: ["scope", "package_id", "input_ids"],
    scope_locked: ["scope"],
  };
  const schema = schemas[code];
  if (!schema) {
    validateScalarMap(value);
    return;
  }
  const row = exactObject(value, schema, [], "$.error.details");
  for (const key of schema) {
    const field = row[key];
    if (["head_epoch", "current_last_seq"].includes(key))
      safeInteger(field, `$.error.details.${key}`);
    else if (key === "head" || key === "current_head")
      validateLineageNode(field, `$.error.details.${key}`);
    else if (key === "candidate_heads") {
      if (!Array.isArray(field) || field.length > 256)
        throw new Error("invalid candidate head list");
      field.forEach((item, index) =>
        validateLineageNode(item, `$.error.details.candidate_heads[${index}]`),
      );
      const identities = field.map(
        (item) =>
          `${(item as LineageNodeIdentityV1).revision_ordinal}\0${(item as LineageNodeIdentityV1).conversation_id}\0${(item as LineageNodeIdentityV1).revision_id}`,
      );
      if (
        new Set(identities).size !== identities.length ||
        identities.some((item, index) => item !== [...identities].sort(bytewise)[index])
      )
        throw new Error("candidate heads are duplicated or unordered");
    } else if (key === "input_ids") validateSortedStrings(field, `$.error.details.${key}`);
    else if (key === "candidate") validateHandoffCandidate(field);
    else if (field !== null) boundedString(field, `$.error.details.${key}`, { max: 512 });
  }
  if (
    ("scope" in row && !["project", "user"].includes(row.scope as string)) ||
    ("head_status" in row && !["ambiguous", "unclaimed"].includes(row.head_status as string))
  )
    throw new Error("invalid closed public error enum");
  if ("head_digest" in row) assertDigest(row.head_digest, "$.error.details.head_digest");
  if (code === "pre_effect_refused") {
    const reasons = new Set([
      "scope-base-stale",
      "authority-head-stale",
      "policy-stale",
      "grant-stale",
      "permission-stale",
      "user-prerequisite-stale",
      "source-authority-stale",
      "private-input-stale",
      "enforcement-stale",
      "owned-preimage-stale",
    ]);
    if (
      !reasons.has(row.reason_code as string) ||
      !["operation", "adapter-step", "health-batch", "lock-publication"].includes(
        row.frontier_kind as string,
      )
    )
      throw new Error("invalid pre-effect refusal details");
  }
}

function validateScalarMap(value: unknown): void {
  if (value === null) return;
  const row = exactObject(value, Object.keys((value ?? {}) as object), [], "$.error.details");
  if (Object.keys(row).length > 32) throw new Error("public error details exceed bound");
  for (const [key, field] of Object.entries(row)) {
    if (field !== null && !["string", "number", "boolean"].includes(typeof field))
      throw new Error(`public error detail ${key} is not scalar`);
    if (typeof field === "number" && !Number.isFinite(field))
      throw new Error("invalid public error number");
    if (typeof field === "string") boundedString(field, `$.error.details.${key}`, { max: 512 });
  }
}

function validateLineageNode(value: unknown, path: string): void {
  const row = exactObject(value, ["conversation_id", "revision_id", "revision_ordinal"], [], path);
  boundedString(row.conversation_id, `${path}.conversation_id`);
  boundedString(row.revision_id, `${path}.revision_id`);
  safeInteger(row.revision_ordinal, `${path}.revision_ordinal`);
}

function validateSortedStrings(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128)
    throw new Error("invalid string list");
  const rows = value.map((item, index) => boundedString(item, `${path}[${index}]`));
  if (
    new Set(rows).size !== rows.length ||
    rows.some((item, index) => item !== [...rows].sort()[index])
  )
    throw new Error("public error string list is duplicated or unsorted");
}

function validateHandoffCandidate(value: unknown): void {
  const row = exactObject(
    value,
    [
      "schema_version",
      "candidate_id",
      "candidate_digest",
      "source",
      "source_public_head_digest",
      "selection_plan_digest",
      "mandatory_projection_digest",
      "prompt_budget_bytes",
      "encoded_candidate_bytes",
      "overflow_bytes",
      "created_at",
      "expires_at",
    ],
    [],
    "$.error.details.candidate",
  );
  if (row.schema_version !== "1.0") throw new Error("invalid handoff candidate version");
  assertDigest(row.candidate_digest, "$.error.details.candidate.candidate_digest");
  if (row.candidate_id !== `vf-oversized-handoff-${digestHex(row.candidate_digest as string)}`)
    throw new Error("public handoff candidate identity mismatch");
  const source = exactObject(
    row.source,
    ["conversation_id", "revision_id", "last_seq", "lock_digest"],
    [],
    "$.error.details.candidate.source",
  );
  assertOpaqueId(source.conversation_id, "$.error.details.candidate.source.conversation_id");
  assertOpaqueId(source.revision_id, "$.error.details.candidate.source.revision_id");
  safeInteger(source.last_seq, "$.error.details.candidate.source.last_seq");
  assertDigest(source.lock_digest, "$.error.details.candidate.source.lock_digest");
  for (const key of [
    "source_public_head_digest",
    "selection_plan_digest",
    "mandatory_projection_digest",
  ])
    assertDigest(row[key], `$.error.details.candidate.${key}`);
  const budget = safeInteger(
    row.prompt_budget_bytes,
    "$.error.details.candidate.prompt_budget_bytes",
  );
  const encoded = safeInteger(
    row.encoded_candidate_bytes,
    "$.error.details.candidate.encoded_candidate_bytes",
  );
  const overflow = safeInteger(row.overflow_bytes, "$.error.details.candidate.overflow_bytes");
  if (budget < 1 || encoded <= budget || overflow !== encoded - budget)
    throw new Error("public handoff candidate byte accounting mismatch");
  const created = assertTimestamp(row.created_at, "$.error.details.candidate.created_at");
  if (assertTimestamp(row.expires_at, "$.error.details.candidate.expires_at") !== created + 600_000)
    throw new Error("public handoff candidate expiry mismatch");
}
