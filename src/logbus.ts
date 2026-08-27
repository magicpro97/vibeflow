import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { LOG_CHANNEL, LOG_LEVEL } from "./core/log-contract.js";
import { DEFAULTS, nowEpoch, safeText, stringifyEvent } from "./logbus/types.js";
import type { LogContext, LogEvent, LogEventInput } from "./logbus/types.js";
import type { PublicStoredTraceEvent } from "./orchestrator/trace/types.js";

// Re-exports from moved modules
export { out } from "./logbus/out.js";
export { watchLogbus } from "./logbus/watch.js";
export { decodeLogEvent } from "./logbus/types.js";
export type { Channel, LogLevel, LogEvent, LogEventInput, WatchHandle } from "./logbus/types.js";
export { tmpdir } from "node:os";
export class Logbus {
  private readonly dir: string;
  private readonly runId: string;
  private readonly context: LogContext;
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
    context?: LogContext;
  }) {
    this.runId = opts.runId;
    void this.runId;
    this.dir = opts.dir;
    this.context = { ...opts.context };
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
      workflowId: input.workflowId ?? this.context.workflowId,
      repoPath: input.repoPath ?? this.context.repoPath,
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
      release = await this.acquireLock();
    } catch (err) {
      // Lock acquisition failed. A common cause is the log dir (or the
      // lockfile's parent) having been removed mid-run by a checkpoint /
      // rotation elsewhere, surfacing as ENOENT. Recreate the dir and retry
      // ONCE before giving up, so a transient missing directory does not
      // silently drop events (issue #145).
      const recovered = await this.recoverAndRelock(err);
      if (recovered) {
        release = recovered;
      } else {
        process.stderr.write(
          `[logbus] lock acquire failed: ${(err as Error).message}\n` +
            `[logbus] dropped event seq=${ev.seq} text="${ev.text.slice(0, 80)}"\n`,
        );
        return;
      }
    }

    try {
      const line = `${stringifyEvent(ev)}\n`;
      // The dir may have vanished between lock and append; ensure it exists.
      mkdirSync(this.dir, { recursive: true });
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

  /** Acquire the cross-process write lock with the standard retry/stale params. */
  private acquireLock(): Promise<() => Promise<void>> {
    return lockfile.lock(this.currentFile(), {
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
  }

  /** ENOENT recovery: recreate the log dir + lock target, then relock once.
   *  Returns the release fn on success, or null if recovery is not applicable
   *  (non-ENOENT) or the retry also failed. */
  private async recoverAndRelock(err: unknown): Promise<(() => Promise<void>) | null> {
    const code = (err as NodeJS.ErrnoException)?.code;
    const msg = (err as Error)?.message ?? "";
    if (code !== "ENOENT" && !msg.includes("ENOENT")) return null;
    try {
      mkdirSync(this.dir, { recursive: true });
      if (!existsSync(this.currentFile())) {
        appendFileSync(this.currentFile(), "");
        chmodSync(this.currentFile(), 0o600);
      }
      return await this.acquireLock();
    } catch {
      return null;
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
      // Issue #163 (F2): ensure the log dir exists BEFORE the lockfile
      // call. The writeLocked path already does this (L191); rotate
      // was missing it — when the dir was removed mid-run the lockfile
      // would fail with ENOENT and the event would drop silently.
      mkdirSync(this.dir, { recursive: true });
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

  mirrorTrace(event: PublicStoredTraceEvent): void {
    this.write({
      runId: "trace-public",
      workflowId: "trace-public",
      repoPath: "",
      channel: LOG_CHANNEL.VIBE_FLOW,
      level: LOG_LEVEL.INFO,
      text: `trace:${event.event.type}`.slice(0, 128),
      meta: { trace: event },
    });
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

export function installLogbus(
  opts: { dir?: string; runId?: string; context?: LogContext } = {},
): Logbus {
  const dir = opts.dir ?? join(process.cwd(), ".vibeflow", "logs");
  const runId = opts.runId ?? `run-${Date.now().toString(36)}`;
  active = new Logbus({ runId, dir, context: opts.context });
  return active;
}

export function getLogbus(): Logbus | null {
  return active;
}

export function setLogbusForTests(bus: Logbus | null): void {
  active = bus;
}

/** #525: true if an event should be sent to a stream scoped to `unit`.
 *  No filter (undefined/empty) ⇒ everything passes. With a filter ⇒ only
 *  events for that exact unit (events with no `unit` are session-level and
 *  are excluded from a unit-scoped stream). */
export function matchesUnitFilter(ev: { unit?: string }, unit: string | undefined): boolean {
  if (!unit) return true;
  return ev.unit === unit;
}
