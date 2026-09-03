/** Browser-safe lifecycle authority shared by trace, persistence, CLI, and UI consumers. */
const frozenValues = <Value extends string>(record: Readonly<Record<string, Value>>) =>
  Object.freeze(Object.values(record)) as readonly Value[];

export const CONVERSATION_LIFECYCLE = Object.freeze({
  INIT: "INIT",
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  NEEDS_INPUT: "NEEDS_INPUT",
  COMPLETED: "COMPLETED",
  STOPPED: "STOPPED",
  FAILED: "FAILED",
  ABORTED: "ABORTED",
} as const);
export type ConversationLifecycleV1 =
  (typeof CONVERSATION_LIFECYCLE)[keyof typeof CONVERSATION_LIFECYCLE];
export const CONVERSATION_LIFECYCLES = frozenValues(CONVERSATION_LIFECYCLE);

/** Canonical lifecycle graph. Same-state health transitions are validated separately. */
export const CONVERSATION_LIFECYCLE_TRANSITIONS = Object.freeze({
  [CONVERSATION_LIFECYCLE.INIT]: Object.freeze([
    CONVERSATION_LIFECYCLE.ACTIVE,
    CONVERSATION_LIFECYCLE.STOPPED,
  ]),
  [CONVERSATION_LIFECYCLE.ACTIVE]: Object.freeze([
    CONVERSATION_LIFECYCLE.PAUSED,
    CONVERSATION_LIFECYCLE.NEEDS_INPUT,
    CONVERSATION_LIFECYCLE.COMPLETED,
    CONVERSATION_LIFECYCLE.STOPPED,
    CONVERSATION_LIFECYCLE.FAILED,
    CONVERSATION_LIFECYCLE.ABORTED,
  ]),
  [CONVERSATION_LIFECYCLE.PAUSED]: Object.freeze([
    CONVERSATION_LIFECYCLE.ACTIVE,
    CONVERSATION_LIFECYCLE.STOPPED,
    CONVERSATION_LIFECYCLE.FAILED,
    CONVERSATION_LIFECYCLE.ABORTED,
  ]),
  [CONVERSATION_LIFECYCLE.NEEDS_INPUT]: Object.freeze([]),
  [CONVERSATION_LIFECYCLE.COMPLETED]: Object.freeze([]),
  [CONVERSATION_LIFECYCLE.STOPPED]: Object.freeze([]),
  [CONVERSATION_LIFECYCLE.FAILED]: Object.freeze([]),
  [CONVERSATION_LIFECYCLE.ABORTED]: Object.freeze([]),
} satisfies Readonly<Record<ConversationLifecycleV1, readonly ConversationLifecycleV1[]>>);

export const isConversationLifecycle = (value: unknown): value is ConversationLifecycleV1 =>
  typeof value === "string" && CONVERSATION_LIFECYCLES.some((candidate) => candidate === value);

export const isConversationLifecycleTransition = (
  current: ConversationLifecycleV1,
  next: ConversationLifecycleV1,
): boolean => CONVERSATION_LIFECYCLE_TRANSITIONS[current].some((candidate) => candidate === next);

export const CONVERSATION_NONTERMINAL_LIFECYCLE = Object.freeze({
  INIT: CONVERSATION_LIFECYCLE.INIT,
  ACTIVE: CONVERSATION_LIFECYCLE.ACTIVE,
  PAUSED: CONVERSATION_LIFECYCLE.PAUSED,
} as const);
export type ConversationNonterminalLifecycleV1 =
  (typeof CONVERSATION_NONTERMINAL_LIFECYCLE)[keyof typeof CONVERSATION_NONTERMINAL_LIFECYCLE];
export const CONVERSATION_NONTERMINAL_LIFECYCLES = frozenValues(CONVERSATION_NONTERMINAL_LIFECYCLE);

