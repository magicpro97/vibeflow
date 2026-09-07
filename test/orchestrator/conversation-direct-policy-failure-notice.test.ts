import { describe, expect, test } from "bun:test";
import { deriveConversationFailureNotice } from "../../src/orchestrator/conversation/direct-policy.js";

describe("deriveConversationFailureNotice", () => {
  test("silent empty completion (ok, completed, zero chunks) yields a visible no-response notice", () => {
    expect(
      deriveConversationFailureNotice({
        ok: true,
        complete: true,
        emittedChunks: 0,
        engine: "copilot",
      }),
    ).toBe("[copilot produced no response]");
  });

  test("normal completion with emitted content yields no notice", () => {
    expect(
      deriveConversationFailureNotice({
        ok: true,
        complete: true,
        emittedChunks: 3,
        engine: "copilot",
      }),
    ).toBeNull();
  });

  test("failed attempt yields a reason notice including the engine failure reason", () => {
    expect(
      deriveConversationFailureNotice({
        ok: false,
        complete: false,
        emittedChunks: 0,
        engine: "copilot",
        reason: "model not found",
      }),
    ).toBe("[copilot failed: model not found]");
  });

  test("failed attempt without a reason yields a generic failure notice", () => {
    expect(
      deriveConversationFailureNotice({
        ok: false,
        complete: false,
        emittedChunks: 0,
        engine: "codex",
      }),
    ).toBe("[codex failed]");
  });

  test("ambiguous non-completed state without content does not invent a response notice", () => {
    expect(
      deriveConversationFailureNotice({
        ok: true,
        complete: false,
        emittedChunks: 0,
        engine: "copilot",
      }),
    ).toBeNull();
  });
});
