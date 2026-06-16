import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Spinner, resetActiveSpinner } from "../src/ui.js";

let writtenToConsole: { channel: string; args: unknown[] }[] = [];
let originalError: typeof console.error;
let originalLog: typeof console.log;
let originalStderrWrite: typeof process.stderr.write;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  writtenToConsole = [];
  originalError = console.error;
  originalLog = console.log;
  originalStderrWrite = process.stderr.write;
  originalIsTTY = process.stderr.isTTY;
  // Spy on console.error and console.log so tests don't pollute terminal output
  console.error = (...args: unknown[]) => {
    writtenToConsole.push({ channel: "error", args });
  };
  console.log = (...args: unknown[]) => {
    writtenToConsole.push({ channel: "log", args });
  };
  // Also spy on stderr.write (used in TTY path via private line())
  (process.stderr as { write: typeof process.stderr.write }).write = ((
    chunk: string | Uint8Array,
  ) => {
    if (typeof chunk === "string") {
      writtenToConsole.push({ channel: "stderr", args: [chunk] });
    } else {
      writtenToConsole.push({ channel: "stderr", args: [new TextDecoder().decode(chunk)] });
    }
    return true;
  }) as typeof process.stderr.write;
  // Force non-TTY so we hit the console.error branches, not stderr.write
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  resetActiveSpinner();
  console.error = originalError;
  console.log = originalLog;
  (process.stderr as { write: typeof process.stderr.write }).write = originalStderrWrite;
  Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
});

function outputText(): string {
  return writtenToConsole.map((w) => w.args.map((a) => String(a)).join(" ")).join("\n");
}

describe("ui: Spinner (non-TTY)", () => {
  test("start(msg) prints the message via console.error", () => {
    const s = new Spinner();
    s.start("loading");
    expect(writtenToConsole.length).toBeGreaterThan(0);
    expect(outputText()).toContain("loading");
  });

  test("succeed(msg) prints ✔ and updates the message", () => {
    const s = new Spinner();
    s.start("working");
    s.succeed("done");
    expect(outputText()).toContain("✔");
    expect(outputText()).toContain("done");
  });

  test("succeed() with no arg keeps the original message", () => {
    const s = new Spinner();
    s.start("working");
    s.succeed();
    expect(outputText()).toContain("✔");
    expect(outputText()).toContain("working");
  });

  test("fail(msg) prints ✖ and updates the message", () => {
    const s = new Spinner();
    s.start("working");
    s.fail("oops");
    expect(outputText()).toContain("✖");
    expect(outputText()).toContain("oops");
  });

  test("fail() with no arg keeps the original message", () => {
    const s = new Spinner();
    s.start("working");
    s.fail();
    expect(outputText()).toContain("✖");
    expect(outputText()).toContain("working");
  });

  test("text(msg) updates the message and writes the current frame in TTY mode", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const s = new Spinner();
    s.start("one");
    s.text("two");
    expect(outputText()).toContain("two");
  });

  test("text(msg) does nothing in non-TTY mode (T-only branch)", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    const s = new Spinner();
    s.start("one");
    // text() should NOT write anything in non-TTY (it only writes in TTY).
    s.text("two");
    expect(outputText()).not.toContain("two");
  });
});

describe("ui: Spinner (TTY)", () => {
  test("start(msg) in TTY mode uses process.stderr.write (line) instead of console.error", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const s = new Spinner();
    s.start("tty-msg");
    // TTY path writes to stderr (the spy above captures it). The
    // message must still appear.
    expect(outputText()).toContain("tty-msg");
  });
});
