export const CAPABILITY_DISPATCH_RESERVATION_SCHEMA_VERSION = "1.0" as const;

export type CapabilityDispatchReservationSchemaVersionV1 =
  typeof CAPABILITY_DISPATCH_RESERVATION_SCHEMA_VERSION;

export const CAPABILITY_DISPATCH_RESERVATION_STATUS = Object.freeze({
  ACTIVE: "active",
  RELEASED: "released",
} as const);

export type CapabilityDispatchReservationStatusV1 =
  (typeof CAPABILITY_DISPATCH_RESERVATION_STATUS)[keyof typeof CAPABILITY_DISPATCH_RESERVATION_STATUS];

export const CAPABILITY_DISPATCH_RESERVATION_STATUSES = Object.freeze(
  Object.values(CAPABILITY_DISPATCH_RESERVATION_STATUS),
) as readonly CapabilityDispatchReservationStatusV1[];

export const CAPABILITY_DISPATCH_RELEASE_OUTCOME = Object.freeze({
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  ABORTED: "aborted",
} as const);

export type CapabilityDispatchReleaseOutcomeV1 =
  (typeof CAPABILITY_DISPATCH_RELEASE_OUTCOME)[keyof typeof CAPABILITY_DISPATCH_RELEASE_OUTCOME];

export const CAPABILITY_DISPATCH_RELEASE_OUTCOMES = Object.freeze(
  Object.values(CAPABILITY_DISPATCH_RELEASE_OUTCOME),
) as readonly CapabilityDispatchReleaseOutcomeV1[];

export const CAPABILITY_DISPATCH_RESERVATION_STALE_REASON = Object.freeze({
  CONVERSATION_SOURCE_CHANGED: "conversation-source-changed",
} as const);

export type CapabilityDispatchReservationStaleReasonV1 =
  (typeof CAPABILITY_DISPATCH_RESERVATION_STALE_REASON)[keyof typeof CAPABILITY_DISPATCH_RESERVATION_STALE_REASON];

export const CAPABILITY_DISPATCH_RESERVATION_ERROR_NAME = Object.freeze({
  BUSY: "ConversationCapabilityDispatchBusyError",
} as const);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isCapabilityDispatchReservationStatus = (
  value: unknown,
): value is CapabilityDispatchReservationStatusV1 =>
  memberOf(CAPABILITY_DISPATCH_RESERVATION_STATUSES, value);

export const isCapabilityDispatchReleaseOutcome = (
  value: unknown,
): value is CapabilityDispatchReleaseOutcomeV1 =>
  memberOf(CAPABILITY_DISPATCH_RELEASE_OUTCOMES, value);
