import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEngineResources } from "../src/engine-output.js";

// Why fixtures on disk: field paths were captured from real engine runs (T1-T4) and are
// the contract this parser implements. Repo root (not test/) so the import specifier stays
// clean and bun's resolver is never involved for a file-only read.
const fixture = (name: string): string =>
  readFileSync(
    join(Bun.main.slice(0, Bun.main.lastIndexOf("/test/")), "test/fixtures/native", name),
    "utf8",
  );

describe("parseEngineResources (native engine JSON per engine)", () => {
  describe("claude (single JSON envelope)", () => {
    test("success envelope → tokens=input+output (cache_read excluded), cost, wall from ms", () => {
      const r = parseEngineResources("claude", fixture("claude-p-json.txt"));
      expect(r).toEqual({ tokens: 157, cost_usd: 0.008567100000000001, wall_seconds: 2.907 });
      // Hazard: cache_read_input_tokens (78221) is a SUBSET of input — never additive.
      expect(r?.tokens).not.toBe(157 + 78221);
    });

    test("missing fields are omitted, not zeroed", () => {
      expect(parseEngineResources("claude", JSON.stringify({ total_cost_usd: 0.42 }))).toEqual({
        cost_usd: 0.42,
      });
      expect(
        parseEngineResources(
          "claude",
          JSON.stringify({ usage: { input_tokens: 100, output_tokens: 50 } }),
        ),
      ).toEqual({ tokens: 150 });
    });

    test("cost 0 survives (falsy number is still a measurement)", () => {
      expect(parseEngineResources("claude", JSON.stringify({ total_cost_usd: 0 }))).toEqual({
        cost_usd: 0,
      });
    });

    test("non-numeric fields ignored; nothing usable → undefined", () => {
      expect(
        parseEngineResources(
          "claude",
          JSON.stringify({
            total_cost_usd: "nope",
            duration_ms: "later",
            usage: { input_tokens: "x" },
          }),
        ),
      ).toBeUndefined();
    });
  });

  describe("codex (JSONL stream)", () => {
    test("turn.completed usage → tokens input+output (cached excluded); no cost/duration", () => {
      const r = parseEngineResources("codex", fixture("codex-exec-json.jsonl"));
      expect(r).toEqual({ tokens: 19661 });
      expect(r?.cost_usd).toBeUndefined();
      expect(r?.wall_seconds).toBeUndefined();
    });

    test("tolerates error and reasoning item.completed types", () => {
      const raw = [
        '{"type":"thread.started","thread_id":"t"}',
        '{"type":"item.completed","item":{"type":"error","message":"boom"}}',
        '{"type":"item.completed","item":{"type":"reasoning","text":"think"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
        '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2,"cached_input_tokens":4}}',
      ].join("\n");
      expect(parseEngineResources("codex", raw)).toEqual({ tokens: 7 });
    });

    test("no turn.completed usage → undefined", () => {
      expect(
        parseEngineResources("codex", '{"type":"thread.started","thread_id":"t"}'),
      ).toBeUndefined();
    });
  });

  describe("copilot (JSONL stream)", () => {
    test("sessionDurationMs → wall_seconds; premiumRequests 0 survives", () => {
      const r = parseEngineResources("copilot", fixture("copilot-json.jsonl"));
      expect(r).toEqual({ wall_seconds: 79.965, cost_usd: 0 });
    });

    test("skips ephemeral events and does not count events", () => {
      const raw = [
        '{"type":"assistant.reasoning_delta","ephemeral":true,"data":{"deltaContent":"thinking"}}',
        '{"type":"assistant.message","ephemeral":true,"data":{"content":"streamed-not-durable"}}',
        '{"type":"result","sessionId":"s","exitCode":0,"usage":{"premiumRequests":0,"sessionDurationMs":1000,"totalApiDurationMs":900}}',
      ].join("\n");
      expect(parseEngineResources("copilot", raw)).toEqual({ wall_seconds: 1, cost_usd: 0 });
    });

    test("stream without a result event → undefined", () => {
      expect(
        parseEngineResources("copilot", '{"type":"assistant.message","data":{"content":"ok"}}'),
      ).toBeUndefined();
    });
  });

  describe("opencode (JSONL stream)", () => {
    test("step_finish tokens.total + cost (0 survives) + timestamps → wall", () => {
      const r = parseEngineResources("opencode", fixture("opencode-format-json.jsonl"));
      expect(r).toEqual({ tokens: 28887, cost_usd: 0, wall_seconds: 0.717 });
      expect(typeof r?.cost_usd).toBe("number");
    });

    test("no step_finish → undefined", () => {
      const raw = [
        '{"type":"step_start","timestamp":1000,"sessionID":"s","part":{"type":"step-start"}}',
        '{"type":"text","timestamp":1500,"sessionID":"s","part":{"type":"text","text":"ok"}}',
      ].join("\n");
      expect(parseEngineResources("opencode", raw)).toBeUndefined();
    });
  });

  describe("guards", () => {
    test("malformed JSON and undefined raw → undefined (never throw)", () => {
      expect(parseEngineResources("claude", "not json")).toBeUndefined();
      expect(parseEngineResources("codex", "not json")).toBeUndefined();
      expect(parseEngineResources("copilot", "not json")).toBeUndefined();
      expect(parseEngineResources("opencode", "not json")).toBeUndefined();
      expect(parseEngineResources("claude", undefined)).toBeUndefined();
      expect(parseEngineResources("codex", "")).toBeUndefined();
    });

    test("unknown engine → undefined", () => {
      expect(parseEngineResources("gemini" as never, '{"total_cost_usd":1}')).toBeUndefined();
    });

    test("non-string JSON docs and unusable lines are skipped, not thrown on", () => {
      expect(parseEngineResources("claude", '"just a string"')).toBeUndefined();
      expect(parseEngineResources("codex", "\nnot json\n\n")).toBeUndefined();
      expect(parseEngineResources("opencode", "[1,2,3]")).toBeUndefined();
    });
  });
});
