import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseEngineFinalText, parseEngineResources } from "../src/engine-output.js";

// Why fixtures on disk: field paths were captured from real engine runs (T1-T4) and are
// the contract this parser implements. Anchored to import.meta.url (not cwd or Bun.main)
// so the read is portable across Windows separators and cwd-changing sibling suites —
// same convention as test/commands-coverage.test.ts readSrc.
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/native/${name}`, import.meta.url), "utf8");

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
    test("sessionDurationMs → wall_seconds; premiumRequests is a count, not cost_usd", () => {
      const r = parseEngineResources("copilot", fixture("copilot-json.jsonl"));
      expect(r).toEqual({ wall_seconds: 79.965 });
      // Hazard: the fixture's usage.premiumRequests:0 is a request COUNT — it must
      // never surface as USD ("$0.00"); the key must be absent, not undefined-valued.
      expect(Object.hasOwn(r ?? {}, "cost_usd")).toBe(false);
    });

    test("skips ephemeral events; only the durable result event yields measurements", () => {
      const raw = [
        '{"type":"assistant.reasoning_delta","ephemeral":true,"data":{"deltaContent":"thinking"}}',
        '{"type":"assistant.message","ephemeral":true,"data":{"content":"streamed-not-durable"}}',
        '{"type":"result","sessionId":"s","exitCode":0,"usage":{"premiumRequests":0,"sessionDurationMs":1000,"totalApiDurationMs":900}}',
      ].join("\n");
      const r = parseEngineResources("copilot", raw);
      expect(r).toEqual({ wall_seconds: 1 });
      expect(Object.hasOwn(r ?? {}, "cost_usd")).toBe(false);
    });

    test("ephemeral:true result is skipped by the guard — only-ephemeral stream → undefined", () => {
      // The guard is the only difference between these two streams; if it stops
      // skipping ephemeral results, the first assertion flips to { wall_seconds: 0.5 }.
      const ephemeralResult =
        '{"type":"result","ephemeral":true,"sessionId":"s","usage":{"sessionDurationMs":500}}';
      const durableResult = '{"type":"result","sessionId":"s","usage":{"sessionDurationMs":500}}';
      expect(parseEngineResources("copilot", ephemeralResult)).toBeUndefined();
      expect(parseEngineResources("copilot", durableResult)).toEqual({ wall_seconds: 0.5 });
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

describe("parseEngineFinalText (native engine final text per engine)", () => {
  const fence = '```json\n{"verdict":"approve","summary":"native answer"}\n```';

  describe("claude (single JSON envelope)", () => {
    test("fixture: envelope .result is the final text", () => {
      expect(parseEngineFinalText("claude", fixture("claude-p-json.txt"))).toBe('{"ok":true}');
    });

    test("envelope without a non-empty string .result → undefined", () => {
      expect(parseEngineFinalText("claude", JSON.stringify({ type: "result" }))).toBeUndefined();
      expect(parseEngineFinalText("claude", JSON.stringify({ result: 42 }))).toBeUndefined();
      expect(parseEngineFinalText("claude", JSON.stringify({ result: "   " }))).toBeUndefined();
    });

    test("plain prose (no envelope) → undefined, caller keeps its raw fallback", () => {
      expect(parseEngineFinalText("claude", "just prose")).toBeUndefined();
    });
  });

  describe("codex (JSONL stream)", () => {
    test("LAST agent_message wins; reasoning/error items ignored", () => {
      const raw = [
        '{"type":"item.completed","item":{"type":"reasoning","text":"already contains a fence"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"first answer"}}',
        '{"type":"item.completed","item":{"type":"error","message":"boom"}}',
        `{"type":"item.completed","item":{"type":"agent_message","text":${JSON.stringify(fence)}}}`,
      ].join("\n");
      expect(parseEngineFinalText("codex", raw)).toBe(fence);
    });

    test("fixture: single agent_message text is returned", () => {
      expect(parseEngineFinalText("codex", fixture("codex-exec-json.jsonl"))).toBe("ok");
    });

    test("no agent_message, or only empty text → undefined", () => {
      expect(
        parseEngineFinalText("codex", '{"type":"thread.started","thread_id":"t"}'),
      ).toBeUndefined();
      expect(
        parseEngineFinalText(
          "codex",
          '{"type":"item.completed","item":{"type":"agent_message","text":"   "}}',
        ),
      ).toBeUndefined();
    });
  });

  describe("copilot (JSONL stream)", () => {
    test("fixture: durable assistant.message data.content is the final text", () => {
      expect(parseEngineFinalText("copilot", fixture("copilot-json.jsonl"))).toBe("ok");
    });

    test("ephemeral:true events skipped; LAST durable assistant.message wins", () => {
      const raw = [
        '{"type":"assistant.message","ephemeral":true,"data":{"content":"streamed-not-durable"}}',
        '{"type":"assistant.message","data":{"content":"first answer"}}',
        `{"type":"assistant.message","data":{"content":${JSON.stringify(fence)}}}`,
      ].join("\n");
      expect(parseEngineFinalText("copilot", raw)).toBe(fence);
    });

    test("only ephemeral events → undefined", () => {
      expect(
        parseEngineFinalText(
          "copilot",
          '{"type":"assistant.message","ephemeral":true,"data":{"content":"x"}}',
        ),
      ).toBeUndefined();
    });
  });

  describe("opencode (JSONL stream)", () => {
    test("fixture: type:text part.text is the final text", () => {
      expect(parseEngineFinalText("opencode", fixture("opencode-format-json.jsonl"))).toBe("ok");
    });

    test("multiple text events are newline-joined", () => {
      const raw = [
        '{"type":"text","part":{"type":"text","text":"part one"}}',
        '{"type":"step_finish","part":{"type":"step-finish"}}',
        '{"type":"text","part":{"type":"text","text":"part two"}}',
      ].join("\n");
      expect(parseEngineFinalText("opencode", raw)).toBe("part one\npart two");
    });

    test("no text events → undefined", () => {
      expect(
        parseEngineFinalText("opencode", '{"type":"step_finish","part":{"type":"step-finish"}}'),
      ).toBeUndefined();
    });
  });

  describe("guards", () => {
    test("malformed JSON and undefined raw → undefined (never throw)", () => {
      expect(parseEngineFinalText("claude", "not json")).toBeUndefined();
      expect(parseEngineFinalText("codex", "not json")).toBeUndefined();
      expect(parseEngineFinalText("copilot", "not json")).toBeUndefined();
      expect(parseEngineFinalText("opencode", "not json")).toBeUndefined();
      expect(parseEngineFinalText("claude", undefined)).toBeUndefined();
      expect(parseEngineFinalText("codex", "")).toBeUndefined();
    });

    test("unknown engine → undefined", () => {
      expect(parseEngineFinalText("gemini" as never, '{"result":"x"}')).toBeUndefined();
    });

    test("non-object JSON docs are skipped, not thrown on", () => {
      expect(parseEngineFinalText("copilot", '"just a string"')).toBeUndefined();
      expect(parseEngineFinalText("opencode", "[1,2,3]")).toBeUndefined();
      expect(parseEngineFinalText("codex", "\nnot json\n\n")).toBeUndefined();
    });
  });
});

describe("numeric guards (Copilot review round): measurements must be finite and non-negative", () => {
  // src/resources.ts aggregates tokens/cost under a never-negative assumption; a
  // negative or non-finite value from untrusted engine JSON must be dropped, not summed.
  test("claude: invalid measurements are dropped per field (no zeroing, no crash)", () => {
    // Raw JSON string: `1e400` must reach the parser as Infinity (a JS literal would
    // trip biome's noPrecisionLoss before the value ever gets there).
    const envelope =
      '{"usage":{"input_tokens":-1,"output_tokens":5},"total_cost_usd":1e400,"duration_ms":-5}';
    // input_tokens (-1) / cost (Infinity) / duration (-5) each dropped; output 5 survives.
    expect(parseEngineResources("claude", envelope)).toEqual({ tokens: 5 });
  });

  test("claude: mixed valid + invalid keeps only the valid fields", () => {
    const envelope = JSON.stringify({
      usage: { input_tokens: 10, output_tokens: 7 },
      total_cost_usd: -0.5,
      duration_ms: 1000,
    });
    expect(parseEngineResources("claude", envelope)).toEqual({ tokens: 17, wall_seconds: 1 });
  });

  test("codex/opencode/copilot: negative numbers are omitted, never summed", () => {
    const codex = ['{"type":"turn.completed","usage":{"input_tokens":-2,"output_tokens":3}}'].join(
      "\n",
    );
    expect(parseEngineResources("codex", codex)).toEqual({ tokens: 3 });

    const opencode = [
      '{"type":"step_start","sessionID":"s"}',
      '{"type":"text","part":{"text":"ok"}}',
      '{"type":"step_finish","part":{"cost":-1,"tokens":{"total":-9}}}',
    ].join("\n");
    expect(parseEngineResources("opencode", opencode)).toBeUndefined();

    const copilot = JSON.stringify({
      type: "result",
      sessionId: "s",
      exitCode: 0,
      usage: { sessionDurationMs: -1 },
    });
    expect(parseEngineResources("copilot", copilot)).toBeUndefined();
  });
});
