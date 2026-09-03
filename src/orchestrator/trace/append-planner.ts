import { randomUUID } from "node:crypto";
import type {
  InternalTraceStoreRecord,
  StoredTraceEvent,
  TraceAppendInput,
  TraceCorrelation,
} from "./types.js";
import { fail, validGenerated } from "./validation.js";

export class TraceIdempotencyConflictError extends Error {}
export class TraceRequestedEventConflictError extends Error {}

export interface CapturedTraceAppendV1 {
  correlation: TraceCorrelation;
  input: TraceAppendInput;
  native: string | null;
  bytes: string;
}

export const traceInputBytes = (input: TraceAppendInput): string =>
  JSON.stringify({ idempotency_key: input.idempotency_key, event: input.event });

const correlationBytes = (correlation: TraceCorrelation, native: string | null): string =>
  JSON.stringify({
    workflow_id: correlation.workflow_id,
    conversation_id: correlation.conversation_id,
    revision_id: correlation.revision_id,
    run_id: correlation.run_id,
    turn_id: correlation.turn_id,
    operation_id: correlation.operation_id,
    attempt_id: correlation.attempt_id,
    unit_id: correlation.unit_id,
    participant_id: correlation.participant_id,
    role_ref: correlation.role_ref,
    role_resolved_hash: correlation.role_resolved_hash,
    skill_refs: correlation.skill_refs,
    skill_resolved_hashes: correlation.skill_resolved_hashes,
    engine: correlation.engine,
    evidence_refs: correlation.evidence_refs,
    parent_attempt_id: correlation.parent_attempt_id,
    native_session_id: native,
  });

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function planTraceAppend(input: {
  captured: readonly CapturedTraceAppendV1[];
  durable: readonly InternalTraceStoreRecord[];
  idempotency: ReadonlyMap<string, InternalTraceStoreRecord>;
  requestedEventIds?: readonly string[];
  eventId?: () => string;
  now?: () => string;
}): { output: StoredTraceEvent[]; records: InternalTraceStoreRecord[] } {
  const pending = new Map<string, InternalTraceStoreRecord>();
  const generatedIds = new Set<string>();
  const output: StoredTraceEvent[] = [];
  for (const [index, item] of input.captured.entries()) {
    const requestedEventId = input.requestedEventIds?.[index];
    const old =
      input.idempotency.get(item.input.idempotency_key) ?? pending.get(item.input.idempotency_key);
    if (old) {
      if (
        traceInputBytes({
          idempotency_key: old.stored_event.idempotency_key,
          event: old.stored_event.event,
        }) !== item.bytes
      )
        throw new TraceIdempotencyConflictError("idempotency key conflict");
      if (
        requestedEventId &&
        (old.stored_event.event_id !== requestedEventId ||
          correlationBytes(item.correlation, item.native) !==
            correlationBytes(old.stored_event, old.native_session_id))
      )
        throw new TraceRequestedEventConflictError("requested event authority changed on replay");
      output.push(clone(old.stored_event));
      continue;
    }
    const eventId = requestedEventId ?? input.eventId?.() ?? randomUUID();
    const ts = input.now?.() ?? new Date().toISOString();
    if (!validGenerated(eventId, ts)) fail("invalid generated value");
    const priorEvent = input.durable.find((record) => record.stored_event.event_id === eventId);
    if (priorEvent || generatedIds.has(eventId)) {
      if (!requestedEventId) fail("invalid generated value");
      if (
        !priorEvent ||
        traceInputBytes({
          idempotency_key: priorEvent.stored_event.idempotency_key,
          event: priorEvent.stored_event.event,
        }) !== item.bytes ||
        correlationBytes(item.correlation, item.native) !==
          correlationBytes(priorEvent.stored_event, priorEvent.native_session_id)
      )
        throw new TraceRequestedEventConflictError("requested event id collision");
      output.push(clone(priorEvent.stored_event));
      continue;
    }
    generatedIds.add(eventId);
    const storedEvent = {
      ...item.correlation,
      event_id: eventId,
      seq: input.durable.length + pending.size + 1,
      ts,
      idempotency_key: item.input.idempotency_key,
      event: item.input.event,
    };
    const record = { stored_event: storedEvent, native_session_id: item.native };
    pending.set(item.input.idempotency_key, record);
    output.push(storedEvent);
  }
  return { output, records: [...pending.values()] };
}
