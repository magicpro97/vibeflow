// src/commands/atomic-write.ts
//
// Extracted from state.ts to keep that file under the 400-line cap.
// Pure write helper; no logbus, no state. Generic — usable by any
// caller that needs atomic file writes (the brief surface is the
// first consumer).

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

/** Atomic write of a file. Writes to a temp file, fsyncs, then
 *  renames over the destination. POSIX rename is atomic; a SIGKILL
 *  between truncate and the new bytes leaves the OLD file intact
 *  (the rename never happened). On failure the temp is unlinked.
 *  Pure stdlib (`node:fs`), no new deps.
 *
 *  F0 review #3: the brief is the durable cross-session memory; a
 *  corrupt brief is a hard DoS (every `init --coord` refuses, every
 *  skill that reads the brief crashes). Atomic write is the fix. */
export function atomicWriteFileSync(
  path: string,
  data: string,
  inject: {
    openSync?: typeof openSync;
    writeSync?: (fd: number, data: string) => number;
    closeSync?: typeof closeSync;
    fsyncSync?: typeof fsyncSync;
    renameSync?: typeof renameSync;
    unlinkSync?: typeof unlinkSync;
    writeFileSync?: (p: string, data: string, opts?: { mode?: number }) => void;
    pid?: number;
  } = {},
): void {
  const _open = inject.openSync ?? openSync;
  // writeSync isn't in node:fs named exports on every platform, so we
  // reuse writeFileSync for the test seam (writeFileSync doesn't need an
  // explicit fd). When the test injects writeSync, use it.
  const _writeFile = inject.writeFileSync ?? writeFileSync;
  const _writeFd = inject.writeSync;
  const _close = inject.closeSync ?? closeSync;
  const _fsync = inject.fsyncSync ?? fsyncSync;
  const _rename = inject.renameSync ?? renameSync;
  const _unlink = inject.unlinkSync ?? unlinkSync;
  const pid = inject.pid ?? process.pid;
  const tmp = `${path}.tmp.${pid}`;
  // Open + write + fsync + close on the temp, then rename over the destination.
  // We use writeFileSync for the temp body (atomic relative to the temp
  // path); the fsync is on the file descriptor so the kernel flushes
  // the metadata BEFORE the rename — otherwise a power loss could leave
  // the temp written but not durable.
  try {
    _writeFile(tmp, data, { mode: 0o600 });
    if (_writeFd) {
      // Test seam: not used in production.
      const fd = _open(tmp, "a");
      _writeFd(fd, data);
      _fsync(fd);
      _close(fd);
    } else {
      // Production: open the temp, fsync, close. writeFileSync already
      // closed the fd, so we re-open in append-mode (creates if needed)
      // and close immediately after fsync.
      const fd = _open(tmp, "r+");
      _fsync(fd);
      _close(fd);
    }
    _rename(tmp, path);
  } catch (err) {
    try {
      _unlink(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}
