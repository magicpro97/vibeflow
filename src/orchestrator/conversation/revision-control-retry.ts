import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type {
  RevisionOperationV1,
  RevisionPreparationPlanV1,
} from "./lineage-revision-operation.js";
import type { RevisionLaneRetryResultV1 } from "./revision-lane-retry-runtime.js";
import {
  type ParticipantStartReceiptV1,
  materializeParticipantStartReceipt,
  participantStartAttemptKey,
} from "./revision-participant-receipt.js";
import { type RevisionOperationEventV1, materializeRevisionEvent } from "./revision-planner.js";

function later(left: string, right: string): string {
  return left < right ? right : left;
}

function latestReceipts(events: readonly RevisionOperationEventV1[]) {
  const latest = new Map<string, ParticipantStartReceiptV1>();
  for (const event of events)
    if (event.payload.kind === "participant-start")
      latest.set(event.payload.receipt.participant_id, event.payload.receipt);
  return latest;
}

function receiptHistories(events: readonly RevisionOperationEventV1[]) {
  const histories = new Map<string, ParticipantStartReceiptV1[]>();
  for (const event of events) {
    if (event.payload.kind !== "participant-start") continue;
    const receipt = event.payload.receipt;
    histories.set(receipt.participant_id, [
      ...(histories.get(receipt.participant_id) ?? []),
      receipt,
    ]);
  }
  return histories;
}

function appendReceipt(input: {
  home: ConversationHomeAuthorities;
  operation: RevisionOperationV1;
  events: RevisionOperationEventV1[];
  actionOperationId: string;
  receipt: ParticipantStartReceiptV1;
  at: string;
}): RevisionOperationEventV1[] {
  const event = materializeRevisionEvent(
    input.operation,
    input.events,
    {
      kind: "participant-start",
      authorized_by_action_operation_id: input.actionOperationId,
      effect_action_operation_id: input.actionOperationId,
      receipt: input.receipt,
    },
    input.at,
  );
  input.home.revisions.appendEvent(input.operation, event);
  return [...input.events, event];
}

function receiptFor(input: {
  operation: RevisionOperationV1;
  participant: RevisionPreparationPlanV1["participant_starts"][number];
  generation: number;
  state: ParticipantStartReceiptV1["state"];
  preparedAt: string;
  observedAt: string | null;
  evidence?: { ref: string | null; digest: string | null };
}): ParticipantStartReceiptV1 {
  const attempt = participantStartAttemptKey({
    operation_id: input.operation.operation_id,
    participant_id: input.participant.participant_id,
    start_generation: input.generation,
  });
  const processEvidence = input.participant.reconciliation_mode === "vf-process-lease";
  return materializeParticipantStartReceipt({
    operation_id: input.operation.operation_id,
    participant_id: input.participant.participant_id,
    start_generation: input.generation,
    attempt_key: attempt,
    state: input.state,
    engine: input.participant.engine,
    model: input.participant.model,
    adapter_fingerprint: input.participant.adapter_fingerprint,
    reconciliation_mode: input.participant.reconciliation_mode,
    cancel_attempt_key: null,
    cancellation_mode: null,
    shared_prompt_digest: input.operation.prompt_projection_digest,
    wrapper_digest: input.participant.wrapper_descriptor_digest,
    private_native_session_ref: processEvidence ? null : (input.evidence?.ref ?? null),
    private_native_session_producer_receipt_digest: processEvidence
      ? null
      : (input.evidence?.digest ?? null),
    private_process_lease_ref: processEvidence ? (input.evidence?.ref ?? null) : null,
    private_process_lease_producer_receipt_digest: processEvidence
      ? (input.evidence?.digest ?? null)
      : null,
    prepared_at: input.preparedAt,
    observed_at: input.observedAt,
  });
}

