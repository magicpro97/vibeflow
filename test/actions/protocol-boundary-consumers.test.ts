import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTION_OPERATION_STATES,
  ACTION_OPERATION_TERMINAL_STATES,
} from "../../src/actions/protocol-contract.js";
import { CONVERSATION_SSE_EVENT } from "../../src/orchestrator/conversation/conversation-sse-contract.js";
import {
  HOME_ACTION_OPERATION_STATES,
  HOME_TERMINAL_OPERATION_STATES,
} from "../../src/ui/src/conversation-home-runtime.js";
import { HOME_MESSAGE_QUEUE_INVALIDATION_EVENT } from "../../src/ui/src/conversation-home-stream.js";

describe("shared action protocol boundary consumers", () => {
  test("browser and server boundaries consume the shared vocabulary", () => {
    expect(HOME_ACTION_OPERATION_STATES).toBe(ACTION_OPERATION_STATES);
    expect(HOME_TERMINAL_OPERATION_STATES).toBe(ACTION_OPERATION_TERMINAL_STATES);
    expect(Object.isFrozen(HOME_ACTION_OPERATION_STATES)).toBeTrue();
    expect(Object.isFrozen(HOME_TERMINAL_OPERATION_STATES)).toBeTrue();
    expect(() => (HOME_ACTION_OPERATION_STATES as unknown as string[]).push("invented")).toThrow();
    expect(() => (HOME_TERMINAL_OPERATION_STATES as unknown as string[]).splice(0, 1)).toThrow();
    expect(HOME_ACTION_OPERATION_STATES).toEqual(ACTION_OPERATION_STATES);
    expect(HOME_TERMINAL_OPERATION_STATES).toEqual(ACTION_OPERATION_TERMINAL_STATES);
    expect(HOME_MESSAGE_QUEUE_INVALIDATION_EVENT).toBe(
      CONVERSATION_SSE_EVENT.MESSAGE_QUEUE_INVALIDATED,
    );

    const requiredImports = new Map([
      ["src/ui/src/conversation-home-types.ts", "../../actions/protocol-contract.js"],
      ["src/ui/src/conversation-home-runtime.ts", "../../actions/protocol-contract.js"],
      ["src/ui/src/conversation-home-operation-stream.ts", "ACTION_OPERATION_SSE_EVENT"],
      ["src/server/conversation-action-events-route.ts", "ACTION_OPERATION_SSE_EVENT"],
      ["src/server/conversation-action-route.ts", "isActionOperationDomainTerminalState"],
      ["src/orchestrator/conversation/types.ts", "ConversationSseFrameV1"],
      ["src/server/conversation-sse.ts", "CONVERSATION_SSE_EVENT"],
      ["src/ui/src/conversation-home-stream.ts", "CONVERSATION_SSE_EVENT"],
    ]);
    for (const [path, symbol] of requiredImports)
      expect(readFileSync(resolve(path), "utf8"), path).toContain(symbol);
  });
});
