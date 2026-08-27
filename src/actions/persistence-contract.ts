type ValueOf<Contract> = Contract[keyof Contract];

const values = <const Contract extends Readonly<Record<string, string>>>(contract: Contract) =>
  Object.freeze(Object.values(contract)) as readonly ValueOf<Contract>[];

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const ACTION_IDEMPOTENCY_BINDING_STATE = Object.freeze({
  PREPARED: "prepared",
  VISIBLE: "visible",
} as const);
export type ActionIdempotencyBindingState = ValueOf<typeof ACTION_IDEMPOTENCY_BINDING_STATE>;
export const ACTION_IDEMPOTENCY_BINDING_STATES = values(ACTION_IDEMPOTENCY_BINDING_STATE);
export const ACTION_IDEMPOTENCY_BINDING_TERMINAL_STATES = Object.freeze([
  ACTION_IDEMPOTENCY_BINDING_STATE.VISIBLE,
] as const);
export const ACTION_IDEMPOTENCY_BINDING_TRANSITION_TARGETS = Object.freeze({
  [ACTION_IDEMPOTENCY_BINDING_STATE.PREPARED]: Object.freeze([
    ACTION_IDEMPOTENCY_BINDING_STATE.VISIBLE,
  ] as const),
  [ACTION_IDEMPOTENCY_BINDING_STATE.VISIBLE]: Object.freeze([] as const),
} satisfies Readonly<
  Record<ActionIdempotencyBindingState, readonly ActionIdempotencyBindingState[]>
>);

export const isActionIdempotencyBindingState = (
  value: unknown,
): value is ActionIdempotencyBindingState => memberOf(ACTION_IDEMPOTENCY_BINDING_STATES, value);

export const ACTION_APPROVAL_CHALLENGE_STATE = Object.freeze({
  CREATED: "created",
  FAILED_ATTEMPT: "failed-attempt",
  CONSUMED: "consumed",
  EXPIRED: "expired",
  LOCKED: "locked",
} as const);
export type ActionApprovalChallengeState = ValueOf<typeof ACTION_APPROVAL_CHALLENGE_STATE>;
export const ACTION_APPROVAL_CHALLENGE_STATES = values(ACTION_APPROVAL_CHALLENGE_STATE);
export const ACTION_APPROVAL_CHALLENGE_RETRYABLE_STATES = Object.freeze([
  ACTION_APPROVAL_CHALLENGE_STATE.CREATED,
  ACTION_APPROVAL_CHALLENGE_STATE.FAILED_ATTEMPT,
] as const);
export const ACTION_APPROVAL_CHALLENGE_FAILURE_STATES = Object.freeze([
  ACTION_APPROVAL_CHALLENGE_STATE.FAILED_ATTEMPT,
  ACTION_APPROVAL_CHALLENGE_STATE.LOCKED,
] as const);
export const ACTION_APPROVAL_CHALLENGE_TERMINAL_STATES = Object.freeze([
  ACTION_APPROVAL_CHALLENGE_STATE.CONSUMED,
  ACTION_APPROVAL_CHALLENGE_STATE.EXPIRED,
  ACTION_APPROVAL_CHALLENGE_STATE.LOCKED,
] as const);
const NO_ACTION_APPROVAL_CHALLENGE_TRANSITIONS = Object.freeze([] as const);
const ACTION_APPROVAL_CHALLENGE_ACTIVE_TRANSITIONS = Object.freeze([
  ACTION_APPROVAL_CHALLENGE_STATE.FAILED_ATTEMPT,
  ACTION_APPROVAL_CHALLENGE_STATE.CONSUMED,
  ACTION_APPROVAL_CHALLENGE_STATE.EXPIRED,
  ACTION_APPROVAL_CHALLENGE_STATE.LOCKED,
] as const);
export const ACTION_APPROVAL_CHALLENGE_TRANSITION_TARGETS = Object.freeze({
  [ACTION_APPROVAL_CHALLENGE_STATE.CREATED]: ACTION_APPROVAL_CHALLENGE_ACTIVE_TRANSITIONS,
  [ACTION_APPROVAL_CHALLENGE_STATE.FAILED_ATTEMPT]: ACTION_APPROVAL_CHALLENGE_ACTIVE_TRANSITIONS,
  [ACTION_APPROVAL_CHALLENGE_STATE.CONSUMED]: NO_ACTION_APPROVAL_CHALLENGE_TRANSITIONS,
  [ACTION_APPROVAL_CHALLENGE_STATE.EXPIRED]: NO_ACTION_APPROVAL_CHALLENGE_TRANSITIONS,
  [ACTION_APPROVAL_CHALLENGE_STATE.LOCKED]: NO_ACTION_APPROVAL_CHALLENGE_TRANSITIONS,
} satisfies Readonly<
  Record<ActionApprovalChallengeState, readonly ActionApprovalChallengeState[]>
>);

export const ACTION_APPROVAL_CHALLENGE_LIMIT = Object.freeze({
  LIFETIME_MS: 120_000,
  MAX_FAILED_ATTEMPTS: 5,
  ENTROPY_BYTES: 32,
} as const);

export const isActionApprovalChallengeState = (
  value: unknown,
): value is ActionApprovalChallengeState => memberOf(ACTION_APPROVAL_CHALLENGE_STATES, value);

export const isActionApprovalChallengeStateIn = <State extends ActionApprovalChallengeState>(
  states: readonly State[],
  value: ActionApprovalChallengeState,
): value is State => memberOf(states, value);

export const isActionApprovalChallengeTransition = (
  from: ActionApprovalChallengeState,
  to: ActionApprovalChallengeState,
): boolean => memberOf(ACTION_APPROVAL_CHALLENGE_TRANSITION_TARGETS[from], to);
