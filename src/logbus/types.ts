// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Channel = "vf" | "engine-stdout" | "engine-stderr" | "user" | "hook";
export type LogLevel = "info" | "warn" | "error" | "debug";

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
