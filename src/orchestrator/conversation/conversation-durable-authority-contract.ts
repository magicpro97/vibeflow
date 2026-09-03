export const CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY = Object.freeze({
  COMMITTED: "committed",
  PROVEN_ABSENT: "proven-absent",
  UNKNOWN: "unknown",
} as const);
export type DurableTraceEventAuthority =
  (typeof CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY)[keyof typeof CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY];
export const CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITIES = Object.freeze(
  Object.values(CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY),
) as readonly DurableTraceEventAuthority[];

export const CONVERSATION_DURABLE_OPERATION_MEMBERSHIP = Object.freeze({
  CURRENT: "current",
  HISTORICAL: "historical",
  UNKNOWN: CONVERSATION_DURABLE_TRACE_EVENT_AUTHORITY.UNKNOWN,
} as const);
export type DurableOperationMembership =
  (typeof CONVERSATION_DURABLE_OPERATION_MEMBERSHIP)[keyof typeof CONVERSATION_DURABLE_OPERATION_MEMBERSHIP];
export const CONVERSATION_DURABLE_OPERATION_MEMBERSHIPS = Object.freeze(
  Object.values(CONVERSATION_DURABLE_OPERATION_MEMBERSHIP),
) as readonly DurableOperationMembership[];
