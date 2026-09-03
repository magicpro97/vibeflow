export * from "./public-operation-contract.js";

export const ACTION_ROOT_LOCATOR_KIND = Object.freeze({
  CONVERSATION: "conversation",
  CAPABILITY: "capability",
  RECOVERY_BOOTSTRAP: "recovery-bootstrap",
} as const);
export type ActionRootLocatorKind =
  (typeof ACTION_ROOT_LOCATOR_KIND)[keyof typeof ACTION_ROOT_LOCATOR_KIND];
export const ACTION_ROOT_LOCATOR_KINDS = Object.freeze(Object.values(ACTION_ROOT_LOCATOR_KIND));

export function isActionRootLocatorKind(value: unknown): value is ActionRootLocatorKind {
  return (
    typeof value === "string" && (ACTION_ROOT_LOCATOR_KINDS as readonly string[]).includes(value)
  );
}

export const ACTION_PRODUCER_REQUEST_BINDING_KIND = Object.freeze({
  CANONICAL_ACTION_REQUEST: "canonical-action-request",
  RECOVERY_BOOTSTRAP_REPAIR_PLAN: "recovery-bootstrap-repair-plan",
} as const);
export type ActionProducerRequestBindingKind =
  (typeof ACTION_PRODUCER_REQUEST_BINDING_KIND)[keyof typeof ACTION_PRODUCER_REQUEST_BINDING_KIND];
export const ACTION_PRODUCER_REQUEST_BINDING_KINDS = Object.freeze(
  Object.values(ACTION_PRODUCER_REQUEST_BINDING_KIND),
);

export function isActionProducerRequestBindingKind(
  value: unknown,
): value is ActionProducerRequestBindingKind {
  return (
    typeof value === "string" &&
    (ACTION_PRODUCER_REQUEST_BINDING_KINDS as readonly string[]).includes(value)
  );
}

export const ACTION_OPERATION_STATE = Object.freeze({
  PENDING_REVIEW: "pending_review",
  APPROVED: "approved",
  COMMITTING: "committing",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  DENIED: "denied",
  CANCELED: "canceled",
  EXPIRED: "expired",
  STALE: "stale",
  NEEDS_RECOVERY: "needs_recovery",
} as const);

export type ActionOperationState =
  (typeof ACTION_OPERATION_STATE)[keyof typeof ACTION_OPERATION_STATE];

export const ACTION_OPERATION_STATES = Object.freeze(Object.values(ACTION_OPERATION_STATE));

export const ACTION_OPERATION_TERMINAL_STATES = Object.freeze([
  ACTION_OPERATION_STATE.SUCCEEDED,
  ACTION_OPERATION_STATE.FAILED,
  ACTION_OPERATION_STATE.DENIED,
  ACTION_OPERATION_STATE.CANCELED,
  ACTION_OPERATION_STATE.EXPIRED,
  ACTION_OPERATION_STATE.STALE,
  ACTION_OPERATION_STATE.NEEDS_RECOVERY,
] as const);

export type ActionOperationTerminalState = (typeof ACTION_OPERATION_TERMINAL_STATES)[number];

export const ACTION_OPERATION_DOMAIN_TERMINAL_STATES = Object.freeze([
  ACTION_OPERATION_STATE.SUCCEEDED,
  ACTION_OPERATION_STATE.FAILED,
  ACTION_OPERATION_STATE.NEEDS_RECOVERY,
] as const);

export type ActionOperationDomainTerminalState =
  (typeof ACTION_OPERATION_DOMAIN_TERMINAL_STATES)[number];

export const ACTION_OPERATION_RESOLVED_DOMAIN_STATES = Object.freeze([
  ACTION_OPERATION_STATE.SUCCEEDED,
  ACTION_OPERATION_STATE.FAILED,
] as const);

export type ActionOperationResolvedDomainState =
  (typeof ACTION_OPERATION_RESOLVED_DOMAIN_STATES)[number];

