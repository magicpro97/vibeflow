import { digestV1 } from "../../durability/index.js";
import {
  hasExactLineageKeys,
  isBoundedLineageReference,
  isLineageDigest,
  isMillisecondIsoDate,
  isPlainLineageRecord,
} from "./lineage-types.js";

export type ParticipantStartStateV1 =
  | "prepared"
  | "effect_in_progress"
  | "observed"
  | "accepted"
  | "cancel_in_progress"
  | "canceled"
  | "failed"
  | "uncertain";

export interface ParticipantStartReceiptV1 {
  schema_version: "1.0";
  operation_id: string;
  participant_id: string;
  start_generation: number;
  attempt_key: string;
  state: ParticipantStartStateV1;
  engine: "claude" | "codex" | "copilot" | "opencode" | "antigravity";
  model: string | null;
  adapter_fingerprint: string;
  reconciliation_mode: "provider-idempotency" | "inspect-start" | "vf-process-lease";
  cancel_attempt_key: string | null;
  cancellation_mode: "idempotent-cancel" | "inspect-cancel" | "vf-process-lease" | null;
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

const EDGES = new Set([
  "prepared\0effect_in_progress",
  "effect_in_progress\0observed",
  "effect_in_progress\0failed",
  "effect_in_progress\0uncertain",
  "observed\0accepted",
  "observed\0cancel_in_progress",
  "accepted\0cancel_in_progress",
  "cancel_in_progress\0canceled",
  "cancel_in_progress\0uncertain",
]);

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
    !hasExactLineageKeys(value, [
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
    ]) ||
    value.schema_version !== "1.0" ||
    !/^vf-operation-[0-9a-f]{64}$/.test(value.operation_id as string) ||
    !isBoundedLineageReference(value.participant_id) ||
    !Number.isSafeInteger(value.start_generation) ||
    (value.start_generation as number) < 0 ||
    !["claude", "codex", "copilot", "opencode", "antigravity"].includes(value.engine as string) ||
    (value.model !== null && !isBoundedLineageReference(value.model)) ||
    !isBoundedLineageReference(value.adapter_fingerprint) ||
    !["provider-idempotency", "inspect-start", "vf-process-lease"].includes(
      value.reconciliation_mode as string,
    ) ||
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
    ![
      "prepared",
      "effect_in_progress",
      "observed",
      "accepted",
      "cancel_in_progress",
      "canceled",
      "failed",
      "uncertain",
    ].includes(receipt.state)
  )
    throw new Error("invalid participant start receipt identity");
  const hasCancel = receipt.cancel_attempt_key !== null || receipt.cancellation_mode !== null;
  if (
    (hasCancel !== ["cancel_in_progress", "canceled"].includes(receipt.state) &&
      receipt.state !== "uncertain") ||
    (receipt.cancel_attempt_key !== null &&
      receipt.cancel_attempt_key !== participantCancelAttemptKey(receipt)) ||
    (receipt.cancellation_mode !== null &&
      !["idempotent-cancel", "inspect-cancel", "vf-process-lease"].includes(
        receipt.cancellation_mode,
      ))
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
  const observed = !["prepared", "effect_in_progress", "failed"].includes(receipt.state);
  if (observed !== (receipt.observed_at !== null))
    throw new Error("invalid participant observation timestamp");
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

export function advanceParticipantReceipt(
  prior: ParticipantStartReceiptV1 | undefined,
  next: ParticipantStartReceiptV1,
): void {
  assertParticipantStartReceiptV1(next);
  if (!prior) {
    if (next.start_generation !== 0 || next.state !== "prepared")
      throw new Error("participant start receipt does not begin at prepared generation zero");
    return;
  }
  if (JSON.stringify(staticFields(prior)) !== JSON.stringify(staticFields(next)))
    throw new Error("participant start receipt immutable binding changed");
  if (next.start_generation === prior.start_generation) {
    if (
      !EDGES.has(`${prior.state}\0${next.state}`) ||
      next.attempt_key !== prior.attempt_key ||
      next.prepared_at !== prior.prepared_at
    )
      throw new Error("illegal participant start receipt transition");
    return;
  }
  if (
    next.start_generation !== prior.start_generation + 1 ||
    !["failed", "canceled"].includes(prior.state) ||
    next.state !== "prepared"
  )
    throw new Error("illegal participant start receipt generation");
}