export async function executeRevisionRetry(input: {
  home: ConversationHomeAuthorities;
  operation: RevisionOperationV1;
  plan: RevisionPreparationPlanV1;
  events: RevisionOperationEventV1[];
  actionOperationId: string;
  now(): string;
  retry(runtimeInput: {
    operation: RevisionOperationV1;
    plan: RevisionPreparationPlanV1;
    generations: ReadonlyMap<string, number>;
    attempt_keys: ReadonlyMap<string, string>;
    prior_receipts: ReadonlyMap<string, readonly ParticipantStartReceiptV1[]>;
    now(): string;
  }): Promise<RevisionLaneRetryResultV1[]>;
}): Promise<RevisionOperationEventV1[]> {
  let events = input.events;
  const prior = latestReceipts(events);
  const priorReceipts = receiptHistories(events);
  if (
    prior.size !== input.plan.participant_starts.length ||
    input.plan.participant_starts.some(({ participant_id }) => {
      const receipt = prior.get(participant_id);
      return !receipt || !["failed", "canceled"].includes(receipt.state);
    })
  )
    throw new Error("revision retry requires an exact failed and quiescent prior lane set");
  const generations = new Map<string, number>();
  const attemptKeys = new Map<string, string>();
  const preparedAt = later(input.now(), events.at(-1)?.recorded_at ?? input.operation.created_at);
  for (const participant of input.plan.participant_starts) {
    const generation = (prior.get(participant.participant_id)?.start_generation ?? -1) + 1;
    generations.set(participant.participant_id, generation);
    const prepared = receiptFor({
      operation: input.operation,
      participant,
      generation,
      state: "prepared",
      preparedAt,
      observedAt: null,
    });
    attemptKeys.set(participant.participant_id, prepared.attempt_key);
    events = appendReceipt({ ...input, events, receipt: prepared, at: preparedAt });
    const effect = receiptFor({
      operation: input.operation,
      participant,
      generation,
      state: "effect_in_progress",
      preparedAt,
      observedAt: null,
    });
    events = appendReceipt({ ...input, events, receipt: effect, at: preparedAt });
  }
  let results: RevisionLaneRetryResultV1[];
  try {
    results = await input.retry({
      operation: input.operation,
      plan: input.plan,
      generations,
      attempt_keys: attemptKeys,
      prior_receipts: priorReceipts,
      now: input.now,
    });
  } catch {
    results = input.plan.participant_starts.map((participant) => ({
      participant_id: participant.participant_id,
      start_generation: generations.get(participant.participant_id) as number,
      attempt_key: attemptKeys.get(participant.participant_id) as string,
      outcome: "uncertain",
      private_evidence_ref: null,
      private_evidence_digest: null,
      observed_at: input.now(),
    }));
  }
  const byParticipant = new Map(results.map((result) => [result.participant_id, result]));
  for (const participant of input.plan.participant_starts) {
    const result = byParticipant.get(participant.participant_id);
    const generation = generations.get(participant.participant_id) as number;
    if (
      !result ||
      result.start_generation !== generation ||
      result.attempt_key !== attemptKeys.get(participant.participant_id)
    )
      throw new Error("revision retry runtime returned an incomplete lane set");
    const evidence = {
      ref: result.private_evidence_ref,
      digest: result.private_evidence_digest,
    };
    if (result.outcome === "accepted") {
      const observed = receiptFor({
        operation: input.operation,
        participant,
        generation,
        state: "observed",
        preparedAt,
        observedAt: result.observed_at,
        evidence,
      });
      events = appendReceipt({ ...input, events, receipt: observed, at: result.observed_at });
      const accepted = receiptFor({
        operation: input.operation,
        participant,
        generation,
        state: "accepted",
        preparedAt,
        observedAt: result.observed_at,
        evidence,
      });
      events = appendReceipt({ ...input, events, receipt: accepted, at: result.observed_at });
    } else {
      const terminal = receiptFor({
        operation: input.operation,
        participant,
        generation,
        state: result.outcome,
        preparedAt,
        observedAt: result.outcome === "uncertain" ? result.observed_at : null,
        evidence,
      });
      events = appendReceipt({ ...input, events, receipt: terminal, at: result.observed_at });
    }
  }
  const lanes = latestReceipts(events);
  const accepted = [...lanes.values()].every(({ state }) => state === "accepted");
  const failed =
    [...lanes.values()].some(({ state }) => state === "failed") &&
    [...lanes.values()].every(({ state }) => state === "failed" || state === "canceled");
  const destination = accepted ? "started" : failed ? "start_failed" : "needs_recovery";
  const outcome = accepted ? "succeeded" : failed ? "failed" : "needs_recovery";
  const reason = accepted ? null : failed ? "retry_start_failed" : "retry_start_uncertain";
  const terminal = materializeRevisionEvent(
    input.operation,
    events,
    {
      kind: "state-transition",
      from: "starting",
      to: destination,
      authorized_by_action_operation_id: input.actionOperationId,
      effect_action_operation_id: input.actionOperationId,
      action_terminals: [
        {
          action_operation_id: input.actionOperationId,
          outcome,
          reason_code: reason,
        },
      ],
      reason_code: reason,
    },
    later(input.now(), events.at(-1)?.recorded_at ?? preparedAt),
  );
  input.home.revisions.appendEvent(input.operation, terminal);
  return [...events, terminal];
}
