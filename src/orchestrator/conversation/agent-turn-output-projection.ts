import { AGENT_ENGINE, type Engine } from "../../core/agent-contract.js";
import {
  OWNED_PROCESS_TERMINAL_KIND,
  type OwnedProcessTerminalKind,
} from "../../dispatch/owned-process-contract.js";
import { ENGINE_SESSION_PROTOCOL } from "../../dispatch/session-contract.js";
import { observeSessionTerminal } from "../../dispatch/session-terminal.js";
import type { EngineSessionResult } from "../../dispatch/session-types.js";
import { TRACE_LIMITS, utf8Bytes } from "../trace/limits.js";
import { CONVERSATION_OPERATION_STATE } from "./conversation-public-wire-contract.js";

export const CONVERSATION_AGENT_TURN_OUTPUT_LIMIT = Object.freeze({
  MAX_BYTES: TRACE_LIMITS.maxTextBytes,
  MAX_RECORDS: TRACE_LIMITS.maxArrayItems,
  MAX_NODES: TRACE_LIMITS.maxArrayItems * TRACE_LIMITS.maxDepth,
  MAX_DEPTH: TRACE_LIMITS.maxDepth,
  MAX_SESSION_ID_BYTES: TRACE_LIMITS.maxReferenceBytes,
} as const);

const CLAUDE_RESULT_ENVELOPE_FIELD = Object.freeze({
  RESULT: "result",
  SESSION_ID: "session_id",
  IS_ERROR: "is_error",
} as const);

const UNSAFE_JSON_KEYS = Object.freeze(["__proto__", "constructor", "prototype"] as const);
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });

interface ParsedJsonRecord {
  readonly source: string;
  readonly value: Readonly<Record<string, unknown>>;
}

function isSafeJsonTree(root: Readonly<Record<string, unknown>>): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (
      nodes > CONVERSATION_AGENT_TURN_OUTPUT_LIMIT.MAX_NODES ||
      current.depth > CONVERSATION_AGENT_TURN_OUTPUT_LIMIT.MAX_DEPTH
    )
      return false;
    if (current.value === null || typeof current.value !== "object") continue;
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
      return false;
    const keys = Object.keys(current.value);
    if (keys.length > TRACE_LIMITS.maxArrayItems) return false;
    for (const key of keys) {
      if (UNSAFE_JSON_KEYS.some((candidate) => candidate === key)) return false;
      pending.push({
        value: (current.value as Record<string, unknown>)[key],
        depth: current.depth + 1,
      });
    }
  }
  return true;
}

function parseRecord(source: string): ParsedJsonRecord | null {
  if (!source || utf8Bytes(source) > TRACE_LIMITS.maxRecordBytes) return null;
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return isSafeJsonTree(record) ? { source, value: record } : null;
  } catch {
    return null;
  }
}

function parseOutputRecords(output: string): readonly ParsedJsonRecord[] | null {
  if (!output || utf8Bytes(output) > CONVERSATION_AGENT_TURN_OUTPUT_LIMIT.MAX_BYTES) return null;
  const trimmed = output.trim();
  const single = parseRecord(trimmed);
  if (single) return [single];
  const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length < 2 || lines.length > CONVERSATION_AGENT_TURN_OUTPUT_LIMIT.MAX_RECORDS)
    return null;
  const records: ParsedJsonRecord[] = [];
  for (const line of lines) {
    const record = parseRecord(line.trim());
    if (!record) return null;
    records.push(record);
  }
  return records;
}

function isClaudeSuccessTerminal(kind: OwnedProcessTerminalKind | undefined): boolean {
  return kind === OWNED_PROCESS_TERMINAL_KIND.CLAUDE_RESULT_SUCCESS;
}

/**
 * Removes only a validated Claude CLI success envelope. Other engines and ordinary model
 * answers retain byte-identical output, including JSON answers that are not transport records.
 */
export function projectConversationAgentTurnOutput(engine: Engine, output: string): string {
  if (engine !== AGENT_ENGINE.CLAUDE) return output;
  const records = parseOutputRecords(output);
  if (!records) return output;
  let terminalCount = 0;
  let finalTerminal = false;
  for (const [index, record] of records.entries()) {
    const observed = observeSessionTerminal(
      ENGINE_SESSION_PROTOCOL.NATIVE,
      AGENT_ENGINE.CLAUDE,
      record.source,
    );
    if (!isClaudeSuccessTerminal(observed?.kind)) continue;
    terminalCount += 1;
    finalTerminal = index === records.length - 1;
  }
  if (terminalCount !== 1 || !finalTerminal) return output;
  const envelope = records.at(-1)?.value;
  if (!envelope) return output;
  const result = envelope[CLAUDE_RESULT_ENVELOPE_FIELD.RESULT];
  const sessionId = envelope[CLAUDE_RESULT_ENVELOPE_FIELD.SESSION_ID];
  if (
    !Object.hasOwn(envelope, CLAUDE_RESULT_ENVELOPE_FIELD.RESULT) ||
    !Object.hasOwn(envelope, CLAUDE_RESULT_ENVELOPE_FIELD.SESSION_ID) ||
    typeof result !== "string" ||
    typeof sessionId !== "string" ||
    sessionId.trim().length === 0 ||
    hasControlCharacter(sessionId) ||
    utf8Bytes(sessionId) > CONVERSATION_AGENT_TURN_OUTPUT_LIMIT.MAX_SESSION_ID_BYTES ||
    utf8Bytes(result) > TRACE_LIMITS.maxTextBytes ||
    (Object.hasOwn(envelope, CLAUDE_RESULT_ENVELOPE_FIELD.IS_ERROR) &&
      envelope[CLAUDE_RESULT_ENVELOPE_FIELD.IS_ERROR] !== false)
  )
    return output;
  return result;
}

export function projectConversationAgentTurnResult(
  result: EngineSessionResult,
): EngineSessionResult {
  if (!result.ok || result.state !== CONVERSATION_OPERATION_STATE.COMPLETED) return result;
  const output = projectConversationAgentTurnOutput(result.engine, result.output);
  return output === result.output ? result : Object.freeze({ ...result, output });
}
