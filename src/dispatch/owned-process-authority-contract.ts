import { canonicalJsonBytes } from "../durability/canonical.js";
import {
  OWNED_PROCESS_RECORD_FIELD,
  OWNED_PROCESS_RECORD_FIELDS,
  OWNED_PROCESS_STATE,
  type OwnedProcessRecordField,
  type OwnedProcessState,
} from "./owned-process-contract.js";
import type { OwnedAttemptProcessRecordV1 } from "./owned-process-record-validation.js";

/** Central authority vocabulary for owned-process persistence and controller transitions. */
export const OWNED_PROCESS_AUTHORITY_OPERATION = Object.freeze({
  BIND_LAUNCH: "bind-launch",
  BIND_SUPERVISOR: "bind-supervisor",
  FAIL_LAUNCH: "fail-launch",
  FINALIZE: "finalize",
  NOTE_TERMINAL: "note-terminal",
} as const);

export type OwnedProcessAuthorityOperation =
  (typeof OWNED_PROCESS_AUTHORITY_OPERATION)[keyof typeof OWNED_PROCESS_AUTHORITY_OPERATION];

export const OWNED_PROCESS_AUTHORITY_ERROR = Object.freeze({
  BINDING_CONFLICT: "owned process identity binding conflicts with durable authority",
  ILLEGAL_TRANSITION: "owned process controller transition is illegal",
  RELEASE_PROOF_INVALID: "owned process release proof failed self-verification",
  STORAGE_BINDING: "owned process storage binding is invalid",
  WRITE_BINDING: "owned process write attempt binding is invalid",
  WRITE_TRANSITION: "owned process write transition is invalid",
} as const);

const field = OWNED_PROCESS_RECORD_FIELD;

const transitionFields = (
  ...fields: readonly OwnedProcessRecordField[]
): readonly OwnedProcessRecordField[] => Object.freeze(fields);

const WRITE_METADATA_FIELDS = transitionFields(field.UPDATED_AT, field.RECORD_DIGEST);
const PROCESS_BINDING_FIELDS = transitionFields(
  field.SUPERVISOR_PID,
  field.SUPERVISOR_IDENTITY,
  field.CLI_PID,
  field.CLI_IDENTITY,
);
const OUTCOME_FIELDS = transitionFields(field.RELEASE_REASON, field.EXIT_CODE);
const RELEASE_FIELDS = transitionFields(
  field.STATE,
  ...OUTCOME_FIELDS,
  field.PROCESS_QUIESCENT,
  field.PRIOR_RECORD_DIGEST,
  ...WRITE_METADATA_FIELDS,
);

/** Exact fields that a non-idempotent public record write may change for each state edge. */
export const OWNED_PROCESS_WRITE_TRANSITION_FIELDS = Object.freeze({
  [OWNED_PROCESS_STATE.RESERVED]: Object.freeze({
    [OWNED_PROCESS_STATE.RESERVED]: transitionFields(
      field.SUPERVISOR_PID,
      field.SUPERVISOR_IDENTITY,
      ...WRITE_METADATA_FIELDS,
    ),
    [OWNED_PROCESS_STATE.RUNNING]: transitionFields(
      field.STATE,
      ...PROCESS_BINDING_FIELDS,
      ...WRITE_METADATA_FIELDS,
    ),
    [OWNED_PROCESS_STATE.UNCERTAIN]: transitionFields(
      field.STATE,
      ...PROCESS_BINDING_FIELDS,
      ...OUTCOME_FIELDS,
      ...WRITE_METADATA_FIELDS,
    ),
    [OWNED_PROCESS_STATE.RELEASED]: RELEASE_FIELDS,
  }),
  [OWNED_PROCESS_STATE.RUNNING]: Object.freeze({
    [OWNED_PROCESS_STATE.RUNNING]: transitionFields(field.TERMINAL_KIND, ...WRITE_METADATA_FIELDS),
    [OWNED_PROCESS_STATE.UNCERTAIN]: transitionFields(
      field.STATE,
      ...OUTCOME_FIELDS,
      ...WRITE_METADATA_FIELDS,
    ),
    [OWNED_PROCESS_STATE.RELEASED]: RELEASE_FIELDS,
  }),
  [OWNED_PROCESS_STATE.UNCERTAIN]: Object.freeze({
    [OWNED_PROCESS_STATE.RELEASED]: RELEASE_FIELDS,
  }),
  [OWNED_PROCESS_STATE.RELEASED]: Object.freeze({}),
} as const);

const PROCESS_IDENTITY_BINDING_FIELDS = Object.freeze([
  field.SUPERVISOR_PID,
  field.SUPERVISOR_IDENTITY,
  field.CLI_PID,
  field.CLI_IDENTITY,
] as const);

