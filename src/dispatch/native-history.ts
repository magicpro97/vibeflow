import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_ENGINE, type Engine } from "../core/agent-contract.js";
import { CONVERSATION_RECONCILIATION_STATUS as HISTORY_STATUS } from "../orchestrator/conversation/conversation-public-wire-contract.js";
import { NATIVE_HISTORY_CONTINUITY } from "./session-contract.js";
import type { HistoryReconcileRequest, HistoryReconcileResult } from "./session-types.js";

export interface LoadedNativeHistory {
  records: unknown[];
  complete: boolean;
}

type NativeHistoryEngine = Extract<Engine, typeof AGENT_ENGINE.CLAUDE | typeof AGENT_ENGINE.CODEX>;

function nativeHistoryRoots(engine: NativeHistoryEngine): string[] {
  const root = engine === AGENT_ENGINE.CLAUDE ? ".claude/projects" : ".codex/sessions";
  return [join(homedir(), root)];
}

/** Locate a supported CLI's persisted JSONL by exact opaque session id, without exposing paths. */
export function loadNativeHistory(
  request: HistoryReconcileRequest,
  roots?: readonly string[],
): LoadedNativeHistory | undefined {
  if (request.engine !== AGENT_ENGINE.CLAUDE && request.engine !== AGENT_ENGINE.CODEX)
    return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.nativeSessionId)) return undefined;
  const escapedId = request.nativeSessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codexName = new RegExp(
    `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}(?:-\\d+)?-${escapedId}\\.jsonl$`,
  );
  const matches = (name: string) =>
    request.engine === AGENT_ENGINE.CLAUDE
      ? name === `${request.nativeSessionId}.jsonl`
      : codexName.test(name);
  let visited = 0;
  const find = (dir: string): string | undefined => {
    if (visited++ > 20_000) return undefined;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of [...entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(dir, entry.name);
      if (entry.isFile() && matches(entry.name)) return path;
      if (entry.isDirectory()) {
        const nested = find(path);
        if (nested) return nested;
      }
    }
    return undefined;
  };
  for (const root of roots ?? nativeHistoryRoots(request.engine)) {
    const path = find(root);
    if (!path) continue;
    const records: unknown[] = [];
    let complete = true;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        complete = false;
      }
    }
    return { records, complete };
  }
  return undefined;
}

/** Project supplied native history without ever returning its internal session identifier. */
export function reconcileNativeHistory(request: HistoryReconcileRequest): HistoryReconcileResult {
  if (request.engine !== AGENT_ENGINE.CLAUDE && request.engine !== AGENT_ENGINE.CODEX) {
    return {
      status: HISTORY_STATUS.UNAVAILABLE,
      imported_turn_count: 0,
      imported_tool_count: 0,
      native_history_continuity: NATIVE_HISTORY_CONTINUITY.UNPROVED,
      completeness_reason: `${request.engine} native history completeness is not supported`,
    };
  }
  if (!request.history) {
    return {
      status: HISTORY_STATUS.PARTIAL,
      imported_turn_count: 0,
      imported_tool_count: 0,
      native_history_continuity: NATIVE_HISTORY_CONTINUITY.UNPROVED,
      completeness_reason: "supported native history was not supplied",
    };
  }
  let turns = 0;
  let tools = 0;
  let recognized = request.history.length > 0;
  let exactIdentity = false;
  let compacted = false;
  const claudeTypes = new Set([
    "assistant",
    "user",
    "system",
    "progress",
    "file-history-snapshot",
    "queue-operation",
    "attachment",
    "last-prompt",
  ]);
  const codexTypes = new Set([
    "session_meta",
    "response_item",
    "event_msg",
    "turn_context",
    "compacted",
    "ghost_snapshot",
    "turn_aborted",
  ]);
  for (const value of request.history) {
    if (!value || typeof value !== "object") {
      recognized = false;
      continue;
    }
    const item = value as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";
    if (request.engine === AGENT_ENGINE.CLAUDE) {
      if (!claudeTypes.has(type)) recognized = false;
      if (item.sessionId === request.nativeSessionId) exactIdentity = true;
      else if (typeof item.sessionId === "string") recognized = false;
      if (type === "system" && item.subtype === "compact_boundary") compacted = true;
      if (type === "assistant") turns++;
    } else {
      if (!codexTypes.has(type)) recognized = false;
      if (type === "compacted") compacted = true;
    }
    const message = item.message as Record<string, unknown> | undefined;
    if (Array.isArray(message?.content)) {
      tools += message.content.filter(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "tool_use",
      ).length;
    }
    const payload = item.payload as Record<string, unknown> | undefined;
    if (request.engine === AGENT_ENGINE.CODEX && type === "session_meta") {
      if (payload?.id === request.nativeSessionId) exactIdentity = true;
      else recognized = false;
    }
    if (
      item.type === "response_item" &&
      payload?.type === "message" &&
      payload.role === "assistant"
    ) {
      turns++;
    }
    if (
      item.type === "response_item" &&
      (payload?.type === "function_call" || payload?.type === "custom_tool_call")
    ) {
      tools++;
    }
  }
  return {
    status:
      recognized && exactIdentity && !compacted
        ? HISTORY_STATUS.RECONCILED
        : HISTORY_STATUS.PARTIAL,
    imported_turn_count: turns,
    imported_tool_count: tools,
    native_history_continuity: compacted
      ? NATIVE_HISTORY_CONTINUITY.COMPACTED
      : recognized && exactIdentity
        ? NATIVE_HISTORY_CONTINUITY.INTACT
        : NATIVE_HISTORY_CONTINUITY.UNPROVED,
    completeness_reason: compacted
      ? "native history contains a compaction boundary; exact resume authority is invalid"
      : recognized && exactIdentity
        ? "supported native history supplied"
        : "native history contained unrecognized or mismatched records",
  };
}
