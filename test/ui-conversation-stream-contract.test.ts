import { describe, expect, test } from "bun:test";
import { CONVERSATION_SSE_EVENT } from "../src/orchestrator/conversation/conversation-sse-contract.js";
import { serializeConversationSseFrame } from "../src/server/conversation-sse.js";
import {
  createConversationStreamAttemptGuard,
  recoverConversationStreamAttempt,
} from "../src/ui/src/conversation-stream-attempt.js";

const streamError = (code: "not_found" | "service_unavailable") => {
  const data =
    code === "not_found"
      ? {
          code,
          message: "The conversation was not found.",
          correlation_id: "vf-stream-test",
          retryable: false,
          recovery_action: null,
          details: null,
        }
      : {
          code,
          message: "The stream is unavailable.",
          correlation_id: "vf-stream-test",
          retryable: true,
          recovery_action: "retry" as const,
          details: null,
        };
  const frame = serializeConversationSseFrame({ event: CONVERSATION_SSE_EVENT.ERROR, data });
  return /^data: (.*)$/mu.exec(frame)?.[1] ?? "";
};

describe("conversation SSE public error contract", () => {
  test("terminates on exact not-found frames and retries exact unavailable frames", async () => {
    const missing = createConversationStreamAttemptGuard();
    expect(missing.acceptTypedError(streamError("not_found"))).toEqual({
      fatal: true,
      message: "The conversation was not found.",
    });
    expect(
      await recoverConversationStreamAttempt(
        missing,
        async () => true,
        () => undefined,
      ),
    ).toBe("terminal");

    const unavailable = createConversationStreamAttemptGuard();
    expect(unavailable.acceptTypedError(streamError("service_unavailable"))).toEqual({
      fatal: false,
      message: "The stream is unavailable.",
    });
    expect(
      await recoverConversationStreamAttempt(
        unavailable,
        async () => true,
        () => undefined,
      ),
    ).toBe("renewed");
  });

  test("does not trust legacy or structurally incomplete error frames", () => {
    const attempt = createConversationStreamAttemptGuard();
    expect(attempt.acceptTypedError('{"code":"conversation_not_found","message":"Gone"}')).toEqual({
      fatal: false,
      message: "conversation stream failed",
    });
    expect(attempt.canRecover()).toBeTrue();
  });
});