export const ACTION_OPERATION_DISPATCH_REPLAY_STATES = Object.freeze([
  ACTION_OPERATION_STATE.COMMITTING,
  ...ACTION_OPERATION_DOMAIN_TERMINAL_STATES,
] as const);

export type ActionOperationDispatchReplayState =
  (typeof ACTION_OPERATION_DISPATCH_REPLAY_STATES)[number];

export const ACTION_OPERATION_DISPATCH_RESERVATION_READ_STATES = Object.freeze([
  ACTION_OPERATION_STATE.APPROVED,
  ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
] as const);

export type ActionOperationDispatchReservationReadState =
  (typeof ACTION_OPERATION_DISPATCH_RESERVATION_READ_STATES)[number];

export const ACTION_OPERATION_DISPATCH_RESERVATION_ASSERT_STATES = Object.freeze([
  ACTION_OPERATION_STATE.APPROVED,
  ACTION_OPERATION_STATE.COMMITTING,
  ACTION_OPERATION_STATE.NEEDS_RECOVERY,
] as const);

export type ActionOperationDispatchReservationAssertState =
  (typeof ACTION_OPERATION_DISPATCH_RESERVATION_ASSERT_STATES)[number];

export const ACTION_OPERATION_DISPATCH_BEGIN_STATES = Object.freeze([
  ACTION_OPERATION_STATE.APPROVED,
  ACTION_OPERATION_STATE.COMMITTING,
] as const);

export type ActionOperationDispatchBeginState =
  (typeof ACTION_OPERATION_DISPATCH_BEGIN_STATES)[number];

export const ACTION_OPERATION_TERMINAL_RESOLUTION_STATES = Object.freeze([
  ACTION_OPERATION_STATE.COMMITTING,
  ACTION_OPERATION_STATE.NEEDS_RECOVERY,
] as const);

export type ActionOperationTerminalResolutionState =
  (typeof ACTION_OPERATION_TERMINAL_RESOLUTION_STATES)[number];

export const ACTION_OPERATION_PROPOSAL_OPEN_STATES = Object.freeze([
  ACTION_OPERATION_STATE.PENDING_REVIEW,
  ACTION_OPERATION_STATE.APPROVED,
] as const);

export type ActionOperationProposalOpenState =
  (typeof ACTION_OPERATION_PROPOSAL_OPEN_STATES)[number];

export const ACTION_OPERATION_REVIEW_INVALIDATION_STATES = Object.freeze([
  ACTION_OPERATION_STATE.EXPIRED,
  ACTION_OPERATION_STATE.STALE,
] as const);

export type ActionOperationReviewInvalidationState =
  (typeof ACTION_OPERATION_REVIEW_INVALIDATION_STATES)[number];

export const ACTION_OPERATION_REVIEW_DECISION_STATES = Object.freeze([
  ACTION_OPERATION_STATE.APPROVED,
  ACTION_OPERATION_STATE.DENIED,
] as const);

export type ActionOperationReviewDecisionState =
  (typeof ACTION_OPERATION_REVIEW_DECISION_STATES)[number];

/** States whose durable history necessarily contains an approval decision record. */
export const ACTION_OPERATION_APPROVAL_REQUIRED_STATES = Object.freeze([
  ACTION_OPERATION_STATE.APPROVED,
  ACTION_OPERATION_STATE.COMMITTING,
  ACTION_OPERATION_STATE.SUCCEEDED,
  ACTION_OPERATION_STATE.FAILED,
  ACTION_OPERATION_STATE.DENIED,
  ACTION_OPERATION_STATE.NEEDS_RECOVERY,
] as const);

/** States whose durable history cannot yet contain an approval decision record. */
export const ACTION_OPERATION_APPROVAL_PROHIBITED_STATES = Object.freeze([
  ACTION_OPERATION_STATE.PENDING_REVIEW,
] as const);

const NO_ACTION_OPERATION_TRANSITIONS = Object.freeze([] as const);

