import { expect, test } from "bun:test";
import { ConversationServiceQueueWakeV1 } from "../../src/orchestrator/conversation/service-queue-wake.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function harness(execute: () => Promise<unknown>) {
  const kicks: string[] = [];
  const wake = new ConversationServiceQueueWakeV1(
    { execute } as never,
    () =>
      ({
        rootSessionId: (conversationId: string) =>
          conversationId === "conversation-child" ? "conversation-root" : null,
        kick: (rootSessionId: string) => kicks.push(rootSessionId),
      }) as never,
  );
  return { kicks, wake };
}

test("execution wakes the mapped queue root only after resolve and reject", async () => {
  const first = deferred<unknown>();
  const resolved = harness(() => first.promise);
  const running = resolved.wake.execute(
    { conversation_id: "conversation-child" } as never,
    "operation",
  );
  expect(resolved.kicks).toEqual([]);
  first.resolve({ status: "completed" });
  await expect(running).resolves.toBeDefined();
  expect(resolved.kicks).toEqual(["conversation-root"]);

  const second = deferred<unknown>();
  const rejected = harness(() => second.promise);
  const failed = rejected.wake.execute(
    { conversation_id: "conversation-child" } as never,
    "operation",
  );
  second.reject(new Error("terminal failure"));
  await expect(failed).rejects.toThrow("terminal failure");
  expect(rejected.kicks).toEqual(["conversation-root"]);
});

test("revision settlement wakes only after the lane promise settles", async () => {
  const first = deferred<number>();
  const resolved = harness(async () => undefined);
  const running = resolved.wake.settle("conversation-child", first.promise);
  expect(resolved.kicks).toEqual([]);
  first.resolve(7);
  await expect(running).resolves.toBe(7);
  expect(resolved.kicks).toEqual(["conversation-root"]);

  const second = deferred<number>();
  const rejected = harness(async () => undefined);
  const failed = rejected.wake.settle("conversation-child", second.promise);
  second.reject(new Error("retry failed"));
  await expect(failed).rejects.toThrow("retry failed");
  expect(rejected.kicks).toEqual(["conversation-root"]);
});

test("settlement does not invent a queue root", async () => {
  const { kicks, wake } = harness(async () => undefined);
  await expect(wake.settle("unknown-conversation", Promise.resolve("done"))).resolves.toBe("done");
  expect(kicks).toEqual([]);
});
