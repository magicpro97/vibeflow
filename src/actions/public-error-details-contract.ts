import type { HostActionKind } from "./host-action-contract.js";

type ValueOf<Contract> = Contract[keyof Contract];

export const PUBLIC_API_ERROR_SCHEMA_VERSION = "1.0" as const;
export const PUBLIC_ERROR_GENERIC_DETAILS_MAX_BYTES = 4_096 as const;
export const PUBLIC_ERROR_GENERIC_DETAILS_MAX_FIELDS = 64 as const;
export const PUBLIC_ERROR_GENERIC_DETAIL_KEY_MAX_BYTES = 256 as const;

export type PublicErrorScalarV1 = string | number | boolean | null;
export type PublicErrorScalarMapV1 = Record<string, PublicErrorScalarV1>;

export const PUBLIC_ERROR_SCOPE = Object.freeze({ PROJECT: "project", USER: "user" } as const);
export type PublicErrorScope = ValueOf<typeof PUBLIC_ERROR_SCOPE>;

export const PUBLIC_LINEAGE_HEAD_STATUS = Object.freeze({
  AMBIGUOUS: "ambiguous",
  UNCLAIMED: "unclaimed",
} as const);
export type PublicLineageHeadStatus = ValueOf<typeof PUBLIC_LINEAGE_HEAD_STATUS>;

export const PUBLIC_ERROR_PRE_EFFECT_REASON = Object.freeze({
  SCOPE_BASE_STALE: "scope-base-stale",
  AUTHORITY_HEAD_STALE: "authority-head-stale",
  POLICY_STALE: "policy-stale",
  GRANT_STALE: "grant-stale",
  PERMISSION_STALE: "permission-stale",
  USER_PREREQUISITE_STALE: "user-prerequisite-stale",
  SOURCE_AUTHORITY_STALE: "source-authority-stale",
  PRIVATE_INPUT_STALE: "private-input-stale",
  ENFORCEMENT_STALE: "enforcement-stale",
  OWNED_PREIMAGE_STALE: "owned-preimage-stale",
} as const);

export const PUBLIC_ERROR_PRE_EFFECT_FRONTIER = Object.freeze({
  OPERATION: "operation",
  ADAPTER_STEP: "adapter-step",
  HEALTH_BATCH: "health-batch",
  LOCK_PUBLICATION: "lock-publication",
} as const);

export interface LineageNodeIdentityV1 {
  conversation_id: string;
  revision_id: string;
  revision_ordinal: number;
}

export interface PublicOversizedHandoffCandidateV1 {
  schema_version: typeof PUBLIC_API_ERROR_SCHEMA_VERSION;
  candidate_id: string;
  candidate_digest: string;
  source: {
    conversation_id: string;
    revision_id: string;
    last_seq: number;
    lock_digest: string;
  };
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
    head_status: PublicLineageHeadStatus;
    candidate_heads: LineageNodeIdentityV1[];
    head_digest: string;
    head_epoch: number;
  };
  handoff_too_large: { candidate: PublicOversizedHandoffCandidateV1 };
  pre_effect_refused: {
    operation_id: string;
    reason_code: ValueOf<typeof PUBLIC_ERROR_PRE_EFFECT_REASON>;
    frontier_kind: ValueOf<typeof PUBLIC_ERROR_PRE_EFFECT_FRONTIER>;
  };
  scope_needs_recovery: { operation_id: string | null };
  private_input_head_conflict: {
    scope: PublicErrorScope;
    package_id: string;
    input_ids: string[];
  };
  scope_locked: { scope: PublicErrorScope };
  target_unsupported: { action_type: HostActionKind } | null;
  catalog_degraded: { recoverable_by_id: boolean };
}

export const PUBLIC_LINEAGE_NODE_FIELDS = Object.freeze([
  "conversation_id",
  "revision_id",
  "revision_ordinal",
] as const);

export const PUBLIC_HANDOFF_CANDIDATE_FIELDS = Object.freeze([
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
] as const);

export const PUBLIC_HANDOFF_SOURCE_FIELDS = Object.freeze([
  "conversation_id",
  "revision_id",
  "last_seq",
  "lock_digest",
] as const);

const fields = <const Fields extends readonly string[]>(...values: Fields): Readonly<Fields> =>
  Object.freeze(values);

export const PUBLIC_ERROR_DETAIL_FIELDS = Object.freeze({
  stale_action_projection_cursor: fields("restart_cursor", "proposal_set_watermark"),
  stale_catalog_cursor: fields("restart_cursor", "catalog_generation"),
  stale_capability_cursor: fields("restart_cursor", "source_watermark"),
  stale_pending_proposal_cursor: fields("restart_cursor", "authority_watermark"),
  stale_lineage_cursor: fields("restart_cursor", "head_digest", "head_epoch"),
  stale_timeline_cursor: fields("restart_cursor", "head", "head_digest", "head_epoch"),
  stale_operation_cursor: fields("restart_cursor", "proposal_id", "operation_id"),
  future_event_cursor: fields("current_last_seq"),
  not_lineage_head: fields("root_session_id", "current_head", "head_digest", "head_epoch"),
  lineage_head_unresolved: fields(
    "root_session_id",
    "head_status",
    "candidate_heads",
    "head_digest",
    "head_epoch",
  ),
  handoff_too_large: fields("candidate"),
  pre_effect_refused: fields("operation_id", "reason_code", "frontier_kind"),
  scope_needs_recovery: fields("operation_id"),
  private_input_head_conflict: fields("scope", "package_id", "input_ids"),
  scope_locked: fields("scope"),
  target_unsupported: fields("action_type"),
  catalog_degraded: fields("recoverable_by_id"),
} as const satisfies {
  [Code in keyof PublicErrorSpecialDetailsV1]: readonly (
    | keyof NonNullable<PublicErrorSpecialDetailsV1[Code]>
    | never
  )[];
});

export const PUBLIC_ERROR_NULLABLE_DETAIL_FIELDS = Object.freeze({
  stale_operation_cursor: fields("operation_id"),
  scope_needs_recovery: fields("operation_id"),
} as const satisfies Partial<{
  [Code in keyof PublicErrorSpecialDetailsV1]: readonly (
    | keyof NonNullable<PublicErrorSpecialDetailsV1[Code]>
    | never
  )[];
}>);

type SameKeys<Shape, Fields extends readonly PropertyKey[]> = Exclude<
  keyof Shape,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof Shape> extends never
    ? true
    : false
  : false;

type InvalidDetailFieldContract = {
  [Code in keyof PublicErrorSpecialDetailsV1]: SameKeys<
    NonNullable<PublicErrorSpecialDetailsV1[Code]>,
    (typeof PUBLIC_ERROR_DETAIL_FIELDS)[Code]
  > extends true
    ? never
    : Code;
}[keyof PublicErrorSpecialDetailsV1];

type NestedFieldContractsExact = SameKeys<
  LineageNodeIdentityV1,
  typeof PUBLIC_LINEAGE_NODE_FIELDS
> extends true
  ? SameKeys<PublicOversizedHandoffCandidateV1, typeof PUBLIC_HANDOFF_CANDIDATE_FIELDS> extends true
    ? SameKeys<
        PublicOversizedHandoffCandidateV1["source"],
        typeof PUBLIC_HANDOFF_SOURCE_FIELDS
      > extends true
      ? true
      : false
    : false
  : false;

export const PUBLIC_ERROR_FIELD_CONTRACTS_EXACT: [InvalidDetailFieldContract] extends [never]
  ? NestedFieldContractsExact
  : false = true;
