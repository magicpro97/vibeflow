type ValueOf<Authority> = Authority[keyof Authority];

const frozenValues = <Value extends string>(authority: Readonly<Record<string, Value>>) =>
  Object.freeze(Object.values(authority)) as readonly Value[];

export const CONVERSATION_BASELINE_SKIP_REASON = Object.freeze({
  DISABLED: "disabled",
  SINGLE_PARTICIPANT: "single_participant",
  ENGINE_UNAVAILABLE: "engine_unavailable",
} as const);
export type ConversationBaselineSkipReasonV1 = ValueOf<typeof CONVERSATION_BASELINE_SKIP_REASON>;
export const CONVERSATION_BASELINE_SKIP_REASONS = frozenValues(CONVERSATION_BASELINE_SKIP_REASON);

export const CONVERSATION_BASELINE_FAILURE_REASON = Object.freeze({
  NO_DEBATE_ANSWER: "no_debate_answer",
  BASELINE_MISSING: "baseline_missing",
  BASELINE_FAILED: "baseline_failed",
  BASELINE_START_FAILED: "baseline_start_failed",
  ENGINE_TIMEOUT: "engine_timeout",
} as const);
export type ConversationBaselineFailureReasonV1 = ValueOf<
  typeof CONVERSATION_BASELINE_FAILURE_REASON
>;
export const CONVERSATION_BASELINE_FAILURE_REASONS = frozenValues(
  CONVERSATION_BASELINE_FAILURE_REASON,
);

export const CONVERSATION_BASELINE_REASON = Object.freeze({
  ...CONVERSATION_BASELINE_SKIP_REASON,
  ...CONVERSATION_BASELINE_FAILURE_REASON,
} as const);
export type ConversationBaselineReasonV1 = ValueOf<typeof CONVERSATION_BASELINE_REASON>;
export const CONVERSATION_BASELINE_REASONS = frozenValues(CONVERSATION_BASELINE_REASON);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isConversationBaselineReason = (
  value: unknown,
): value is ConversationBaselineReasonV1 => memberOf(CONVERSATION_BASELINE_REASONS, value);

export const isConversationBaselineFailureReason = (
  value: unknown,
): value is ConversationBaselineFailureReasonV1 =>
  memberOf(CONVERSATION_BASELINE_FAILURE_REASONS, value);
