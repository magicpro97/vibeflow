import type { Engine } from "../core.js";
import { AGENT_ENGINE } from "../core/agent-contract.js";
import { TRACE_LIMITS } from "../orchestrator/trace/limits.js";
import {
  OWNED_PROCESS_TERMINAL_KIND,
  type OwnedProcessTerminalKind,
} from "./owned-process-contract.js";
import { ENGINE_SESSION_PROTOCOL } from "./session-contract.js";
import type { EngineSessionAdapterOptions } from "./session-types.js";

type JsonRecord = Record<string, unknown>;

function jsonObject(record: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(record.trim()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

const bounded = (value: string): boolean =>
  Buffer.byteLength(value, "utf8") <= TRACE_LIMITS.maxTextBytes;

/** Bounded raw-stdout accumulator that never enters public results, traces, or evidence. */
export class NativeModelOutputAccumulator {
  readonly #engine: Engine;
  readonly #enabled: boolean;
  #recordBuffer = "";
  #discardingOversizeRecord = false;
  #invalid = false;
  #terminalCount = 0;
  #candidate: string | undefined;
  #opencodeParts: string[] = [];
  #opencodeBytes = 0;
  #plain = "";
  #plainBytes = 0;

  constructor(engine: Engine, protocol: EngineSessionAdapterOptions["protocol"]) {
    this.#engine = engine;
    this.#enabled = protocol !== ENGINE_SESSION_PROTOCOL.BRIDGE;
  }

  consume(content: string, flush: boolean): void {
    if (!this.#enabled || this.#invalid) return;
    if (this.#engine === AGENT_ENGINE.COPILOT || this.#engine === AGENT_ENGINE.ANTIGRAVITY) {
      this.#capturePlain(content);
      return;
    }
    let input = this.#recordBuffer + content;
    this.#recordBuffer = "";
    if (this.#discardingOversizeRecord) {
      const newline = input.indexOf("\n");
      if (newline < 0) {
        if (flush) this.#invalid = true;
        return;
      }
      input = input.slice(newline + 1);
      this.#discardingOversizeRecord = false;
      this.#invalid = true;
    }
    let start = 0;
    let newline = input.indexOf("\n");
    while (newline >= 0) {
      this.#captureRecord(input.slice(start, newline + 1));
      start = newline + 1;
      newline = input.indexOf("\n", start);
    }
    const remainder = input.slice(start);
    if (flush) this.#captureRecord(remainder);
    else if (Buffer.byteLength(remainder, "utf8") > TRACE_LIMITS.maxRecordBytes) {
      this.#discardingOversizeRecord = true;
    } else {
      this.#recordBuffer = remainder;
    }
  }

  seal(authenticatedTerminal: OwnedProcessTerminalKind | null): string | undefined {
    if (!this.#enabled || this.#invalid) return undefined;
    if (this.#engine === AGENT_ENGINE.CLAUDE)
      return authenticatedTerminal === OWNED_PROCESS_TERMINAL_KIND.CLAUDE_RESULT_SUCCESS &&
        this.#terminalCount === 1
        ? this.#candidate
        : undefined;
    if (this.#engine === AGENT_ENGINE.CODEX)
      return authenticatedTerminal === OWNED_PROCESS_TERMINAL_KIND.CODEX_TURN_COMPLETED &&
        this.#terminalCount === 1
        ? this.#candidate
        : undefined;
    if (this.#engine === AGENT_ENGINE.OPENCODE) {
      const output = this.#opencodeParts.join("\n");
      return output && bounded(output) ? output : undefined;
    }
    return this.#plain && bounded(this.#plain) ? this.#plain : undefined;
  }

  #capturePlain(content: string): void {
    this.#plainBytes += Buffer.byteLength(content, "utf8");
    if (this.#plainBytes > TRACE_LIMITS.maxTextBytes) {
      this.#invalid = true;
      this.#plain = "";
      return;
    }
    this.#plain += content;
  }

  #captureRecord(record: string): void {
    if (!record.trim()) return;
    if (Buffer.byteLength(record, "utf8") > TRACE_LIMITS.maxRecordBytes) {
      this.#invalid = true;
      return;
    }
    const value = jsonObject(record);
    if (!value) return;
    if (this.#engine === AGENT_ENGINE.CLAUDE) this.#captureClaude(value);
    else if (this.#engine === AGENT_ENGINE.CODEX) this.#captureCodex(value);
    else if (this.#engine === AGENT_ENGINE.OPENCODE) this.#captureOpenCode(value);
  }

  #captureClaude(value: JsonRecord): void {
    if (value.type !== "result") return;
    this.#terminalCount += 1;
    if (
      this.#terminalCount !== 1 ||
      value.subtype !== "success" ||
      typeof value.session_id !== "string" ||
      value.session_id.length === 0 ||
      (Object.hasOwn(value, "is_error") && value.is_error !== false)
    ) {
      this.#invalid = true;
      this.#candidate = undefined;
      return;
    }
    const output =
      typeof value.result === "string"
        ? value.result
        : value.structured_output && typeof value.structured_output === "object"
          ? JSON.stringify(value.structured_output)
          : value.result && typeof value.result === "object"
            ? JSON.stringify(value.result)
            : undefined;
    if (output === undefined || !bounded(output)) {
      this.#invalid = true;
      return;
    }
    this.#candidate = output;
  }

  #captureCodex(value: JsonRecord): void {
    if (value.type === "turn.completed") {
      this.#terminalCount += 1;
      if (this.#terminalCount !== 1 || this.#candidate === undefined) this.#invalid = true;
      return;
    }
    if (
      value.type !== "item.completed" ||
      this.#terminalCount > 0 ||
      !value.item ||
      typeof value.item !== "object" ||
      Array.isArray(value.item)
    )
      return;
    const item = value.item as JsonRecord;
    if (item.type !== "agent_message" || typeof item.text !== "string") return;
    if (!bounded(item.text)) {
      this.#invalid = true;
      this.#candidate = undefined;
      return;
    }
    this.#candidate = item.text;
  }

  #captureOpenCode(value: JsonRecord): void {
    if (
      value.type !== "text" ||
      !value.part ||
      typeof value.part !== "object" ||
      Array.isArray(value.part)
    )
      return;
    const text = (value.part as JsonRecord).text;
    if (typeof text !== "string") return;
    this.#opencodeBytes += Buffer.byteLength(text, "utf8") + (this.#opencodeParts.length ? 1 : 0);
    if (this.#opencodeBytes > TRACE_LIMITS.maxTextBytes) {
      this.#invalid = true;
      this.#opencodeParts = [];
      return;
    }
    this.#opencodeParts.push(text);
  }
}
