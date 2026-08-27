import type { ConversationSnapshot, ConversationTraceRecord } from "../conversation-types.js";

export function ok(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`FAIL: ${label}`);
}

export function eq(label: string, actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`FAIL: ${label}\nexpected ${right}\nreceived ${left}`);
}

export const userMessage = (content: string): ConversationTraceRecord["event"] => ({
  type: "user_message",
  payload: { content, target_participants: "all" },
});

export async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("FAIL: expected promise to reject");
}

export function trace(
  seq: number,
  event: ConversationTraceRecord["event"],
  over: Partial<ConversationTraceRecord> = {},
): ConversationTraceRecord {
  return {
    workflow_id: "workflow-1",
    event_id: `event-${seq}`,
    seq,
    ts: `2026-08-23T00:00:${String(seq).padStart(2, "0")}.000Z`,
    conversation_id: "conversation-1",
    revision_id: "revision-1",
    run_id: "run-1",
    turn_id: "turn-1",
    operation_id: "operation-1",
    attempt_id: "attempt-1",
    public_session_ref: null,
    event,
    ...over,
  } as ConversationTraceRecord;
}

export const snapshot = {
  conversation_id: "conversation-1",
  lifecycle: "INIT",
  health: "healthy",
  policy: "direct",
  topic: "Conversation",
  participants: [],
  rounds: [],
  consensus_score: null,
  last_seq: 7,
} satisfies ConversationSnapshot;

export function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