export const CONVERSATION_TRANSITION_LIFECYCLE = Object.freeze({
  ACTIVE: CONVERSATION_LIFECYCLE.ACTIVE,
  PAUSED: CONVERSATION_LIFECYCLE.PAUSED,
} as const);
export type ConversationTransitionLifecycleV1 =
  (typeof CONVERSATION_TRANSITION_LIFECYCLE)[keyof typeof CONVERSATION_TRANSITION_LIFECYCLE];
export const CONVERSATION_TRANSITION_LIFECYCLES = frozenValues(CONVERSATION_TRANSITION_LIFECYCLE);

export const CONVERSATION_TERMINAL_LIFECYCLE = Object.freeze({
  NEEDS_INPUT: CONVERSATION_LIFECYCLE.NEEDS_INPUT,
  COMPLETED: CONVERSATION_LIFECYCLE.COMPLETED,
  STOPPED: CONVERSATION_LIFECYCLE.STOPPED,
  FAILED: CONVERSATION_LIFECYCLE.FAILED,
  ABORTED: CONVERSATION_LIFECYCLE.ABORTED,
} as const);
export type ConversationTerminalLifecycleV1 =
  (typeof CONVERSATION_TERMINAL_LIFECYCLE)[keyof typeof CONVERSATION_TERMINAL_LIFECYCLE];
export const CONVERSATION_TERMINAL_LIFECYCLES = frozenValues(CONVERSATION_TERMINAL_LIFECYCLE);

export const isConversationTerminalLifecycle = (
  value: unknown,
): value is ConversationTerminalLifecycleV1 =>
  typeof value === "string" &&
  CONVERSATION_TERMINAL_LIFECYCLES.some((candidate) => candidate === value);

/** Graceful policy settlements require a complete response and lose races to pause/cancel. */
export const CONVERSATION_GRACEFUL_TERMINAL_LIFECYCLE = Object.freeze({
  NEEDS_INPUT: CONVERSATION_TERMINAL_LIFECYCLE.NEEDS_INPUT,
  COMPLETED: CONVERSATION_TERMINAL_LIFECYCLE.COMPLETED,
} as const);
export type ConversationGracefulTerminalLifecycleV1 =
  (typeof CONVERSATION_GRACEFUL_TERMINAL_LIFECYCLE)[keyof typeof CONVERSATION_GRACEFUL_TERMINAL_LIFECYCLE];
export const CONVERSATION_GRACEFUL_TERMINAL_LIFECYCLES = frozenValues(
  CONVERSATION_GRACEFUL_TERMINAL_LIFECYCLE,
);
export const isConversationGracefulTerminalLifecycle = (
  value: unknown,
): value is ConversationGracefulTerminalLifecycleV1 =>
  typeof value === "string" &&
  CONVERSATION_GRACEFUL_TERMINAL_LIFECYCLES.some((candidate) => candidate === value);

export const CONVERSATION_HEALTH = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
} as const);
export type ConversationHealthV1 = (typeof CONVERSATION_HEALTH)[keyof typeof CONVERSATION_HEALTH];
export const CONVERSATION_HEALTH_VALUES = frozenValues(CONVERSATION_HEALTH);

export const CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS = Object.freeze({
  NEEDS_INPUT: "needs_input",
  COMPLETED: "completed",
  STOPPED: "stopped",
  FAILED: "failed",
} as const);
export type ConversationPublicResponseTerminalStatusV1 =
  (typeof CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS)[keyof typeof CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS];
export const CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUSES = frozenValues(
  CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS,
);

export const conversationPublicResponseTerminalStatus = (
  lifecycle: unknown,
): ConversationPublicResponseTerminalStatusV1 => {
  if (lifecycle === CONVERSATION_LIFECYCLE.NEEDS_INPUT)
    return CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.NEEDS_INPUT;
  if (lifecycle === CONVERSATION_LIFECYCLE.FAILED)
    return CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.FAILED;
  if (lifecycle === CONVERSATION_LIFECYCLE.COMPLETED)
    return CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.COMPLETED;
  return CONVERSATION_PUBLIC_RESPONSE_TERMINAL_STATUS.STOPPED;
};
