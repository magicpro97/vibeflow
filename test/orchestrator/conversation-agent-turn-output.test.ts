import { describe, expect, test } from "bun:test";
import { AGENT_ENGINE } from "../../src/core/agent-contract.js";
import {
  ENGINE_EVIDENCE_STATUS,
  ENGINE_NATIVE_SESSION_STATUS,
} from "../../src/dispatch/session-contract.js";
import type { EngineSessionResult } from "../../src/dispatch/session-types.js";
import {
  CONVERSATION_AGENT_TURN_OUTPUT_LIMIT,
  projectConversationAgentTurnOutput,
  projectConversationAgentTurnResult,
} from "../../src/orchestrator/conversation/agent-turn-output-projection.js";
import { CONVERSATION_OPERATION_STATE } from "../../src/orchestrator/conversation/conversation-public-wire-contract.js";
import { DirectOutputStreamV1 } from "../../src/orchestrator/conversation/direct-output-stream.js";

const sessionId = "00000000-0000-4000-8000-000000000001";
const claudeEnvelope = (result: string, overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result,
    ...overrides,
  });

describe("conversation agent-turn output projection", () => {
  test("unwraps one bounded Claude success result with compact, pretty, or trailing-newline framing", () => {
    const compact = claudeEnvelope("READY");
    const pretty = JSON.stringify(JSON.parse(compact), null, 2);

    expect(projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, compact)).toBe("READY");
    expect(projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, `${compact}\n`)).toBe("READY");
    expect(projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, pretty)).toBe("READY");
  });

  test("accepts bounded newline events only when exactly one success terminal is last", () => {
    const prelude = JSON.stringify({ type: "assistant", message: { content: "working" } });
    const terminal = claudeEnvelope("READY");
    expect(
      projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, `${prelude}\r\n\r\n${terminal}\r\n`),
    ).toBe("READY");

    for (const ambiguous of [
      `${terminal}\n${prelude}`,
      `${terminal}\n${terminal}`,
      `${prelude}\nnot-json\n${terminal}`,
    ]) {
      expect(projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, ambiguous)).toBe(ambiguous);
    }
  });

  test("preserves ordinary text and JSON answers without transport over-parsing", () => {
    const answers = [
      "READY",
      JSON.stringify({ answer: "legitimate JSON" }),
      JSON.stringify(["legitimate", "array"]),
      JSON.stringify({ type: "result", subtype: "unknown", result: "user data" }),
      '{"type":"result","subtype":"success",',
    ];
    for (const answer of answers)
      expect(projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, answer)).toBe(answer);

    const jsonAnswer = JSON.stringify({ answer: "inner JSON remains the model answer" });
    expect(
      projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, claudeEnvelope(jsonAnswer)),
    ).toBe(jsonAnswer);
  });

  test("rejects malformed, error, prototype-key, and over-limit envelopes without projecting them", () => {
    const fixtures = [
      claudeEnvelope("READY", { result: 7 }),
      claudeEnvelope("READY", { is_error: true }),
      claudeEnvelope("READY", { session_id: "" }),
      claudeEnvelope("READY", { session_id: "bad\u0000session" }),
      claudeEnvelope("READY", {
        session_id: "s".repeat(CONVERSATION_AGENT_TURN_OUTPUT_LIMIT.MAX_SESSION_ID_BYTES + 1),
      }),
      `{"type":"result","subtype":"success","session_id":"${sessionId}","result":"READY","usage":{"__proto__":{}}}`,
      `{"type":"result","subtype":"success","session_id":"${sessionId}","result":"READY","constructor":{}}`,
      `{"type":"result","subtype":"success","session_id":"${sessionId}","result":"READY","usage":{"prototype":{}}}`,
      Array.from({ length: CONVERSATION_AGENT_TURN_OUTPUT_LIMIT.MAX_RECORDS + 1 }, () =>
        JSON.stringify({ type: "assistant" }),
      ).join("\n"),
      "x".repeat(CONVERSATION_AGENT_TURN_OUTPUT_LIMIT.MAX_BYTES + 1),
    ];
    for (const fixture of fixtures)
      expect(projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, fixture)).toBe(fixture);
  });

  test("keeps Codex and OpenCode output/result identity byte-for-byte", () => {
    const transportLike = claudeEnvelope("READY");
    for (const engine of [AGENT_ENGINE.CODEX, AGENT_ENGINE.OPENCODE] as const) {
      const result: EngineSessionResult = Object.freeze({
        attemptId: "attempt-1",
        engine,
        ok: true,
        state: CONVERSATION_OPERATION_STATE.COMPLETED,
        lifecycle: [CONVERSATION_OPERATION_STATE.COMPLETED],
        output: transportLike,
        evidenceStatus: ENGINE_EVIDENCE_STATUS.PERSISTED,
        nativeSessionStatus: ENGINE_NATIVE_SESSION_STATUS.UNAVAILABLE,
      });
      expect(projectConversationAgentTurnOutput(engine, transportLike)).toBe(transportLike);
      expect(projectConversationAgentTurnResult(result)).toBe(result);
    }
  });

  test("requires the authenticated successful completion state at the attempt boundary", () => {
    const failed: EngineSessionResult = Object.freeze({
      attemptId: "attempt-failed",
      engine: AGENT_ENGINE.CLAUDE,
      ok: false,
      state: CONVERSATION_OPERATION_STATE.AMBIGUOUS,
      lifecycle: [CONVERSATION_OPERATION_STATE.AMBIGUOUS],
      output: claudeEnvelope("must not be projected"),
      evidenceStatus: ENGINE_EVIDENCE_STATUS.PERSISTED,
      nativeSessionStatus: ENGINE_NATIVE_SESSION_STATUS.UNAVAILABLE,
    });
    expect(projectConversationAgentTurnResult(failed)).toBe(failed);
  });

  test("replaces buffered Claude transport chunks with only the authoritative human result", () => {
    const transport = `${claudeEnvelope("READY")}\n`;
    const emitted: string[] = [];
    const output = new DirectOutputStreamV1((content) => emitted.push(content));
    output.push(transport.slice(0, 19));
    output.push(transport.slice(19));

    const projected = projectConversationAgentTurnOutput(AGENT_ENGINE.CLAUDE, transport);
    expect(output.finish(projected)).toMatchObject({ answer: "READY", structured: false });
    expect(emitted).toEqual(["READY"]);
    expect(emitted.join("")).not.toContain(sessionId);
    expect(emitted.join("")).not.toContain('"type":"result"');
  });
});
