import { afterEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { confirmInput, selectMany, selectOne, textInput } from "../src/terminal-prompts.js";

const restoreFns: Array<() => void> = [];

function installTtyMock(
  opts: { isTTY?: boolean; stdinChunks?: string[] } = {},
): { rawModes: boolean[]; pauses: number; restore: () => void } {
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
  // are emitted directly via process.stdin.emit).
  if (!isTTY) {
    const chunks = opts.stdinChunks ?? [""];
    const readable = Readable.from(chunks.map((c) => Buffer.from(c, "utf8")));
    (readable as unknown as { isRaw: boolean }).isRaw = false;
    (readable as unknown as { setRawMode: undefined }).setRawMode = undefined;
    Object.defineProperty(process, "stdin", { configurable: true, value: readable });
    Object.defineProperty(readable, "isTTY", { configurable: true, value: false });
    // For non-TTY: do NOT override resume/pause — readline needs the real
    // stream methods to actually flow the chunks. The isTTY=false branch in
    // terminal-prompts.ts doesn't touch setRawMode/resume anyway.
  } else {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  }
  process.stdin.setRawMode = ((value: boolean) => {
    state.rawModes.push(value);
    return process.stdin;
  }) as typeof process.stdin.setRawMode;
  if (isTTY) {
    process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
    process.stdin.pause = (() => {
      state.pauses += 1;
      return process.stdin;
    }) as typeof process.stdin.pause;
  }
  process.stdout.write = (() => true) as typeof process.stdout.write;

  const restore = () => {
    if (!isTTY) {
      Object.defineProperty(process, "stdin", { configurable: true, value: origStdin });
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
  return { ...state, restore };
}

afterEach(() => {
  while (restoreFns.length) restoreFns.pop()?.();
});

async function runPrompt<T>(fn: () => Promise<T>, stdinChunks: string[] = [""]): Promise<T> {
  installTtyMock({ isTTY: false, stdinChunks });
  return await fn();
}

async function runPromptWithChunks<T>(fn: () => Promise<T>, chunks: string[]): Promise<T> {
  installTtyMock({ isTTY: false, stdinChunks: chunks });
  return await fn();
}

describe("terminal prompts — non-TTY (in-process)", () => {
  // textInput/confirmInput no longer accept non-TTY input (B4 fix): they
  // throw fast instead of falling into the readline path. See the
  // "non-TTY guard (defect #B4)" describe block below for the rejection
  // contract. selectOne/selectMany still keep their readline fallback
  // (they are the only entry points that should be called from scripts).
  test("selectOne non-TTY fallback returns first option on EOF", async () => {
    await expect(runPrompt(() => selectOne("Pick", ["A", "B"]), [""])).resolves.toBe("A");
  });

  test("selectOne non-TTY fallback honors explicit default on EOF", async () => {
    await expect(
      runPrompt(() => selectOne("Pick", ["A", "B"], { defaultValue: "B" }), [""]),
    ).resolves.toBe("B");
  });

  test("selectOne non-TTY fallback returns typed answer", async () => {
    await expect(
      runPrompt(() => selectOne("Pick", ["A", "B"], { defaultValue: "A" }), ["B\n"]),
    ).resolves.toBe("B");
  });

  test("selectMany non-TTY fallback returns first option on EOF", async () => {
    await expect(runPrompt(() => selectMany("Pick", ["A", "B"]), [""])).resolves.toEqual(["A"]);
  });

  test("selectMany non-TTY fallback honors explicit defaults on EOF", async () => {
    await expect(
      runPrompt(() => selectMany("Pick", ["A", "B"], { defaultValues: ["B"] }), [""]),
    ).resolves.toEqual(["B"]);
  });

  test("selectMany non-TTY fallback parses comma-separated input", async () => {
    await expect(runPrompt(() => selectMany("Pick", ["A", "B"]), ["A, B\n"])).resolves.toEqual([
      "A",
      "B",
    ]);
  });
});

describe("terminal prompts — TTY raw-mode (in-process)", () => {
  test("selectOne raw-mode Escape rejects as cancelled", async () => {
    installTtyMock();
    const promise = selectOne("Pick", ["A"], { timeoutMs: 1_000 });
    process.stdin.emit("keypress", "", { name: "escape" });
    await expect(promise).rejects.toThrow("cancelled");
  });

  test("selectMany raw-mode Ctrl+C rejects as cancelled", async () => {
    installTtyMock();
    const promise = selectMany("Pick", ["A"], { timeoutMs: 1_000 });
    process.stdin.emit("keypress", "", { ctrl: true, name: "c" });
    await expect(promise).rejects.toThrow("cancelled");
  });

  test("selectOne raw-mode timeout rejects and restores raw mode", async () => {
    const tty = installTtyMock();
    await expect(selectOne("Pick", ["A"], { timeoutMs: 1 })).rejects.toThrow(
      "selection timed out",
    );
    expect(tty.rawModes).toEqual([true, false]);
  });

  test("selectOne raw-mode Enter selects default item", async () => {
    installTtyMock();
    const promise = selectOne("Pick", ["A", "B", "C"], { timeoutMs: 1_000 });
    process.stdin.emit("keypress", "", { name: "return" });
    await expect(promise).resolves.toBe("A");
  });

  test("selectOne raw-mode Arrow Down + Enter selects highlighted item", async () => {
    installTtyMock();
    const promise = selectOne("Pick", ["A", "B", "C"], { timeoutMs: 1_000 });
    process.stdin.emit("keypress", "", { name: "down" });
    process.stdin.emit("keypress", "", { name: "down" });
    process.stdin.emit("keypress", "", { name: "return" });
    await expect(promise).resolves.toBe("C");
  });

  test("selectMany raw-mode toggles with Space and confirms with Enter", async () => {
    installTtyMock();
    const promise = selectMany("Pick", ["A", "B", "C"], { timeoutMs: 1_000 });
    process.stdin.emit("keypress", "", { name: "down" });
    process.stdin.emit("keypress", "", { name: "space" });
    process.stdin.emit("keypress", "", { name: "down" });
    process.stdin.emit("keypress", "", { name: "space" });
    process.stdin.emit("keypress", "", { name: "return" });
    await expect(promise).resolves.toEqual(["B", "C"]);
  });
});

describe("terminal prompts — non-TTY guard (defect #B4)", () => {
  test("textInput rejects fast on non-TTY (within 500ms, not 60s)", async () => {
    installTtyMock({ isTTY: false, stdinChunks: [""] });
    const start = Date.now();
    await expect(textInput("Name")).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("confirmInput rejects fast on non-TTY (within 500ms, not 60s)", async () => {
    installTtyMock({ isTTY: false, stdinChunks: [""] });
    const start = Date.now();
    await expect(confirmInput("Continue?")).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("terminal prompts — keypress listener cleanup (defect #B5)", () => {
  test("selectOne cleanup leaves zero keypress listeners", async () => {
    installTtyMock();
    const before = process.stdin.listenerCount("keypress");
    const promise = selectOne("Pick", ["A"], { timeoutMs: 1_000 });
    process.stdin.emit("keypress", "", { name: "return" });
    await promise;
    expect(process.stdin.listenerCount("keypress")).toBe(before);
  });

  test("selectMany cleanup leaves zero keypress listeners", async () => {
    installTtyMock();
    const before = process.stdin.listenerCount("keypress");
    const promise = selectMany("Pick", ["A", "B"], { timeoutMs: 1_000 });
    process.stdin.emit("keypress", "", { name: "return" });
    await promise;
    expect(process.stdin.listenerCount("keypress")).toBe(before);
  });
});

describe("terminal prompts — SIGINT backstop (defect #B17)", () => {
  test("selectOne registers process.on('exit') raw-mode backstop", async () => {
    installTtyMock();
    const before = process.listenerCount("exit");
    const promise = selectOne("Pick", ["A"], { timeoutMs: 1_000 });
    expect(process.listenerCount("exit")).toBeGreaterThan(before);
    // Cancel so the promise settles and the listener is removed.
    process.stdin.emit("keypress", "", { name: "escape" });
    await expect(promise).rejects.toThrow("cancelled");
    expect(process.listenerCount("exit")).toBe(before);
  });

  test("selectMany registers process.on('exit') raw-mode backstop", async () => {
    installTtyMock();
    const before = process.listenerCount("exit");
    const promise = selectMany("Pick", ["A"], { timeoutMs: 1_000 });
    expect(process.listenerCount("exit")).toBeGreaterThan(before);
    process.stdin.emit("keypress", "", { name: "escape" });
    await expect(promise).rejects.toThrow("cancelled");
    expect(process.listenerCount("exit")).toBe(before);
  });
});
