import type { StoredTraceEvent } from "./types.js";

export interface FoldedParticipantResponse {
  round_id: string;
  participant_id: string;
  content: string;
  final_claim: string | null;
  final_evidence: string[];
  completion_seq: number;
}

export interface FoldedTrace {
  responses: FoldedParticipantResponse[];
}

export class TraceFoldError extends Error {}

type DeltaPayload = {
  round_id: string;
  participant_id: string;
  content_delta: string;
  final_claim: string | null;
  final_evidence: string[];
  completes_response: boolean;
};

type Group = FoldedParticipantResponse & { done: boolean };

const deltaFields = [
  "round_id",
  "participant_id",
  "content_delta",
  "final_claim",
  "final_evidence",
  "completes_response",
];

function isDenseStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;

  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;

  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") return false;
  }
  return true;
}

function validateDeltaPayload(payload: unknown): DeltaPayload {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Reflect.ownKeys(payload).length !== deltaFields.length ||
    !Reflect.ownKeys(payload).every((key) => typeof key === "string" && deltaFields.includes(key))
  ) {
    throw new TraceFoldError("invalid delta payload");
  }

  const delta = payload as Record<string, unknown>;
  if (
    typeof delta.round_id !== "string" ||
    typeof delta.participant_id !== "string" ||
    typeof delta.content_delta !== "string" ||
    (delta.final_claim !== null && typeof delta.final_claim !== "string") ||
    !isDenseStringArray(delta.final_evidence) ||
    typeof delta.completes_response !== "boolean"
  ) {
    throw new TraceFoldError("invalid delta payload");
  }

  return delta as DeltaPayload;
}

export function foldTrace(records: readonly StoredTraceEvent[]): FoldedTrace {
  const sequences = new Set<number>();
  for (const record of records) {
    if (!Number.isSafeInteger(record.seq) || record.seq < 1 || sequences.has(record.seq)) {
      throw new TraceFoldError("invalid sequence");
    }
    sequences.add(record.seq);
  }

  const groupsByRound = new Map<string, Map<string, Group>>();
  const groupsInFirstSeenOrder: Group[] = [];

  for (const record of [...records].sort((left, right) => left.seq - right.seq)) {
    if (record.event.type !== "agent_response_delta") continue;

    const delta = validateDeltaPayload(record.event.payload);
    if (
      !delta.completes_response &&
      (delta.final_claim !== null || delta.final_evidence.length > 0)
    ) {
      throw new TraceFoldError("completion data on noncompletion delta");
    }

    let participants = groupsByRound.get(delta.round_id);
    if (!participants) {
      participants = new Map();
      groupsByRound.set(delta.round_id, participants);
    }

    let group = participants.get(delta.participant_id);
    if (!group) {
      group = {
        round_id: delta.round_id,
        participant_id: delta.participant_id,
        content: "",
        final_claim: null,
        final_evidence: [],
        completion_seq: 0,
        done: false,
      };
      participants.set(delta.participant_id, group);
      groupsInFirstSeenOrder.push(group);
    }

    if (group.done) {
      throw new TraceFoldError("delta after completion");
    }

    group.content += delta.content_delta;
    if (delta.completes_response) {
      group.done = true;
      group.final_claim = delta.final_claim;
      group.final_evidence = [...new Set(delta.final_evidence)];
      group.completion_seq = record.seq;
    }
  }

  if (groupsInFirstSeenOrder.some((group) => !group.done)) {
    throw new TraceFoldError("incomplete response");
  }

  return {
    responses: groupsInFirstSeenOrder.map(({ done: _, ...response }) => response),
  };
}
