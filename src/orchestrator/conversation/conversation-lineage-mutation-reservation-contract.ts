import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";

export const LINEAGE_MUTATION_RESERVATION_SCHEMA_VERSION = "1.0" as const;

export type LineageMutationReservationSchemaVersionV1 =
  typeof LINEAGE_MUTATION_RESERVATION_SCHEMA_VERSION;

export const LINEAGE_MUTATION_RESERVATION_STATUS = Object.freeze({
  ACTIVE: "active",
  RELEASED: "released",
} as const);

export type LineageMutationReservationStatusV1 =
  (typeof LINEAGE_MUTATION_RESERVATION_STATUS)[keyof typeof LINEAGE_MUTATION_RESERVATION_STATUS];

export const LINEAGE_MUTATION_RESERVATION_STATUSES = Object.freeze(
  Object.values(LINEAGE_MUTATION_RESERVATION_STATUS),
) as readonly LineageMutationReservationStatusV1[];

export const LINEAGE_MUTATION_KIND = Object.freeze({
  PUBLIC_LITERAL: "public-literal",
  CONTEXT_COMPACTION: "context-compaction",
} as const);

export type LineageMutationKindV1 =
  (typeof LINEAGE_MUTATION_KIND)[keyof typeof LINEAGE_MUTATION_KIND];

export const LINEAGE_MUTATION_KINDS = Object.freeze(
  Object.values(LINEAGE_MUTATION_KIND),
) as readonly LineageMutationKindV1[];

export const LINEAGE_MUTATION_ACTION_TYPE = Object.freeze({
  PUBLIC_LITERAL: HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL,
  CONTEXT_COMPACTION: HOST_ACTION_KIND.CONTEXT_COMPACT,
} as const);

export type LineageMutationActionTypeV1 =
  (typeof LINEAGE_MUTATION_ACTION_TYPE)[keyof typeof LINEAGE_MUTATION_ACTION_TYPE];

export const LINEAGE_MUTATION_ACTION_TYPES = Object.freeze(
  Object.values(LINEAGE_MUTATION_ACTION_TYPE),
) as readonly LineageMutationActionTypeV1[];

export const LINEAGE_MUTATION_RELEASE_OUTCOME = Object.freeze({
  SUCCEEDED: "succeeded",
  ABORTED: "aborted",
} as const);

export type LineageMutationReleaseOutcomeV1 =
  (typeof LINEAGE_MUTATION_RELEASE_OUTCOME)[keyof typeof LINEAGE_MUTATION_RELEASE_OUTCOME];

export const LINEAGE_MUTATION_RELEASE_OUTCOMES = Object.freeze(
  Object.values(LINEAGE_MUTATION_RELEASE_OUTCOME),
) as readonly LineageMutationReleaseOutcomeV1[];

export const LINEAGE_MUTATION_RESERVATION_STALE_REASON = Object.freeze({
  CONVERSATION_SOURCE_CHANGED: "conversation-source-changed",
} as const);

export type LineageMutationReservationStaleReasonV1 =
  (typeof LINEAGE_MUTATION_RESERVATION_STALE_REASON)[keyof typeof LINEAGE_MUTATION_RESERVATION_STALE_REASON];

export const LINEAGE_MUTATION_RESERVATION_ERROR_NAME = Object.freeze({
  BUSY: "ConversationLineageMutationBusyError",
} as const);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isLineageMutationReservationStatus = (
  value: unknown,
): value is LineageMutationReservationStatusV1 =>
  memberOf(LINEAGE_MUTATION_RESERVATION_STATUSES, value);

export const isLineageMutationKind = (value: unknown): value is LineageMutationKindV1 =>
  memberOf(LINEAGE_MUTATION_KINDS, value);

export const isLineageMutationActionType = (value: unknown): value is LineageMutationActionTypeV1 =>
  memberOf(LINEAGE_MUTATION_ACTION_TYPES, value);

export const isLineageMutationReleaseOutcome = (
  value: unknown,
): value is LineageMutationReleaseOutcomeV1 => memberOf(LINEAGE_MUTATION_RELEASE_OUTCOMES, value);
