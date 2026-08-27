import {
  createReadStream,
  existsSync,
  watch as fsWatch,
  statSync,
  unwatchFile,
  watchFile,
} from "node:fs";
import type { Logbus } from "../logbus.js";
import { type LogEvent, type WatchHandle, decodeLogEvent } from "./types.js";

// ---------------------------------------------------------------------------
// logbus-watcher — uses fs.watch with debounce + safety poll to follow current.log.
// ---------------------------------------------------------------------------

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
    // Test seams for the defensive catch branches: a statSync that throws
    // (file vanished between existsSync and statSync) and an fsWatch that
    // throws (platform without inotify). Inject to exercise without FS quirks.
    statSyncFn?: typeof import("node:fs").statSync;
    fsWatchFn?: typeof import("node:fs").watch;
  } = {},
): WatchHandle {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const statSyncFn = opts.statSyncFn ?? statSync;
  const fsWatchFn = opts.fsWatchFn ?? fsWatch;
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
      st = statSyncFn(file);
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
          const ev = decodeLogEvent(JSON.parse(line));
          if (ev) onEvent(ev);
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
    watcher = fsWatchFn(bus.dirOf(), { persistent: false }, () => {
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
