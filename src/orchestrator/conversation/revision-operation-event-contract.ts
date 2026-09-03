import {
  ACTION_OPERATION_STATE,
  type ActionOperationDomainTerminalState,
  PUBLIC_OPERATION_REVISION_PHASE,
  isActionOperationDomainTerminalState,
} from "../../actions/protocol-contract.js";
import { digestV1 } from "../../durability/index.js";
import {
  hasExactLineageKeys,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";
import {
  type ParticipantStartReceiptV1,
  assertParticipantStartReceiptV1,
} from "./revision-participant-receipt.js";

type ValueOf<Contract> = Contract[keyof Contract];

export const REVISION_OPERATION_EVENT_SCHEMA_VERSION = "1.0" as const;
export const REVISION_OPERATION_EVENT_STORAGE = Object.freeze({
  DOMAIN: "revision-operation",
  DIGEST_DOMAIN: "VF-REVISION-OPERATION-EVENT\0v1\0",
} as const);

export const REVISION_OPERATION_INITIAL_PHASE = Object.freeze({ CREATED: "created" } as const);
export type RevisionOperationInitialPhaseV1 = ValueOf<typeof REVISION_OPERATION_INITIAL_PHASE>;

export const REVISION_OPERATION_PHASES = Object.freeze(
  Object.values(PUBLIC_OPERATION_REVISION_PHASE),
);
export type RevisionOperationStateV1 = ValueOf<typeof PUBLIC_OPERATION_REVISION_PHASE>;
export type RevisionOperationEventSourceStateV1 =
  | RevisionOperationInitialPhaseV1
  | RevisionOperationStateV1;

export const REVISION_OPERATION_EVENT_PAYLOAD_KIND = Object.freeze({
  STATE_TRANSITION: "state-transition",
  PARTICIPANT_START: "participant-start",
  RECONCILIATION_RESULT: "reconciliation-result",
  HEAD_COMMIT: "head-commit",
} as const);
export type RevisionOperationEventPayloadKindV1 = ValueOf<
  typeof REVISION_OPERATION_EVENT_PAYLOAD_KIND
>;
export const REVISION_OPERATION_EVENT_PAYLOAD_KINDS = Object.freeze(
  Object.values(REVISION_OPERATION_EVENT_PAYLOAD_KIND),
);

export interface RevisionActionTerminalBindingV1 {
  action_operation_id: string;
  outcome: ActionOperationDomainTerminalState;
  reason_code: string | null;
}

export interface RevisionStateTransitionPayloadV1 {
  kind: typeof REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION;
  from: RevisionOperationEventSourceStateV1;
  to: RevisionOperationStateV1;
  authorized_by_action_operation_id: string;
  effect_action_operation_id: string;
  action_terminals: RevisionActionTerminalBindingV1[];
  reason_code: string | null;
}

export interface RevisionParticipantStartPayloadV1 {
  kind: typeof REVISION_OPERATION_EVENT_PAYLOAD_KIND.PARTICIPANT_START;
  authorized_by_action_operation_id: string;
  effect_action_operation_id: string;
  receipt: ParticipantStartReceiptV1;
}

export interface RevisionReconciliationResultPayloadV1 {
  kind: typeof REVISION_OPERATION_EVENT_PAYLOAD_KIND.RECONCILIATION_RESULT;
  authorized_by_action_operation_id: string;
  effect_action_operation_id: string;
  observed_state_digest: string;
  outcome: typeof ACTION_OPERATION_STATE.FAILED;
  action_terminals: RevisionActionTerminalBindingV1[];
  reason_code: string;
}

export interface RevisionHeadCommitPayloadV1 {
  kind: typeof REVISION_OPERATION_EVENT_PAYLOAD_KIND.HEAD_COMMIT;
  authorized_by_action_operation_id: string;
  effect_action_operation_id: string;
  prior_head_digest: string;
  prior_head_checkpoint_digest: string;
  committed_head_digest: string;
  directory_fsync_completed: true;
}

export type RevisionOperationPayloadV1 =
  | RevisionStateTransitionPayloadV1
  | RevisionParticipantStartPayloadV1
  | RevisionReconciliationResultPayloadV1
  | RevisionHeadCommitPayloadV1;

export interface RevisionOperationEventV1 {
  schema_version: typeof REVISION_OPERATION_EVENT_SCHEMA_VERSION;
  operation_id: string;
  sequence: number;
  previous_event_digest: string | null;
  payload: RevisionOperationPayloadV1;
  recorded_at: string;
  event_digest: string;
}

export type RevisionStateTransitionEventV1 = Omit<RevisionOperationEventV1, "payload"> & {
  payload: RevisionStateTransitionPayloadV1;
};
export type RevisionHeadCommitEventV1 = Omit<RevisionOperationEventV1, "payload"> & {
  payload: RevisionHeadCommitPayloadV1;
};

const fields = <const Fields extends readonly string[]>(...values: Fields): Readonly<Fields> =>
  Object.freeze(values);

export const REVISION_ACTION_TERMINAL_FIELDS = fields(
  "action_operation_id",
  "outcome",
  "reason_code",
);
export const REVISION_OPERATION_EVENT_FIELDS = fields(
  "schema_version",
  "operation_id",
  "sequence",
  "previous_event_digest",
  "payload",
  "recorded_at",
  "event_digest",
);
export const REVISION_OPERATION_EVENT_PAYLOAD_FIELDS = Object.freeze({
  [REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION]: fields(
    "kind",
    "from",
    "to",
    "authorized_by_action_operation_id",
    "effect_action_operation_id",
    "action_terminals",
    "reason_code",
  ),
  [REVISION_OPERATION_EVENT_PAYLOAD_KIND.PARTICIPANT_START]: fields(
    "kind",
    "authorized_by_action_operation_id",
    "effect_action_operation_id",
    "receipt",
  ),
  [REVISION_OPERATION_EVENT_PAYLOAD_KIND.RECONCILIATION_RESULT]: fields(
    "kind",
    "authorized_by_action_operation_id",
    "effect_action_operation_id",
    "observed_state_digest",
    "outcome",
    "action_terminals",
    "reason_code",
  ),
  [REVISION_OPERATION_EVENT_PAYLOAD_KIND.HEAD_COMMIT]: fields(
    "kind",
    "authorized_by_action_operation_id",
    "effect_action_operation_id",
    "prior_head_digest",
    "prior_head_checkpoint_digest",
    "committed_head_digest",
    "directory_fsync_completed",
  ),
} as const satisfies {
  [Kind in RevisionOperationEventPayloadKindV1]: readonly (keyof Extract<
    RevisionOperationPayloadV1,
    { kind: Kind }
  >)[];
});

type SameKeys<Shape, Fields extends readonly PropertyKey[]> = Exclude<
  keyof Shape,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof Shape> extends never
    ? true
    : false
  : false;
type InvalidPayloadFieldContract = {
  [Kind in RevisionOperationEventPayloadKindV1]: SameKeys<
    Extract<RevisionOperationPayloadV1, { kind: Kind }>,
    (typeof REVISION_OPERATION_EVENT_PAYLOAD_FIELDS)[Kind]
  > extends true
    ? never
    : Kind;
}[RevisionOperationEventPayloadKindV1];

export const REVISION_OPERATION_EVENT_FIELD_CONTRACTS_EXACT: SameKeys<
  RevisionOperationEventV1,
  typeof REVISION_OPERATION_EVENT_FIELDS
> extends true
  ? SameKeys<RevisionActionTerminalBindingV1, typeof REVISION_ACTION_TERMINAL_FIELDS> extends true
    ? [InvalidPayloadFieldContract] extends [never]
      ? true
      : false
    : false
  : false = true;

const OPERATION_ID = /^vf-operation-[0-9a-f]{64}$/u;
const REASON_CODE = /^[a-z][a-z0-9_~-]{0,127}$/u;
const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isRevisionOperationEventPayloadKind = (
  value: unknown,
): value is RevisionOperationEventPayloadKindV1 =>
  memberOf(REVISION_OPERATION_EVENT_PAYLOAD_KINDS, value);
export const isRevisionOperationState = (value: unknown): value is RevisionOperationStateV1 =>
  memberOf(REVISION_OPERATION_PHASES, value);
export const isRevisionOperationEventSourceState = (
  value: unknown,
): value is RevisionOperationEventSourceStateV1 =>
  value === REVISION_OPERATION_INITIAL_PHASE.CREATED || isRevisionOperationState(value);

function assertActionTerminals(value: unknown): asserts value is RevisionActionTerminalBindingV1[] {
  if (!Array.isArray(value)) throw new Error("invalid revision action terminal bindings");
  for (const terminal of value) {
    if (
      !isPlainLineageRecord(terminal) ||
      !hasExactLineageKeys(terminal, REVISION_ACTION_TERMINAL_FIELDS) ||
      typeof terminal.action_operation_id !== "string" ||
      !OPERATION_ID.test(terminal.action_operation_id) ||
      !isActionOperationDomainTerminalState(terminal.outcome) ||
      (terminal.reason_code !== null &&
        (typeof terminal.reason_code !== "string" || !REASON_CODE.test(terminal.reason_code))) ||
      (terminal.outcome === ACTION_OPERATION_STATE.SUCCEEDED) !== (terminal.reason_code === null)
    )
      throw new Error("invalid revision action terminal bindings");
  }
}

function assertCommonPayloadAuthority(payload: Record<string, unknown>): void {
  if (
    typeof payload.authorized_by_action_operation_id !== "string" ||
    !OPERATION_ID.test(payload.authorized_by_action_operation_id) ||
    typeof payload.effect_action_operation_id !== "string" ||
    !OPERATION_ID.test(payload.effect_action_operation_id)
  )
    throw new Error("invalid revision operation event payload authority");
}

function assertRevisionOperationPayload(
  value: unknown,
): asserts value is RevisionOperationPayloadV1 {
  if (
    !isPlainLineageRecord(value) ||
    !isRevisionOperationEventPayloadKind(value.kind) ||
    !hasExactLineageKeys(value, REVISION_OPERATION_EVENT_PAYLOAD_FIELDS[value.kind])
  )
    throw new Error("invalid revision operation event payload");
  assertCommonPayloadAuthority(value);
  if (value.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION) {
    if (
      !isRevisionOperationEventSourceState(value.from) ||
      !isRevisionOperationState(value.to) ||
      (value.reason_code !== null &&
        (typeof value.reason_code !== "string" || !REASON_CODE.test(value.reason_code)))
    )
      throw new Error("invalid revision state transition payload");
    assertActionTerminals(value.action_terminals);
  } else if (value.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.PARTICIPANT_START) {
    assertParticipantStartReceiptV1(value.receipt);
  } else if (value.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.RECONCILIATION_RESULT) {
    if (
      !isLineageDigest(value.observed_state_digest) ||
      value.outcome !== ACTION_OPERATION_STATE.FAILED ||
      typeof value.reason_code !== "string" ||
      !REASON_CODE.test(value.reason_code)
    )
      throw new Error("invalid revision reconciliation result payload");
    assertActionTerminals(value.action_terminals);
  } else if (
    !isLineageDigest(value.prior_head_digest) ||
    !isLineageDigest(value.prior_head_checkpoint_digest) ||
    !isLineageDigest(value.committed_head_digest) ||
    value.directory_fsync_completed !== true
  ) {
    throw new Error("invalid revision head commit payload");
  }
}

export function assertRevisionOperationEventV1(
  value: unknown,
): asserts value is RevisionOperationEventV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, REVISION_OPERATION_EVENT_FIELDS) ||
    value.schema_version !== REVISION_OPERATION_EVENT_SCHEMA_VERSION ||
    typeof value.operation_id !== "string" ||
    !OPERATION_ID.test(value.operation_id) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.previous_event_digest !== null && !isLineageDigest(value.previous_event_digest)) ||
    ((value.sequence as number) === 0) !== (value.previous_event_digest === null) ||
    !isMillisecondIsoDate(value.recorded_at) ||
    !isLineageDigest(value.event_digest)
  )
    throw new Error("invalid revision operation event");
  assertRevisionOperationPayload(value.payload);
  const event = value as unknown as RevisionOperationEventV1;
  const { event_digest: _digest, ...preimage } = event;
  if (digestV1(REVISION_OPERATION_EVENT_STORAGE.DIGEST_DOMAIN, preimage) !== event.event_digest)
    throw new Error("invalid revision operation event digest");
}
