// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import {
  LOG_CHANNEL,
  type LogChannel,
  type LogLevel,
  isLogChannel,
  isLogLevel,
} from "../core/log-contract.js";

export {
  LOG_CHANNEL,
  LOG_CHANNELS,
  LOG_LEVEL,
  LOG_LEVELS,
  isLogChannel,
  isLogLevel,
  type LogLevel,
} from "../core/log-contract.js";

/** @deprecated Prefer the explicit LogChannel name. */
export type Channel = LogChannel;

export interface LogContext {
  workflowId?: string;
  repoPath?: string;
}

export interface LogEvent {
  /** Monotonic per-bus sequence number; doubles as the dedup key for SSE re-connect. */
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  /** Per-run UUID — shared across all events of a single workflow run. */
  runId: string;
  /** Stable workflow identity (state.task_id); absent for legacy events. */
  workflowId?: string;
  /** Absolute local repo path; absent for legacy events. */
  repoPath?: string;
  /** Optional work-unit attribution. */
  unit?: string;
  channel: Channel;
  level: LogLevel;
  /** Pre-joined, ANSI-stripped text. */
  text: string;
  meta?: Record<string, unknown>;
}

export type LogEventInput = Omit<LogEvent, "ts" | "seq"> & {
  ts?: number;
  seq?: number;
};

export interface WatchHandle {
  close(): void;
  currentOffset(): number;
}

const FORBIDDEN_KEYS = Object.freeze(["__proto__", "constructor", "prototype"] as const);

const isSafeRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return FORBIDDEN_KEYS.every((key) => !Object.prototype.hasOwnProperty.call(value, key));
};

const isSafeJsonTree = (value: unknown, seen = new WeakSet<object>()): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isSafeJsonTree(item, seen));
  if (!isSafeRecord(value)) return false;
  return Object.values(value).every((item) => isSafeJsonTree(item, seen));
};

const optionalString = (record: Record<string, unknown>, key: string): boolean =>
  record[key] === undefined || typeof record[key] === "string";

/** Decode a current or legacy JSONL event, rejecting invented protocol values. */
export function decodeLogEvent(value: unknown): LogEvent | null {
  if (!isSafeRecord(value) || !isSafeJsonTree(value)) return null;
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0) return null;
  if (typeof value.ts !== "number" || !Number.isFinite(value.ts) || value.ts < 0) return null;
  if (!isLogLevel(value.level)) return null;
  if (value.channel !== undefined && !isLogChannel(value.channel)) return null;
  if (typeof value.text !== "string") return null;
  if (value.runId !== undefined && typeof value.runId !== "string") return null;
  if (!["workflowId", "repoPath", "unit"].every((key) => optionalString(value, key))) return null;
  if (value.meta !== undefined && !isSafeRecord(value.meta)) return null;
  return {
    seq: value.seq as number,
    ts: value.ts,
    runId: value.runId ?? "",
    workflowId: value.workflowId as string | undefined,
    repoPath: value.repoPath as string | undefined,
    unit: value.unit as string | undefined,
    channel: value.channel ?? LOG_CHANNEL.VIBE_FLOW,
    level: value.level,
    text: value.text,
    meta: value.meta,
  };
}

// Strip CSI escapes (ESC [ ... letter), bare CR, and cursor-position sequences.
// The literal regex pattern intentionally matches ANSI control chars; biome's
// noControlCharactersInRegex is a false positive for log sanitization.
// biome-ignore lint/suspicious/noControlCharactersInRegex: log-bus must strip ANSI/CR
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\r|\x1b\[\d+;\d+H/g;
const MAX_TEXT_BYTES = 8 * 1024;

export const DEFAULTS = {
  thresholdBytes: 2 * 1024 * 1024,
  maxRotations: 5,
  retentionDays: 7,
  retentionMaxBytes: 500 * 1024 * 1024,
  minRotateSize: 64 * 1024,
  lockTimeoutMs: 5000,
  lockRetryMs: 50,
  maxSubscribers: 100,
} as const;

export function safeText(raw: string): string {
  // Strip ANSI escapes + CR; cap at 8 KB.
  const stripped = raw.replace(ANSI_RE, "");
  if (stripped.length <= MAX_TEXT_BYTES) return stripped;
  return stripped.slice(0, MAX_TEXT_BYTES);
}

export function stringifyEvent(ev: LogEvent): string {
  return JSON.stringify(ev);
}

export function nowEpoch(): number {
  return Date.now();
}