const GENESIS_NULL_FIELDS = Object.freeze([
  ...PROCESS_IDENTITY_BINDING_FIELDS,
  field.TERMINAL_KIND,
  field.RELEASE_REASON,
  field.EXIT_CODE,
  field.PRIOR_RECORD_DIGEST,
] as const);

function invalidWriteTransition(detail: string): never {
  throw new Error(`${OWNED_PROCESS_AUTHORITY_ERROR.WRITE_TRANSITION}: ${detail}`);
}

function recordsEqual(
  current: OwnedAttemptProcessRecordV1,
  next: OwnedAttemptProcessRecordV1,
): boolean {
  return canonicalJsonBytes(current).equals(canonicalJsonBytes(next));
}

function assertGenesis(next: OwnedAttemptProcessRecordV1): void {
  if (
    next[field.STATE] !== OWNED_PROCESS_STATE.RESERVED ||
    next[field.PROCESS_QUIESCENT] !== false ||
    next[field.UPDATED_AT] !== next[field.RECORDED_AT] ||
    GENESIS_NULL_FIELDS.some((name) => next[name] !== null)
  ) {
    invalidWriteTransition("non-canonical genesis");
  }
}

function assertBindingsAreMonotonic(
  current: OwnedAttemptProcessRecordV1,
  next: OwnedAttemptProcessRecordV1,
): void {
  for (const name of PROCESS_IDENTITY_BINDING_FIELDS) {
    if (current[name] !== null && next[name] !== current[name]) {
      invalidWriteTransition(`process identity binding changed at ${name}`);
    }
  }
  if (
    (next[field.SUPERVISOR_IDENTITY] !== null && next[field.SUPERVISOR_PID] === null) ||
    (next[field.CLI_IDENTITY] !== null && next[field.CLI_PID] === null)
  ) {
    invalidWriteTransition("process identity lacks its PID binding");
  }
}

function assertTerminalIsMonotonic(
  current: OwnedAttemptProcessRecordV1,
  next: OwnedAttemptProcessRecordV1,
): void {
  if (
    current[field.TERMINAL_KIND] !== null &&
    next[field.TERMINAL_KIND] !== current[field.TERMINAL_KIND]
  ) {
    invalidWriteTransition("terminal observation changed");
  }
}

function assertSameStateMutationIsCanonical(
  current: OwnedAttemptProcessRecordV1,
  next: OwnedAttemptProcessRecordV1,
): void {
  if (current[field.STATE] === OWNED_PROCESS_STATE.RESERVED) {
    if (
      current[field.SUPERVISOR_PID] !== null ||
      current[field.SUPERVISOR_IDENTITY] !== null ||
      next[field.SUPERVISOR_PID] === null ||
      next[field.SUPERVISOR_IDENTITY] === null
    ) {
      invalidWriteTransition("reserved mutation is not a supervisor bind");
    }
    return;
  }
  if (
    current[field.STATE] === OWNED_PROCESS_STATE.RUNNING &&
    (current[field.TERMINAL_KIND] !== null || next[field.TERMINAL_KIND] === null)
  ) {
    invalidWriteTransition("running mutation is not a terminal observation");
  }
}

/** Enforces genesis, state-edge, identity, lineage, and terminal immutability at persistence. */
export function assertOwnedProcessWriteTransition(
  current: OwnedAttemptProcessRecordV1 | null,
  next: OwnedAttemptProcessRecordV1,
): void {
  if (current === null) {
    assertGenesis(next);
    return;
  }
  if (recordsEqual(current, next)) return;
  const currentState = current[field.STATE];
  const nextState = next[field.STATE];
  const allowedFields = (
    OWNED_PROCESS_WRITE_TRANSITION_FIELDS[currentState] as Partial<
      Record<OwnedProcessState, readonly OwnedProcessRecordField[]>
    >
  )[nextState];
  if (!allowedFields) invalidWriteTransition(`${currentState} -> ${nextState}`);
  const allowed = new Set<OwnedProcessRecordField>(allowedFields);
  for (const name of OWNED_PROCESS_RECORD_FIELDS) {
    if (!Object.is(current[name], next[name]) && !allowed.has(name)) {
      invalidWriteTransition(`field ${name} changed during ${currentState} -> ${nextState}`);
    }
  }
  assertBindingsAreMonotonic(current, next);
  assertTerminalIsMonotonic(current, next);
  if (currentState === nextState) assertSameStateMutationIsCanonical(current, next);
  if (Date.parse(next[field.UPDATED_AT]) < Date.parse(current[field.UPDATED_AT])) {
    invalidWriteTransition("updated_at moved backwards");
  }
  if (nextState === OWNED_PROCESS_STATE.RELEASED && currentState !== OWNED_PROCESS_STATE.RELEASED) {
    if (next[field.PRIOR_RECORD_DIGEST] !== current[field.RECORD_DIGEST]) {
      invalidWriteTransition("released record does not bind the prior record digest");
    }
  }
}
