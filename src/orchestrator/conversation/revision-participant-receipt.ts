import { PUBLIC_OPERATION_PARTICIPANT_START_PHASE } from "../../actions/protocol-contract.js";
import { type Engine, isAgentEngine } from "../../core/agent-contract.js";
import { digestV1 } from "../../durability/index.js";
import {
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

export type ParticipantStartStateV1 =
  (typeof PUBLIC_OPERATION_PARTICIPANT_START_PHASE)[keyof typeof PUBLIC_OPERATION_PARTICIPANT_START_PHASE];

export const PARTICIPANT_START_RECONCILIATION_MODE = Object.freeze({
  PROVIDER_IDEMPOTENCY: "provider-idempotency",
  INSPECT_START: "inspect-start",
  VF_PROCESS_LEASE: "vf-process-lease",
} as const);

export type ParticipantStartReconciliationModeV1 =
  (typeof PARTICIPANT_START_RECONCILIATION_MODE)[keyof typeof PARTICIPANT_START_RECONCILIATION_MODE];

export const PARTICIPANT_START_RECONCILIATION_MODES = Object.freeze(
  Object.values(PARTICIPANT_START_RECONCILIATION_MODE),
);

export const PARTICIPANT_START_EVIDENCE_CHANNEL = Object.freeze({
  NATIVE_SESSION: "native-session",
  PROCESS_LEASE: "process-lease",
} as const);

export const PARTICIPANT_START_EVIDENCE_CHANNEL_BY_MODE = Object.freeze({
  [PARTICIPANT_START_RECONCILIATION_MODE.PROVIDER_IDEMPOTENCY]:
    PARTICIPANT_START_EVIDENCE_CHANNEL.NATIVE_SESSION,
  [PARTICIPANT_START_RECONCILIATION_MODE.INSPECT_START]:
    PARTICIPANT_START_EVIDENCE_CHANNEL.NATIVE_SESSION,
  [PARTICIPANT_START_RECONCILIATION_MODE.VF_PROCESS_LEASE]:
    PARTICIPANT_START_EVIDENCE_CHANNEL.PROCESS_LEASE,
} satisfies Readonly<
  Record<
    ParticipantStartReconciliationModeV1,
    (typeof PARTICIPANT_START_EVIDENCE_CHANNEL)[keyof typeof PARTICIPANT_START_EVIDENCE_CHANNEL]
  >
>);

export const PARTICIPANT_CANCEL_MODE = Object.freeze({
  IDEMPOTENT_CANCEL: "idempotent-cancel",
  INSPECT_CANCEL: "inspect-cancel",
  VF_PROCESS_LEASE: PARTICIPANT_START_RECONCILIATION_MODE.VF_PROCESS_LEASE,
} as const);

export type ParticipantCancelModeV1 =
  (typeof PARTICIPANT_CANCEL_MODE)[keyof typeof PARTICIPANT_CANCEL_MODE];

export const PARTICIPANT_CANCEL_MODES = Object.freeze(Object.values(PARTICIPANT_CANCEL_MODE));

export interface ParticipantStartReceiptV1 {
  schema_version: "1.0";
  operation_id: string;
  participant_id: string;
  start_generation: number;
  attempt_key: string;
  state: ParticipantStartStateV1;
  engine: Engine;
  model: string | null;
  adapter_fingerprint: string;
  reconciliation_mode: ParticipantStartReconciliationModeV1;
  cancel_attempt_key: string | null;
  cancellation_mode: ParticipantCancelModeV1 | null;
  shared_prompt_digest: string;
  wrapper_digest: string;
  private_native_session_ref: string | null;
  private_native_session_producer_receipt_digest: string | null;
  private_process_lease_ref: string | null;
  private_process_lease_producer_receipt_digest: string | null;
  prepared_at: string;
  observed_at: string | null;
  receipt_digest: string;
}

export const PARTICIPANT_START_RECEIPT_FIELDS = Object.freeze([
  "adapter_fingerprint",
  "attempt_key",
  "cancel_attempt_key",
  "cancellation_mode",
  "engine",
  "model",
  "observed_at",
  "operation_id",
  "participant_id",
  "prepared_at",
  "private_native_session_producer_receipt_digest",
  "private_native_session_ref",
  "private_process_lease_producer_receipt_digest",
  "private_process_lease_ref",
  "receipt_digest",
  "reconciliation_mode",
  "schema_version",
  "shared_prompt_digest",
  "start_generation",
  "state",
  "wrapper_digest",
] as const satisfies readonly (keyof ParticipantStartReceiptV1)[]);

type SameKeys<Shape, Fields extends readonly PropertyKey[]> = Exclude<
  keyof Shape,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof Shape> extends never
    ? true
    : false
  : false;

export const PARTICIPANT_START_RECEIPT_FIELD_CONTRACT_EXACT: SameKeys<
  ParticipantStartReceiptV1,
  typeof PARTICIPANT_START_RECEIPT_FIELDS
> = true;

const PARTICIPANT_START_TRANSITION_TARGETS = Object.freeze({
  [PUBLIC_OPERATION_PARTICIPANT_START_PHASE.PREPARED]: Object.freeze([
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.EFFECT_IN_PROGRESS,
  ] as const),
  [PUBLIC_OPERATION_PARTICIPANT_START_PHASE.EFFECT_IN_PROGRESS]: Object.freeze([
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.OBSERVED,
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED,
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN,
  ] as const),
  [PUBLIC_OPERATION_PARTICIPANT_START_PHASE.OBSERVED]: Object.freeze([
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED,
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCEL_IN_PROGRESS,
  ] as const),
  [PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED]: Object.freeze([
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCEL_IN_PROGRESS,
  ] as const),
  [PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCEL_IN_PROGRESS]: Object.freeze([
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCELED,
    PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN,
  ] as const),
  [PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCELED]: Object.freeze([] as const),
  [PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED]: Object.freeze([] as const),
  [PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN]: Object.freeze([] as const),
} satisfies Readonly<Record<ParticipantStartStateV1, readonly ParticipantStartStateV1[]>>);

const PARTICIPANT_CANCEL_OWNED_STATES = Object.freeze([
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCEL_IN_PROGRESS,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCELED,
] as const);

const PARTICIPANT_OBSERVED_STATES = Object.freeze([
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.OBSERVED,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCEL_IN_PROGRESS,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCELED,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN,
] as const);

const PARTICIPANT_PROVED_STATES = Object.freeze([
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.OBSERVED,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.ACCEPTED,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCEL_IN_PROGRESS,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCELED,
] as const);

const PARTICIPANT_RETRYABLE_TERMINAL_STATES = Object.freeze([
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.FAILED,
  PUBLIC_OPERATION_PARTICIPANT_START_PHASE.CANCELED,
] as const);

const memberOf = <Value extends string>(values: readonly Value[], value: unknown): value is Value =>
  typeof value === "string" && values.some((candidate) => candidate === value);

export const isParticipantStartReconciliationModeV1 = (
  value: unknown,
): value is ParticipantStartReconciliationModeV1 =>
  memberOf(PARTICIPANT_START_RECONCILIATION_MODES, value);

export const isParticipantCancelModeV1 = (value: unknown): value is ParticipantCancelModeV1 =>
  memberOf(PARTICIPANT_CANCEL_MODES, value);

export const participantStartUsesProcessLease = (
  mode: ParticipantStartReconciliationModeV1,
): boolean =>
  PARTICIPANT_START_EVIDENCE_CHANNEL_BY_MODE[mode] ===
  PARTICIPANT_START_EVIDENCE_CHANNEL.PROCESS_LEASE;

export function participantStartAttemptKey(
  receipt: Pick<ParticipantStartReceiptV1, "operation_id" | "participant_id" | "start_generation">,
) {
  return `vf-start-${digestV1("VF-PARTICIPANT-START-ATTEMPT\0v1\0", {
    schema_version: "1.0",
    operation_id: receipt.operation_id,
    participant_id: receipt.participant_id,
    start_generation: receipt.start_generation,
  }).slice(7)}`;
}

export function participantCancelAttemptKey(
  receipt: Pick<
    ParticipantStartReceiptV1,
    "operation_id" | "participant_id" | "start_generation" | "attempt_key"
  >,
): string {
  return `vf-cancel-${digestV1("VF-PARTICIPANT-CANCEL-ATTEMPT\0v1\0", {
    schema_version: "1.0",
    operation_id: receipt.operation_id,
    participant_id: receipt.participant_id,
    start_generation: receipt.start_generation,
    attempt_key: receipt.attempt_key,
  }).slice(7)}`;
}

function staticFields(receipt: ParticipantStartReceiptV1) {
  return {
    operation_id: receipt.operation_id,
    participant_id: receipt.participant_id,
    engine: receipt.engine,
    model: receipt.model,
    adapter_fingerprint: receipt.adapter_fingerprint,
    reconciliation_mode: receipt.reconciliation_mode,
    shared_prompt_digest: receipt.shared_prompt_digest,
    wrapper_digest: receipt.wrapper_digest,
  };
}

export function assertParticipantStartReceiptV1(
  value: unknown,
): asserts value is ParticipantStartReceiptV1 {
  if (
    !isPlainLineageRecord(value) ||
    !hasExactLineageKeys(value, PARTICIPANT_START_RECEIPT_FIELDS) ||
    value.schema_version !== "1.0" ||
    !/^vf-operation-[0-9a-f]{64}$/.test(value.operation_id as string) ||
    !isBoundedLineageReference(value.participant_id) ||
    !Number.isSafeInteger(value.start_generation) ||
    (value.start_generation as number) < 0 ||
    !isAgentEngine(value.engine) ||
    (value.model !== null && !isBoundedLineageReference(value.model)) ||
    !isBoundedLineageReference(value.adapter_fingerprint) ||
    !isParticipantStartReconciliationModeV1(value.reconciliation_mode) ||
    !isMillisecondIsoDate(value.prepared_at) ||
    (value.observed_at !== null && !isMillisecondIsoDate(value.observed_at))
  )
    throw new Error("invalid participant start receipt");
  const receipt = value as unknown as ParticipantStartReceiptV1;
  if (
    receipt.attempt_key !== participantStartAttemptKey(receipt) ||
    !isLineageDigest(receipt.shared_prompt_digest) ||
    !isLineageDigest(receipt.wrapper_digest) ||
    !isLineageDigest(receipt.receipt_digest) ||
    !memberOf(Object.values(PUBLIC_OPERATION_PARTICIPANT_START_PHASE), receipt.state)
  )
    throw new Error("invalid participant start receipt identity");
  const hasCancel = receipt.cancel_attempt_key !== null && receipt.cancellation_mode !== null;
  if (
    (receipt.cancel_attempt_key === null) !== (receipt.cancellation_mode === null) ||
    (hasCancel !== memberOf(PARTICIPANT_CANCEL_OWNED_STATES, receipt.state) &&
      receipt.state !== PUBLIC_OPERATION_PARTICIPANT_START_PHASE.UNCERTAIN) ||
    (receipt.cancel_attempt_key !== null &&
      receipt.cancel_attempt_key !== participantCancelAttemptKey(receipt)) ||
    (receipt.cancellation_mode !== null && !isParticipantCancelModeV1(receipt.cancellation_mode))
  )
    throw new Error("invalid participant cancellation receipt");
  for (const [ref, producer] of [
    [receipt.private_native_session_ref, receipt.private_native_session_producer_receipt_digest],
    [receipt.private_process_lease_ref, receipt.private_process_lease_producer_receipt_digest],
  ] as const)
    if (
      (ref === null) !== (producer === null) ||
      (ref !== null && (!isLineageDigest(ref) || !isLineageDigest(producer)))
    )
      throw new Error("invalid participant private effect reference");
  const observed = memberOf(PARTICIPANT_OBSERVED_STATES, receipt.state);
  if (observed !== (receipt.observed_at !== null))
    throw new Error("invalid participant observation timestamp");
  const nativeEvidence = receipt.private_native_session_ref !== null;
  const processEvidence = receipt.private_process_lease_ref !== null;
  const requiresEvidence = memberOf(PARTICIPANT_PROVED_STATES, receipt.state);
  const expectsProcessEvidence = participantStartUsesProcessLease(receipt.reconciliation_mode);
  if (
    (!observed && (nativeEvidence || processEvidence)) ||
    (expectsProcessEvidence && (nativeEvidence || (requiresEvidence && !processEvidence))) ||
    (!expectsProcessEvidence && (processEvidence || (requiresEvidence && !nativeEvidence)))
  )
    throw new Error("participant private effect evidence does not match reconciliation mode");
  const { receipt_digest: _digest, ...preimage } = receipt;
  if (digestV1("VF-PARTICIPANT-START-RECEIPT\0v1\0", preimage) !== receipt.receipt_digest)
    throw new Error("invalid participant start receipt digest");
}

export function materializeParticipantStartReceipt(
  input: Omit<ParticipantStartReceiptV1, "schema_version" | "receipt_digest">,
): ParticipantStartReceiptV1 {
  const preimage = { schema_version: "1.0" as const, ...structuredClone(input) };
  const receipt = {
    ...preimage,
    receipt_digest: digestV1("VF-PARTICIPANT-START-RECEIPT\0v1\0", preimage),
  };
  assertParticipantStartReceiptV1(receipt);
  return receipt;
}

export function participantStartReceiptEvidence(
  receipt: ParticipantStartReceiptV1,
): { ref: string; digest: string } | null {
  const processEvidence = participantStartUsesProcessLease(receipt.reconciliation_mode);
  const ref = processEvidence
    ? receipt.private_process_lease_ref
    : receipt.private_native_session_ref;
  const digest = processEvidence
    ? receipt.private_process_lease_producer_receipt_digest
    : receipt.private_native_session_producer_receipt_digest;
  return ref && digest ? { ref, digest } : null;
}

function assertParticipantReceiptStickyBindings(
  prior: ParticipantStartReceiptV1,
  next: ParticipantStartReceiptV1,
): void {
  for (const field of [
    "private_native_session_ref",
    "private_native_session_producer_receipt_digest",
    "private_process_lease_ref",
    "private_process_lease_producer_receipt_digest",
    "observed_at",
    "cancel_attempt_key",
    "cancellation_mode",
  ] as const)
    if (prior[field] !== null && prior[field] !== next[field])
      throw new Error("participant start receipt immutable evidence binding changed");
}

export function advanceParticipantReceipt(
  prior: ParticipantStartReceiptV1 | undefined,
  next: ParticipantStartReceiptV1,
): void {
  assertParticipantStartReceiptV1(next);
  if (!prior) {
    if (
      next.start_generation !== 0 ||
      next.state !== PUBLIC_OPERATION_PARTICIPANT_START_PHASE.PREPARED
    )
      throw new Error("participant start receipt does not begin at prepared generation zero");
    return;
  }
  if (JSON.stringify(staticFields(prior)) !== JSON.stringify(staticFields(next)))
    throw new Error("participant start receipt immutable binding changed");
  if (next.start_generation === prior.start_generation) {
    assertParticipantReceiptStickyBindings(prior, next);
    if (
      !PARTICIPANT_START_TRANSITION_TARGETS[prior.state].some(
        (candidate) => candidate === next.state,
      ) ||
      next.attempt_key !== prior.attempt_key ||
      next.prepared_at !== prior.prepared_at
    )
      throw new Error("illegal participant start receipt transition");
    return;
  }
  if (
    next.start_generation !== prior.start_generation + 1 ||
    !memberOf(PARTICIPANT_RETRYABLE_TERMINAL_STATES, prior.state) ||
    next.state !== PUBLIC_OPERATION_PARTICIPANT_START_PHASE.PREPARED
  )
    throw new Error("illegal participant start receipt generation");
}