export const ACTION_OPERATION_TRANSITION_TARGETS = Object.freeze({
  [ACTION_OPERATION_STATE.PENDING_REVIEW]: Object.freeze([
    ACTION_OPERATION_STATE.APPROVED,
    ACTION_OPERATION_STATE.DENIED,
    ACTION_OPERATION_STATE.CANCELED,
    ...ACTION_OPERATION_REVIEW_INVALIDATION_STATES,
  ] as const),
  [ACTION_OPERATION_STATE.APPROVED]: Object.freeze([
    ACTION_OPERATION_STATE.COMMITTING,
    ACTION_OPERATION_STATE.CANCELED,
    ...ACTION_OPERATION_REVIEW_INVALIDATION_STATES,
  ] as const),
  [ACTION_OPERATION_STATE.COMMITTING]: ACTION_OPERATION_DOMAIN_TERMINAL_STATES,
  [ACTION_OPERATION_STATE.NEEDS_RECOVERY]: ACTION_OPERATION_RESOLVED_DOMAIN_STATES,
  [ACTION_OPERATION_STATE.SUCCEEDED]: NO_ACTION_OPERATION_TRANSITIONS,
  [ACTION_OPERATION_STATE.FAILED]: NO_ACTION_OPERATION_TRANSITIONS,
  [ACTION_OPERATION_STATE.DENIED]: NO_ACTION_OPERATION_TRANSITIONS,
  [ACTION_OPERATION_STATE.CANCELED]: NO_ACTION_OPERATION_TRANSITIONS,
  [ACTION_OPERATION_STATE.EXPIRED]: NO_ACTION_OPERATION_TRANSITIONS,
  [ACTION_OPERATION_STATE.STALE]: NO_ACTION_OPERATION_TRANSITIONS,
} satisfies Readonly<Record<ActionOperationState, readonly ActionOperationState[]>>);

export const ACTION_OPERATION_SSE_EVENT = Object.freeze({
  OPERATION: "operation",
  ERROR: "error",
  HEARTBEAT: "heartbeat",
} as const);

export type ActionOperationSseEventName =
  (typeof ACTION_OPERATION_SSE_EVENT)[keyof typeof ACTION_OPERATION_SSE_EVENT];

export const ACTION_OPERATION_SSE_EVENTS = Object.freeze(Object.values(ACTION_OPERATION_SSE_EVENT));

export const ACTION_OPERATION_EVENT_SCHEMA_VERSION = "1.0" as const;
export const ACTION_AUTHORITY_EVENT_KIND = Object.freeze({
  PROPOSAL_CREATED: "proposal-created",
  APPROVAL_DECISION: "approval-decision",
  STATE_TRANSITION: "state-transition",
} as const);

export type ActionAuthorityEventKind =
  (typeof ACTION_AUTHORITY_EVENT_KIND)[keyof typeof ACTION_AUTHORITY_EVENT_KIND];

export const ACTION_AUTHORITY_EVENT_KINDS = Object.freeze(
  Object.values(ACTION_AUTHORITY_EVENT_KIND),
);

export function isActionAuthorityEventKind(value: unknown): value is ActionAuthorityEventKind {
  return (
    typeof value === "string" && (ACTION_AUTHORITY_EVENT_KINDS as readonly string[]).includes(value)
  );
}
export const ACTION_OPERATION_EVENT_CURSOR_PATTERN = Object.freeze(
  /^vf-operation-event-[0-9a-f]{64}$/u,
);

export const ACTION_OPERATION_EVENT_FIELD = Object.freeze({
  SCHEMA_VERSION: "schema_version",
  OPERATION_ID: "operation_id",
  PHASE_SEQUENCE: "phase_sequence",
  STATE: "state",
  PROGRESS: "progress",
  TARGET: "target",
  ERROR: "error",
  OCCURRED_AT: "occurred_at",
  EVENT_CURSOR: "event_cursor",
} as const);

export const ACTION_OPERATION_EVENT_FIELDS = Object.freeze(
  Object.values(ACTION_OPERATION_EVENT_FIELD),
);

