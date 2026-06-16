/**
 * Shared TTY mock for terminal-prompts tests.
 *
 * Extracted from test/terminal-prompts.test.ts so that other test files
 * (e.g. commands-coverage.test.ts for the B2 init --ask cancel test)
 * can drive the interactive prompt flow without duplicating the
 * install/restore plumbing.
 *
 * Usage:
 *   import { installTtyMock } from "./helpers/tty-mock.js";
 *   const tty = installTtyMock();
 *   // ... drive prompts ...
 *   // afterEach: tty.restore();
 */
import { Readable } from "node:stream";

const restoreFns: Array<() => void> = [];

export function installTtyMock(
  opts: {
    isTTY?: boolean;
    stdinChunks?: string[];
    /** When true, process.stdin.setRawMode(true) throws. Used to drive
     *  the B18 raw-mode-rollback path. */
    setRawModeThrows?: boolean;
  } = {},
): {
  rawModes: boolean[];
  pauses: number;
  restore: () => void;
} {
  const isTTY = opts.isTTY ?? true;
  const origIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const origSetRawMode = process.stdin.setRawMode;
  const origResume = process.stdin.resume;
  const origPause = process.stdin.pause;
  const origWrite = process.stdout.write;
  const origStdin = process.stdin;

  const state = { rawModes: [] as boolean[], pauses: 0 };

  // For non-TTY mode, swap process.stdin to a Readable that feeds the
  // configured chunks. For TTY mode, keep the existing stdin (keypress events
  // are emitted directly via process.stdin.emit) UNLESS stdinChunks is
  // explicitly provided, in which case we still need a Readable so readline
  // (used by textInput) can be driven while keypress events are emitted
  // via the same stream's emit.
  if (!isTTY || opts.stdinChunks !== undefined) {
    const chunks = opts.stdinChunks ?? [""];
    const readable = Readable.from(chunks.map((c) => Buffer.from(c, "utf8")));
    (readable as unknown as { isRaw: boolean }).isRaw = false;
    (readable as unknown as { setRawMode: (v: boolean) => unknown }).setRawMode = (
      value: boolean,
    ) => {
      state.rawModes.push(value);
      return readable;
    };
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: readable,
    });
    Object.defineProperty(readable, "isTTY", {
      configurable: true,
      value: isTTY,
    });
  } else {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
  }
  process.stdin.setRawMode = ((value: boolean) => {
    state.rawModes.push(value);
    if (opts.setRawModeThrows) {
      throw new Error("setRawMode failed (test)");
    }
    return process.stdin;
  }) as typeof process.stdin.setRawMode;
  if (isTTY) {
    // For TTY mode with stdinChunks: do NOT override resume/pause —
    // the original Readable's resume() is what makes the chunks flow.
    // For TTY mode without stdinChunks: keep the no-op override so
    // tests that emit keypress events don't have real TTY state
    // interfering.
    if (opts.stdinChunks === undefined) {
      process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
      process.stdin.pause = (() => {
        state.pauses += 1;
        return process.stdin;
      }) as typeof process.stdin.pause;
    }
  }
  process.stdout.write = (() => true) as typeof process.stdout.write;

  const restore = () => {
    if (!isTTY) {
      Object.defineProperty(process, "stdin", {
        configurable: true,
        value: origStdin,
      });
    } else if (origIsTty) {
      Object.defineProperty(process.stdin, "isTTY", origIsTty);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
    process.stdin.setRawMode = origSetRawMode;
    process.stdin.resume = origResume;
    process.stdin.pause = origPause;
    process.stdout.write = origWrite;
    process.stdin.removeAllListeners("keypress");
  };
  restoreFns.push(restore);
  return { rawModes: state.rawModes, pauses: state.pauses, restore };
}

export function restoreAllTtyMocks(): void {
  while (restoreFns.length) restoreFns.pop()?.();
}
