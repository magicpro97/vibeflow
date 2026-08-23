import { expect, test } from "bun:test";
import { ConversationSubscribers } from "../../src/orchestrator/conversation/subscribers.js";
import type { PublicStoredTraceEvent } from "../../src/orchestrator/trace/types.js";

const event = (seq: number): PublicStoredTraceEvent =>
  ({
    workflow_id: "workflow",
    conversation_id: "conversation-a",
    revision_id: "revision",
    run_id: "run",
    turn_id: `turn-${seq}`,
    operation_id: "operation",
    attempt_id: "attempt",
    event_id: `event-${seq}`,
    seq,
    ts: "2026-08-22T00:00:00.000Z",
    public_session_ref: null,
    event: { type: "error", payload: { agent_id: null, code: "test", message: "test" } },
  }) as PublicStoredTraceEvent;

test("subscription exposes replay completion after ordered replay and pending deduplication", async () => {
  const subscribers = new ConversationSubscribers();
  let resolveReplay!: (events: PublicStoredTraceEvent[]) => void;
  const replay = new Promise<PublicStoredTraceEvent[]>((resolve) => {
    resolveReplay = resolve;
  });
  const observed: number[] = [];
  const unsubscribe = subscribers.subscribe(
    "conversation-a",
    (value) => observed.push(value.seq),
    () => replay,
    1,
  );
  subscribers.notify(event(3));
  subscribers.notify(event(4));
  resolveReplay([event(2), event(3)]);
  const replayReady = (unsubscribe as typeof unsubscribe & { replayReady?: Promise<void> })
    .replayReady;
  expect(replayReady).toBeInstanceOf(Promise);
  await replayReady;
  expect(observed).toEqual([2, 3, 4]);
  unsubscribe();
});

test("subscription exposes replay rejection and becomes inactive", async () => {
  const subscribers = new ConversationSubscribers();
  const unsubscribe = subscribers.subscribe(
    "conversation-a",
    () => {
      throw new Error("inactive subscription received an event");
    },
    () => Promise.reject(new Error("journal read failed")),
    0,
  );
  const replayReady = (unsubscribe as typeof unsubscribe & { replayReady?: Promise<void> })
    .replayReady;
  expect(replayReady).toBeInstanceOf(Promise);
  await expect(replayReady as Promise<void>).rejects.toThrow("journal read failed");
  subscribers.notify(event(1));
  unsubscribe();
});

test("a synchronous replay fault becomes the same readiness rejection", async () => {
  const subscribers = new ConversationSubscribers();
  const unsubscribe = subscribers.subscribe(
    "conversation-a",
    () => undefined,
    () => {
      throw new Error("synchronous journal fault");
    },
    0,
  );
  await expect(unsubscribe.replayReady).rejects.toThrow("synchronous journal fault");
  unsubscribe();
});