export const ACTION_OPERATION_ERROR_FIELD = Object.freeze({
  CODE: "code",
  MESSAGE: "message",
  CORRELATION_ID: "correlation_id",
  RETRYABLE: "retryable",
  RECOVERY_ACTION: "recovery_action",
  DETAILS: "details",
} as const);

export const ACTION_OPERATION_ERROR_FIELDS = Object.freeze(
  Object.values(ACTION_OPERATION_ERROR_FIELD),
);

export interface ActionOperationSsePayloadV1<Progress, Target, ErrorBody> {
  schema_version: typeof ACTION_OPERATION_EVENT_SCHEMA_VERSION;
  operation_id: string;
  phase_sequence: number;
  state: ActionOperationState;
  progress: Progress | null;
  target: Target | null;
  error: ErrorBody | null;
  occurred_at: string;
  event_cursor: string;
}

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isActionOperationState = (value: unknown): value is ActionOperationState =>
  memberOf(ACTION_OPERATION_STATES, value);

export const isActionOperationTerminalState = (
  value: unknown,
): value is ActionOperationTerminalState => memberOf(ACTION_OPERATION_TERMINAL_STATES, value);

export const isActionOperationDomainTerminalState = (
  value: unknown,
): value is ActionOperationDomainTerminalState =>
  memberOf(ACTION_OPERATION_DOMAIN_TERMINAL_STATES, value);

export const isActionOperationResolvedDomainState = (
  value: unknown,
): value is ActionOperationResolvedDomainState =>
  memberOf(ACTION_OPERATION_RESOLVED_DOMAIN_STATES, value);

export const isActionOperationDispatchReplayState = (
  value: unknown,
): value is ActionOperationDispatchReplayState =>
  memberOf(ACTION_OPERATION_DISPATCH_REPLAY_STATES, value);

export const isActionOperationDispatchReservationReadState = (
  value: unknown,
): value is ActionOperationDispatchReservationReadState =>
  memberOf(ACTION_OPERATION_DISPATCH_RESERVATION_READ_STATES, value);

export const isActionOperationDispatchReservationAssertState = (
  value: unknown,
): value is ActionOperationDispatchReservationAssertState =>
  memberOf(ACTION_OPERATION_DISPATCH_RESERVATION_ASSERT_STATES, value);

export const isActionOperationDispatchBeginState = (
  value: unknown,
): value is ActionOperationDispatchBeginState =>
  memberOf(ACTION_OPERATION_DISPATCH_BEGIN_STATES, value);

export const isActionOperationTerminalResolutionState = (
  value: unknown,
): value is ActionOperationTerminalResolutionState =>
  memberOf(ACTION_OPERATION_TERMINAL_RESOLUTION_STATES, value);

export const isActionOperationProposalOpenState = (
  value: unknown,
): value is ActionOperationProposalOpenState =>
  memberOf(ACTION_OPERATION_PROPOSAL_OPEN_STATES, value);

export const isActionOperationReviewInvalidationState = (
  value: unknown,
): value is ActionOperationReviewInvalidationState =>
  memberOf(ACTION_OPERATION_REVIEW_INVALIDATION_STATES, value);

export const isActionOperationApprovalRequiredState = (
  value: unknown,
): value is (typeof ACTION_OPERATION_APPROVAL_REQUIRED_STATES)[number] =>
  memberOf(ACTION_OPERATION_APPROVAL_REQUIRED_STATES, value);

export const isActionOperationApprovalProhibitedState = (
  value: unknown,
): value is (typeof ACTION_OPERATION_APPROVAL_PROHIBITED_STATES)[number] =>
  memberOf(ACTION_OPERATION_APPROVAL_PROHIBITED_STATES, value);

export const isActionOperationTransition = (
  from: ActionOperationState,
  to: ActionOperationState,
): boolean => ACTION_OPERATION_TRANSITION_TARGETS[from].some((candidate) => candidate === to);

export const isActionOperationSseEventName = (
  value: unknown,
): value is ActionOperationSseEventName => memberOf(ACTION_OPERATION_SSE_EVENTS, value);
