import {
  appendFileSync,
  chmodSync,
  createReadStream,
  existsSync,
  watch as fsWatch,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { activeSpinner } from "./ui.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Channel = "vf" | "engine-stdout" | "engine-stderr" | "user" | "hook";
export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEvent {
  /** Monotonic per-bus sequence number; doubles as the dedup key for SSE re-connect. */
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  /** Per-run UUID — shared across all events of a single workflow run. */
  runId: string;
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

// Strip CSI escapes (ESC [ ... letter), bare CR, and cursor-position sequences.
// The literal regex pattern intentionally matches ANSI control chars; biome's
// noControlCharactersInRegex is a false positive for log sanitization.
// biome-ignore lint/suspicious/noControlCharactersInRegex: log-bus must strip ANSI/CR
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\r|\x1b\[\d+;\d+H/g;
const MAX_TEXT_BYTES = 8 * 1024;

const DEFAULTS = {
  thresholdBytes: 2 * 1024 * 1024,
  maxRotations: 5,
  retentionDays: 7,
  retentionMaxBytes: 500 * 1024 * 1024,
  minRotateSize: 64 * 1024,
  lockTimeoutMs: 5000,
  lockRetryMs: 50,
  maxSubscribers: 100,
} as const;

function safeText(raw: string): string {
  // Strip ANSI escapes + CR; cap at 8 KB.
  const stripped = raw.replace(ANSI_RE, "");
  if (stripped.length <= MAX_TEXT_BYTES) return stripped;
  return stripped.slice(0, MAX_TEXT_BYTES);
}

function stringifyEvent(ev: LogEvent): string {
  return JSON.stringify(ev);
}

function nowEpoch(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Logbus
// ---------------------------------------------------------------------------

export class Logbus {
  private readonly dir: string;
  private readonly runId: string;
  private readonly thresholdBytes: number;
  private readonly maxRotations: number;
  private readonly retentionDays: number;
  private readonly retentionMaxBytes: number;
  private readonly lockfilePath: string;

  private seq = 0;
  private subscribers = new Set<(ev: LogEvent) => void>();
  private currentSize = 0;
  /** In-process serialization chain (each write waits for the previous to finish). */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: {
    runId: string;
    dir: string;
    thresholdBytes?: number;
    maxRotations?: number;
    retentionDays?: number;
    retentionMaxBytes?: number;
  }) {
    this.runId = opts.runId;
    this.dir = opts.dir;
    this.thresholdBytes = opts.thresholdBytes ?? DEFAULTS.thresholdBytes;
    this.maxRotations = opts.maxRotations ?? DEFAULTS.maxRotations;
    this.retentionDays = opts.retentionDays ?? DEFAULTS.retentionDays;
    this.retentionMaxBytes = opts.retentionMaxBytes ?? DEFAULTS.retentionMaxBytes;
    this.lockfilePath = join(this.dir, "current.log.lock");

    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.currentFile())) {
      // Touch the file so the lock's realpath is resolvable (we use realpath:false below,
      // but having a real file avoids surprises).
      appendFileSync(this.currentFile(), "");
      chmodSync(this.currentFile(), 0o600);
    }
    this.currentSize = statSync(this.currentFile()).size;
  }

  currentFile(): string {
    return join(this.dir, "current.log");
  }

  dirOf(): string {
    return this.dir;
  }

  /** Append a single event. Serializes via an in-process Promise chain and a
   *  cross-process file lock so concurrent writers don't tear JSONL lines.
   *  Subscribers see the event synchronously (fan-out happens before queue),
   *  so a `write()` call followed by a subscriber observation is well-defined. */
  write(input: LogEventInput): void {
    if (this.closed) {
      // Late writes after close fall back to stderr; never silently lose.
      process.stderr.write(`[logbus] write after close: ${safeText(input.text)}\n`);
      return;
    }
    // Compose the event eagerly so subscribers see it in the caller's tick.
    const ev: LogEvent = {
      seq: typeof input.seq === "number" ? input.seq : ++this.seq,
      ts: typeof input.ts === "number" ? input.ts : nowEpoch(),
      runId: input.runId,
      unit: input.unit,
      channel: input.channel,
      level: input.level,
      text: safeText(input.text),
      meta: input.meta,
    };
    // Synchronous fan-out — this is the contract the spec promises ("fan-out happens
    // synchronously, in-memory only"). Subscribers see events in the same tick as
    // the write() call.
    this.fanout(ev);
    // Queue the actual disk write (lock + append) onto the in-process chain.
    this.chain = this.chain.then(() => this.writeLocked(ev));
  }

  private async writeLocked(ev: LogEvent): Promise<void> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.currentFile(), {
        realpath: false,
        lockfilePath: this.lockfilePath,
        retries: {
          retries: Math.ceil(DEFAULTS.lockTimeoutMs / DEFAULTS.lockRetryMs),
          factor: 1,
          minTimeout: DEFAULTS.lockRetryMs,
          maxTimeout: DEFAULTS.lockRetryMs,
        },
        stale: 2_000,
      });
    } catch (err) {
      // Lock acquisition failed (timeout, etc.) — log and continue.
      process.stderr.write(
        `[logbus] lock acquire failed: ${(err as Error).message}\n` +
          `[logbus] dropped event seq=${ev.seq} text="${ev.text.slice(0, 80)}"\n`,
      );
      return;
    }

    try {
      const line = `${stringifyEvent(ev)}\n`;
      appendFileSync(this.currentFile(), line, "utf8");
      this.currentSize += Buffer.byteLength(line, "utf8");

      // Rotate if we've crossed the threshold AND we have at least minRotateSize bytes
      // (don't rotate tiny files — that would create many empty .1, .2, ... siblings).
      if (this.currentSize > this.thresholdBytes && this.currentSize >= DEFAULTS.minRotateSize) {
        this.rotateLocked();
      }
    } catch (err) {
      process.stderr.write(`[logbus] write failed: ${(err as Error).message}\n`);
    } finally {
      try {
        if (release) await release();
      } catch {
        /* lockfile release failures are non-fatal */
      }
    }
  }

  private fanout(ev: LogEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(ev);
      } catch (err) {
        process.stderr.write(`[logbus] subscriber error: ${(err as Error).message}\n`);
      }
    }
  }

  /**
   * Public API. Use this to force a rotation (e.g. on unit completion). Safe to call
   * concurrently — serializes via the lockfile with the same retry/stale params as
   * {@link writeLocked}. Idempotent on small files (below minRotateSize).
   */
  async rotate(): Promise<void> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.currentFile(), {
        realpath: false,
        lockfilePath: this.lockfilePath,
        retries: {
          retries: Math.ceil(DEFAULTS.lockTimeoutMs / DEFAULTS.lockRetryMs),
          factor: 1,
          minTimeout: DEFAULTS.lockRetryMs,
          maxTimeout: DEFAULTS.lockRetryMs,
        },
        // 2s stale window: short enough for fast M2 CLI; long enough to survive graceful process exit
        stale: 2_000,
      });
    } catch (err) {
      // Lock acquisition failed — log and continue. The next write will trigger rotation
      // via writeLocked's threshold path, so the caller's intent is best-effort honored.
      process.stderr.write(`[logbus] rotate lock failed: ${(err as Error).message}\n`);
      return;
    }
    try {
      this.rotateLocked();
    } finally {
      try {
        if (release) await release();
      } catch {
        /* lockfile release failures are non-fatal */
      }
    }
  }

  private rotateLocked(): void {
    const cur = this.currentFile();
    if (!existsSync(cur)) return;
    const st = statSync(cur);
    if (st.size < DEFAULTS.minRotateSize) return;

    // Shift current.log.N → current.log.(N+1), drop anything beyond maxRotations.
    for (let i = this.maxRotations; i >= 1; i--) {
      const src = join(this.dir, `current.log.${i}`);
      const dst = join(this.dir, `current.log.${i + 1}`);
      if (existsSync(src)) {
        if (i === this.maxRotations) {
          // Drop the oldest.
          rmSync(src, { force: true });
        } else {
          renameSync(src, dst);
        }
      }
    }
    // Move current.log → current.log.1
    renameSync(cur, join(this.dir, "current.log.1"));
    // Create a fresh current.log with mode 0o600
    appendFileSync(cur, "");
    chmodSync(cur, 0o600);
    this.currentSize = 0;

    // Best-effort prune of old sessions.
    void this.prune().catch(() => {
      /* best effort */
    });
  }

  /** Remove old `sessions/*.jsonl` files based on retentionDays and retentionMaxBytes. */
  async prune(): Promise<void> {
    try {
      const sessions = join(this.dir, "sessions");
      if (!existsSync(sessions)) return;
      const entries = readdirSync(sessions)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const p = join(sessions, f);
          const st = statSync(p);
          return { path: p, mtimeMs: st.mtimeMs, size: st.size };
        });

      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const kept: typeof entries = [];
      for (const e of entries) {
        if (e.mtimeMs < cutoff) {
          try {
            rmSync(e.path, { force: true });
          } catch (err) {
            process.stderr.write(`[logbus] prune remove failed: ${(err as Error).message}\n`);
          }
        } else {
          kept.push(e);
        }
      }
      // Size cap: delete oldest first.
      let totalBytes = kept.reduce((a, e) => a + e.size, 0);
      if (totalBytes > this.retentionMaxBytes) {
        kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
        for (const e of kept) {
          if (totalBytes <= this.retentionMaxBytes) break;
          try {
            rmSync(e.path, { force: true });
            totalBytes -= e.size;
          } catch (err) {
            process.stderr.write(`[logbus] prune size-cap failed: ${(err as Error).message}\n`);
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[logbus] prune error: ${(err as Error).message}\n`);
    }
  }

  /** Subscribe to in-process events. Returns an unsubscribe function. */
  subscribe(cb: (ev: LogEvent) => void): () => void {
    if (this.subscribers.size >= DEFAULTS.maxSubscribers) {
      return () => {
        /* no-op */
      };
    }
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Release the lock and stop accepting writes. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Wait for the in-process chain to drain so we don't lose trailing writes.
    try {
      await this.chain;
    } catch {
      /* chain shouldn't reject — writeLocked swallows */
    }
    // Final prune.
    try {
      await this.prune();
    } catch {
      /* best effort */
    }
    // Clear the global reference when closing the active bus, so subsequent
    // getLogbus() returns null.  This keeps test files that share the same
    // process (e.g. sse-stream → logbus) isolated from one another.
    if (active === this) active = null;
  }
}

// ---------------------------------------------------------------------------
// Global install / get — used by the `out()` helper and by callers that want
// the bus without managing a local reference.
// ---------------------------------------------------------------------------

let active: Logbus | null = null;

export function installLogbus(opts: { dir?: string; runId?: string } = {}): Logbus {
  const dir = opts.dir ?? join(process.cwd(), ".vibeflow", "logs");
  const runId = opts.runId ?? `run-${Date.now().toString(36)}`;
  active = new Logbus({ runId, dir });
  return active;
}

export function getLogbus(): Logbus | null {
  return active;
}

export function setLogbusForTests(bus: Logbus | null): void {
  active = bus;
}

// ---------------------------------------------------------------------------
// out() — the universal log helper
// ---------------------------------------------------------------------------

function joinParts(parts: unknown[]): string {
  return parts
    .map((p) => (typeof p === "string" ? p : p == null ? String(p) : safeJson(p)))
    .join(" ");
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Universal log helper. Joins `parts` with a single space (console.log semantics),
 *  fans the event onto the active bus.
 *
 *  No-bus fallback mirrors the console.log/console.error stream routing the codemod was
 *  designed on:
 *    - default level ("info")  → process.stdout (user-facing; strips the redundant [vf] prefix)
 *    - level "warn"|"error"|"debug" → process.stderr (diagnostic; keeps the [channel] prefix)
 *
 *  Bus-installed behavior:
 *    - "vf" channel: bus is the persistent sink AND the line is also tee'd to the console
 *      (so existing CLI/UX rendering and console-mocking tests keep working). The bus owns
 *      the durable record; the console owns the user-facing stream.
 *    - "engine-stdout" / "engine-stderr" / "user" / "hook": bus is the SOLE destination
 *      (M2 contract: engine stderr no longer leaks to the parent TTY — it is captured and
 *      surfaced via the M3 SSE endpoint / `vf logs`).
 *
 *  The trailing arg, if it is a plain object, is treated as an options bag that may carry:
 *    - `level`: "info" (default) | "debug" | "warn" | "error"  (codemod shape)
 *    - `unit`:  work-unit attribution  (M2: engine-stderr path forwards this)
 *    - `meta`:  Record<string, unknown>  (M2: engine-stderr path includes { engine, unit })
 *  The bag is consumed — it does NOT leak into the joined text.
 */
export function out(channel: Channel, ...rawParts: unknown[]): void {
  const { level, unit, meta, parts } = extractOptsAndParts(rawParts);
  const text = parts.length === 0 ? "" : joinParts(parts);
  const bus = active;
  if (bus) {
    try {
      bus.write({
        runId: (bus as unknown as { runId: string }).runId,
        channel,
        level,
        unit,
        meta,
        text,
      });
    } catch (err) {
      process.stderr.write(`[logbus.out] write failed: ${(err as Error).message}\n`);
    }
    // M2: the "vf" channel goes to the M3 SSE endpoint and to the
    // console. Engine-stdout / engine-stderr / user / hook channels
    // also tee to the console so a CLI user running headless (no UI)
    // can see what the engine is doing — without this, a parent
    // terminal would see nothing during a 5-minute AI run, which is
    // the worst possible UX. The M3 SSE endpoint still gets the
    // full bus stream (bus.write above) for the UI surface.
    //
    // Set VF_QUIET=1 to suppress engine-* output (for CI / piped
    // output where you want only the [vf] channel).
    if (channel === "vf" || process.env.VF_QUIET !== "1") {
      emitToConsole(channel, level, text);
    }
    return;
  }
  // No-bus fallback: mirror console.log/console.error stream routing.
  emitToConsole(channel, level, text);
}

function emitToConsole(
  channel: Channel,
  level: "debug" | "info" | "warn" | "error",
  text: string,
): void {
  const toStderr = level === "warn" || level === "error" || level === "debug";
  const prefix = toStderr || channel !== "vf" ? `[${channel}] ` : "";
  const line = `${prefix}${text}`;

  // When a spinner is active, stop its animation and clear its line so
  // subsequent logs write cleanly without spinner interference.
  if (activeSpinner) {
    try {
      activeSpinner.deactivate();
      process.stderr.write(`${line}\n`);
    } catch {
      /* never throw out of out() */
    }
    return;
  }

  // Use console.log / console.error (not raw process.stdout/stderr.write) so that
  // test harnesses that mock console.log/console.error can capture the no-bus fallback.
  // In production, console.log writes to process.stdout and console.error to process.stderr,
  // so the user-visible stream routing is identical.
  const log = toStderr ? console.error : console.log;
  try {
    log(line);
  } catch {
    // Never throw out of out() — matches the prior round's invariant.
  }
}

function extractOptsAndParts(rawParts: unknown[]): {
  level: "debug" | "info" | "warn" | "error";
  unit?: string;
  meta?: Record<string, unknown>;
  parts: unknown[];
} {
  if (rawParts.length > 0) {
    const last = rawParts[rawParts.length - 1];
    if (last !== null && typeof last === "object" && !Array.isArray(last)) {
      const bag = last as { level?: unknown; unit?: unknown; meta?: unknown };
      const candidate = bag.level;
      const hasLevel =
        candidate === "debug" ||
        candidate === "info" ||
        candidate === "warn" ||
        candidate === "error";
      // Consume the bag as options only when it carries a recognized `level` field
      // (the codemod shape). A bare metadata object (e.g. {engine:"claude"}) is NOT
      // consumed — it falls through to be joined as text, matching the prior contract.
      if (hasLevel) {
        const out: {
          level: "debug" | "info" | "warn" | "error";
          unit?: string;
          meta?: Record<string, unknown>;
          parts: unknown[];
        } = {
          level: candidate,
          parts: rawParts.slice(0, -1),
        };
        if (typeof bag.unit === "string") out.unit = bag.unit;
        if (bag.meta !== null && typeof bag.meta === "object" && !Array.isArray(bag.meta)) {
          out.meta = bag.meta as Record<string, unknown>;
        }
        return out;
      }
    }
  }
  return { level: "info", parts: rawParts };
}

// ---------------------------------------------------------------------------
// logbus-watcher — exported here for the same file scope; uses fs.watch with
// debounce + safety poll to follow current.log.
// ---------------------------------------------------------------------------

export interface WatchHandle {
  close(): void;
  currentOffset(): number;
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_DEBOUNCE_MS = 50;

export function watchLogbus(
  bus: Logbus,
  onEvent: (ev: LogEvent) => void,
  opts: {
    pollMs?: number;
    debounceMs?: number;
    fromOffset?: number;
    // Test seam: lets unit tests inject a custom createReadStream
    // to exercise the stream.on("error") callback (line 598)
    // without depending on FS quirks.
    createReadStream?: typeof import("node:fs").createReadStream;
  } = {},
): WatchHandle {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let offset = opts.fromOffset ?? 0;
  let closed = false;
  let lastFileInode = 0;
  let pendingDebounce: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let watcher: ReturnType<typeof fsWatch> | null = null;

  // Resolve the current file inode so we can detect rotations (which create a new
  // current.log with a different inode).
  try {
    if (existsSync(bus.currentFile())) {
      lastFileInode = statSync(bus.currentFile()).ino;
    }
  } catch {
    /* file may not exist yet */
  }

  function readChunk(): void {
    if (closed) return;
    const file = bus.currentFile();
    if (!existsSync(file)) return;

    let st: import("node:fs").Stats;
    try {
      st = statSync(file);
    } catch {
      return;
    }
    // Detect rotation: file size shrunk OR inode changed.
    if (st.ino !== lastFileInode || st.size < offset) {
      offset = 0;
      lastFileInode = st.ino;
    }
    if (st.size <= offset) return;

    const stream = (opts.createReadStream ?? createReadStream)(file, {
      start: offset,
      end: st.size,
      encoding: "utf8",
    });
    let buffer = "";
    stream.on("data", (chunk: string | Buffer) => {
      const piece = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer += piece;
      let nl: number;
      // biome-ignore lint/suspicious/noAssignInExpressions: streaming line splitter
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as LogEvent;
          onEvent(ev);
        } catch (err) {
          process.stderr.write(`[logbus-watcher] bad line: ${(err as Error).message}\n`);
        }
      }
    });
    stream.on("end", () => {
      offset = st.size;
    });
    stream.on("error", (err) => {
      process.stderr.write(`[logbus-watcher] stream error: ${err.message}\n`);
    });
  }

  function debouncedRead(): void {
    if (closed) return;
    if (pendingDebounce) clearTimeout(pendingDebounce);
    pendingDebounce = setTimeout(() => {
      pendingDebounce = null;
      readChunk();
    }, debounceMs);
  }

  // Primary: fs.watch on the directory (file-level fs.watch misses rename events on some
  // platforms, but dir-level catches them).
  try {
    watcher = fsWatch(bus.dirOf(), { persistent: false }, () => {
      debouncedRead();
    });
    watcher.on("error", () => {
      /* fall back to poll only */
    });
  } catch {
    watcher = null;
  }

  // Belt-and-suspenders: watchFile for cross-platform reliability.
  try {
    watchFile(bus.currentFile(), { persistent: false, interval: pollMs }, () => {
      debouncedRead();
    });
  } catch {
    /* file may not exist yet */
  }

  // Safety poll.
  pollTimer = setInterval(readChunk, pollMs);

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (pendingDebounce) clearTimeout(pendingDebounce);
      if (pollTimer) clearInterval(pollTimer);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      }
      try {
        unwatchFile(bus.currentFile());
      } catch {
        /* ignore */
      }
    },
    currentOffset(): number {
      return offset;
    },
  };
}

// Re-export from node:os for tests that import both modules from the same path.
export { tmpdir };
