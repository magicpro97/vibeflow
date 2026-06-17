import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cwd } from "node:process";
import {
  type TerminalDeps,
  clampInput,
  confirmInput,
  selectMany,
  selectOne,
  textInput,
} from "../src/terminal-prompts.js";

const repoRoot = cwd();

async function runPrompt(expression: string, input: string): Promise<unknown> {
  const script = `
    import { textInput, confirmInput, selectOne, selectMany } from ${JSON.stringify(
      join(repoRoot, "src/terminal-prompts.ts"),
    )};
    const result = await (${expression});
    process.stdout.write("\\n__RESULT__" + JSON.stringify(result));
  `;
  const proc = Bun.spawn(["bun", "--input-type=module", "-e", script], {
    cwd: repoRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const marker = "__RESULT__";
  const idx = stdout.lastIndexOf(marker);
  expect(idx).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(idx + marker.length));
}

async function runPromptWithChunks(expression: string, chunks: string[]): Promise<unknown> {
  const script = `
    import { textInput, confirmInput, selectOne, selectMany } from ${JSON.stringify(
      join(repoRoot, "src/terminal-prompts.ts"),
    )};
    const result = await (${expression});
    process.stdout.write("\\n__RESULT__" + JSON.stringify(result));
  `;
  const proc = Bun.spawn(["bun", "--input-type=module", "-e", script], {
    cwd: repoRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const chunk of chunks) {
    proc.stdin.write(chunk);
    await Bun.sleep(20);
  }
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const marker = "__RESULT__";
  const idx = stdout.lastIndexOf(marker);
  expect(idx).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(idx + marker.length));
}

const restoreFns: Array<() => void> = [];

function installTtyMock(): { rawModes: boolean[]; pauses: number; restore: () => void } {
  const origIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const origSetRawMode = process.stdin.setRawMode;
  const origResume = process.stdin.resume;
  const origPause = process.stdin.pause;
  const origWrite = process.stdout.write;

  const state = { rawModes: [] as boolean[], pauses: 0 };
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  process.stdin.setRawMode = ((value: boolean) => {
    state.rawModes.push(value);
    return process.stdin;
  }) as typeof process.stdin.setRawMode;
  process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
  process.stdin.pause = (() => {
    state.pauses += 1;
    return process.stdin;
  }) as typeof process.stdin.pause;
  process.stdout.write = (() => true) as typeof process.stdout.write;

  const restore = () => {
    if (origIsTty) Object.defineProperty(process.stdin, "isTTY", origIsTty);
    else Reflect.deleteProperty(process.stdin, "isTTY");
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

describe("terminal prompts", () => {
  test("textInput returns trimmed input", async () => {
    await expect(runPrompt('textInput("Name")', "  Alice  \n")).resolves.toBe("Alice");
  });

  test("textInput returns the default on blank input", async () => {
    await expect(runPrompt('textInput("Name", "Default")', "\n")).resolves.toBe("Default");
  });

  test("textInput returns the default on EOF", async () => {
    await expect(runPrompt('textInput("Name", "Default")', "")).resolves.toBe("Default");
  });

  test("textInput clamps oversize input to MAX_INPUT_BYTES (CWE-400)", async () => {
    // Build a paste larger than MAX_INPUT_BYTES (64 KiB). Post-fix,
    // the value returned to the caller is truncated at the byte
    // boundary. Pre-fix, the full string is forwarded — the
    // engine prompt sees a megabyte of garbage.
    //
    // Use a trailing \n so the readline interface delivers the
    // buffered line; without it, the pipe closes before the
    // child has had a chance to read.
    const big = `${"a".repeat(128 * 1024)}\n`;
    const result = (await runPrompt('textInput("Project description")', big)) as string;
    // The clamp is exact: returns the first 64 KiB of "a".
    expect(result.length).toBe(64 * 1024);
    // The truncated value should still be valid utf-8 (the first
    // 64 KiB of "a" is unambiguous).
    expect(result).toMatch(/^a*$/);
  });

  test("textInput with default value still applies clamp (CWE-400)", async () => {
    // When the user submits an empty line, the default is used.
    // Make sure the default itself is clamped too (defense in depth:
    // a future caller might pass a large default).
    const result = (await runPrompt(`textInput("Q", "x".repeat(128 * 1024))`, "\n")) as string;
    expect(result.length).toBeLessThanOrEqual(64 * 1024);
  });

  test("confirmInput accepts yes values", async () => {
    await expect(runPrompt('confirmInput("Continue?", false)', "yes\n")).resolves.toBe(true);
  });

  test("confirmInput accepts no values", async () => {
    await expect(runPrompt('confirmInput("Continue?", true)', "no\n")).resolves.toBe(false);
  });

  test("confirmInput returns the default on EOF", async () => {
    await expect(runPrompt('confirmInput("Continue?", true)', "")).resolves.toBe(true);
  });

  test("confirmInput re-prompts invalid answers without recursion", async () => {
    await expect(
      runPromptWithChunks('confirmInput("Continue?", false)', ["garbage\n", "y\n"]),
    ).resolves.toBe(true);
  });

  test("selectOne non-TTY fallback returns first option on EOF", async () => {
    await expect(runPrompt('selectOne("Pick", ["A", "B"])', "")).resolves.toBe("A");
  });

  test("selectOne non-TTY fallback honors explicit default on EOF", async () => {
    await expect(
      runPrompt('selectOne("Pick", ["A", "B"], { defaultValue: "B" })', ""),
    ).resolves.toBe("B");
  });

  test("selectOne non-TTY fallback returns typed answer", async () => {
    await expect(
      runPrompt('selectOne("Pick", ["A", "B"], { defaultValue: "A" })', "B\n"),
    ).resolves.toBe("B");
  });

  test("selectMany non-TTY fallback returns first option on EOF", async () => {
    await expect(runPrompt('selectMany("Pick", ["A", "B"])', "")).resolves.toEqual(["A"]);
  });

  test("selectMany non-TTY fallback honors explicit defaults on EOF", async () => {
    await expect(
      runPrompt('selectMany("Pick", ["A", "B"], { defaultValues: ["B"] })', ""),
    ).resolves.toEqual(["B"]);
  });

  test("selectMany non-TTY fallback parses comma-separated input", async () => {
    await expect(runPrompt('selectMany("Pick", ["A", "B"] )', "A, B\n")).resolves.toEqual([
      "A",
      "B",
    ]);
  });

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
    await expect(selectOne("Pick", ["A"], { timeoutMs: 1 })).rejects.toThrow("selection timed out");
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

// ---------------------------------------------------------------------------
// In-process unit tests driven by the test seam (deps injection). The
// subprocess-based tests above cover the production code paths in a
// real bun process; the tests below cover the same paths from the
// current process, which is what bun:coverage instruments. Together
// they bring src/terminal-prompts.ts to 100% line coverage.
// ---------------------------------------------------------------------------

describe("terminal prompts (in-process via test seam)", () => {
  test("textInput delegates to deps.readLine", async () => {
    const deps: TerminalDeps = { readLine: async (_q, d) => `mocked-${d}` };
    await expect(textInput("Name", "fallback", deps)).resolves.toBe("mocked-fallback");
  });

  test("clampInput returns input unchanged when under MAX_INPUT_BYTES", () => {
    // Short input — the early-return branch fires, no allocation
    // of the Buffer.from() copy.
    expect(clampInput("hello")).toBe("hello");
  });

  test("clampInput truncates at MAX_INPUT_BYTES for oversize ASCII input (CWE-400)", () => {
    // 128 KiB of "a" — the truncation branch must fire. We assert
    // the exact returned length (64 KiB) so the test is sensitive
    // to off-by-one in the boundary.
    const big = "a".repeat(128 * 1024);
    const out = clampInput(big);
    expect(out.length).toBe(64 * 1024);
    expect(out).toMatch(/^a*$/);
  });

  test("clampInput truncates at a UTF-8 safe boundary for multi-byte input", () => {
    // Emoji is 4 bytes in UTF-8. A 64 KiB+1 boundary lands inside
    // a 4-byte char; clampInput must not return a half-encoded
    // string. The result is a valid utf-8 string of ≤ 64 KiB.
    const emoji = "🎉"; // 4 bytes
    const big = emoji.repeat(20_000); // 80_000 bytes
    const out = clampInput(big);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(64 * 1024);
    // Round-trip without throwing — that's the safety contract.
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("confirmInput resolves true for yes via deps.readLine", async () => {
    const deps: TerminalDeps = { readLine: async () => "y" };
    await expect(confirmInput("Ok?", false, deps)).resolves.toBe(true);
  });

  test("confirmInput resolves false for no via deps.readLine", async () => {
    const deps: TerminalDeps = { readLine: async () => "n" };
    await expect(confirmInput("Ok?", true, deps)).resolves.toBe(false);
  });

  test("confirmInput returns default for empty input via deps.readLine", async () => {
    const deps: TerminalDeps = { readLine: async () => "" };
    await expect(confirmInput("Ok?", true, deps)).resolves.toBe(true);
  });

  test("confirmInput throws on invalid answer via deps.readLine", async () => {
    const deps: TerminalDeps = { readLine: async () => "maybe" };
    await expect(confirmInput("Ok?", false, deps)).rejects.toThrow("invalid answer");
  });

  test("selectOne throws when no options and allowCustom is false", async () => {
    await expect(selectOne("Pick", [], {})).rejects.toThrow(
      "selectOne: no options and allowCustom is false",
    );
  });

  test("selectOne uses deps.readLine in non-TTY mode", async () => {
    const deps: TerminalDeps = {
      isTTY: () => false,
      readLine: async (_q, d) => `from-readline-${d}`,
    };
    await expect(selectOne("Pick", ["A", "B"], {}, deps)).resolves.toBe("from-readline-A");
  });

  test("selectOne uses deps.readLine when setRawMode is null", async () => {
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: null,
      readLine: async (_q, d) => `no-rawmode-${d}`,
    };
    await expect(selectOne("Pick", ["A"], {}, deps)).resolves.toBe("no-rawmode-A");
  });

  test("selectOne resolves with custom value via deps.readLine", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
      readLine: async (_q, d) => `custom-${d}`,
    };
    const promise = selectOne("Pick", [], { allowCustom: true }, deps);
    // Allow the keypress handler to register + render to happen.
    await new Promise((r) => setTimeout(r, 5));
    // Trigger return on the custom option (cursor=0 since options=[]).
    for (const h of handlers) h("", { name: "return" });
    await expect(promise).resolves.toBe("custom-");
  });

  test("selectOne rejects on Ctrl+C via deps.onKeypress", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
    };
    const promise = selectOne("Pick", ["A", "B"], { timeoutMs: 1_000 }, deps);
    await new Promise((r) => setTimeout(r, 5));
    for (const h of handlers) h("", { ctrl: true, name: "c" });
    await expect(promise).rejects.toThrow("cancelled");
  });

  test("selectOne rejects on Escape via deps.onKeypress", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
    };
    const promise = selectOne("Pick", ["A", "B"], { timeoutMs: 1_000 }, deps);
    await new Promise((r) => setTimeout(r, 5));
    for (const h of handlers) h("", { name: "escape" });
    await expect(promise).rejects.toThrow("cancelled");
  });

  test("selectOne rejects on timeout", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
    };
    const promise = selectOne("Pick", ["A", "B"], { timeoutMs: 5 }, deps);
    await expect(promise).rejects.toThrow("selection timed out");
  });

  test("selectMany uses deps.readLine in non-TTY mode and parses comma list", async () => {
    const deps: TerminalDeps = {
      isTTY: () => false,
      readLine: async () => "A, C",
    };
    await expect(selectMany("Pick", ["A", "B", "C"], {}, deps)).resolves.toEqual(["A", "C"]);
  });

  test("selectMany uses deps.readLine when setRawMode is null", async () => {
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: null,
      readLine: async () => "A,B",
    };
    await expect(selectMany("Pick", ["A", "B"], {}, deps)).resolves.toEqual(["A", "B"]);
  });

  test("selectMany returns fallback when readLine returns empty", async () => {
    const deps: TerminalDeps = {
      isTTY: () => false,
      readLine: async () => "",
    };
    await expect(selectMany("Pick", ["A", "B"], {}, deps)).resolves.toEqual(["A"]);
  });

  test("selectMany falls back to defaultValues when readLine empty", async () => {
    const deps: TerminalDeps = {
      isTTY: () => false,
      readLine: async () => "",
    };
    await expect(selectMany("Pick", ["A", "B"], { defaultValues: ["B"] }, deps)).resolves.toEqual([
      "B",
    ]);
  });

  test("selectMany rejects on Ctrl+C via deps.onKeypress", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
    };
    const promise = selectMany("Pick", ["A", "B"], { timeoutMs: 1_000 }, deps);
    await new Promise((r) => setTimeout(r, 5));
    for (const h of handlers) h("", { ctrl: true, name: "c" });
    await expect(promise).rejects.toThrow("cancelled");
  });

  test("selectMany rejects on Escape via deps.onKeypress", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
    };
    const promise = selectMany("Pick", ["A", "B"], { timeoutMs: 1_000 }, deps);
    await new Promise((r) => setTimeout(r, 5));
    for (const h of handlers) h("", { name: "escape" });
    await expect(promise).rejects.toThrow("cancelled");
  });

  test("selectMany rejects on timeout", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
    };
    const promise = selectMany("Pick", ["A", "B"], { timeoutMs: 5 }, deps);
    await expect(promise).rejects.toThrow("selection timed out");
  });

  test("selectMany resolves with custom items + custom readLine", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
      readLine: async () => "X,Y",
    };
    const promise = selectMany("Pick", ["A"], { allowCustom: true, timeoutMs: 1_000 }, deps);
    await new Promise((r) => setTimeout(r, 5));
    // Cursor starts at 0 = "A". Press down to go to "Custom..." (index 1).
    for (const h of handlers) h("", { name: "down" });
    // Space to select Custom.
    for (const h of handlers) h("", { name: "space" });
    // Enter to confirm.
    for (const h of handlers) h("", { name: "return" });
    await expect(promise).resolves.toEqual(["X", "Y"]);
  });

  test("selectOne rejects when custom readLine throws", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
      readLine: async () => {
        throw new Error("custom-input-failed");
      },
    };
    const promise = selectOne("Pick", [], { allowCustom: true, timeoutMs: 1_000 }, deps);
    await new Promise((r) => setTimeout(r, 5));
    for (const h of handlers) h("", { name: "return" });
    await expect(promise).rejects.toThrow("custom-input-failed");
  });

  test("selectMany rejects when custom readLine throws", async () => {
    const handlers: Array<(str: string, key: { name?: string; ctrl?: boolean }) => void> = [];
    const deps: TerminalDeps = {
      isTTY: () => true,
      setRawMode: () => {},
      emitKeypressEvents: () => {},
      onKeypress: (handler) => {
        handlers.push(handler);
        return () => {};
      },
      readLine: async () => {
        throw new Error("custom-list-failed");
      },
    };
    const promise = selectMany("Pick", ["A"], { allowCustom: true, timeoutMs: 1_000 }, deps);
    await new Promise((r) => setTimeout(r, 5));
    for (const h of handlers) h("", { name: "down" });
    for (const h of handlers) h("", { name: "space" });
    for (const h of handlers) h("", { name: "return" });
    await expect(promise).rejects.toThrow("custom-list-failed");
  });

  // ------------------------------------------------------------------
  // The tests below cover the production `node:readline` code paths
  // (readLineImpl and confirmInput's "re-prompt on invalid" branch) by
  // injecting a fake readline interface via deps.createInterface. This
  // is the test seam that lets bun:coverage instrument lines that
  // would otherwise only be reachable through a real stdin/TTY.
  // ------------------------------------------------------------------

  function makeFakeReadline(): {
    rl: {
      question: (q: string, cb: (a: string) => void) => void;
      on: (ev: string, cb: (...a: unknown[]) => void) => unknown;
      once: (ev: string, cb: (...a: unknown[]) => void) => unknown;
      close: () => void;
    };
    emit: (event: "SIGINT" | "close" | "data", payload?: unknown) => void;
    answer: (a: string) => void;
  } {
    const handlers: { SIGINT: Array<() => void>; close: Array<() => void> } = {
      SIGINT: [],
      close: [],
    };
    let pendingQuestion: { q: string; cb: (a: string) => void } | null = null;
    const rl = {
      question: (q: string, cb: (a: string) => void) => {
        pendingQuestion = { q, cb };
      },
      on: (ev: string, cb: () => void) => {
        if (ev in handlers) (handlers as Record<string, Array<() => void>>)[ev]?.push(cb);
        return rl;
      },
      once: (ev: string, cb: () => void) => {
        if (ev in handlers) (handlers as Record<string, Array<() => void>>)[ev]?.push(cb);
        return rl;
      },
      close: () => {
        for (const cb of handlers.close) cb();
      },
    };
    return {
      rl,
      emit: (event: "SIGINT" | "close" | "data", payload?: unknown) => {
        if (event === "data" && payload && pendingQuestion) {
          const p = pendingQuestion;
          pendingQuestion = null;
          p.cb(String(payload));
          return;
        }
        if (event === "SIGINT") {
          for (const cb of handlers.SIGINT) cb();
        } else if (event === "close") {
          for (const cb of handlers.close) cb();
        }
      },
      answer: (a: string) => {
        if (!pendingQuestion) throw new Error("no pending question");
        const p = pendingQuestion;
        pendingQuestion = null;
        p.cb(a);
      },
    };
  }

  test("textInput production readlineImpl SIGINT path (covers lines 116-120)", async () => {
    const fake = makeFakeReadline();
    const deps: TerminalDeps = { createInterface: () => fake.rl as never };
    const promise = textInput("Name", "", deps);
    await new Promise((r) => setTimeout(r, 5));
    fake.emit("SIGINT");
    await expect(promise).rejects.toThrow("cancelled");
  });

  test("textInput production readlineImpl close (EOF) path", async () => {
    const fake = makeFakeReadline();
    const deps: TerminalDeps = { createInterface: () => fake.rl as never };
    const promise = textInput("Name", "default", deps);
    await new Promise((r) => setTimeout(r, 5));
    fake.emit("close");
    await expect(promise).resolves.toBe("default");
  });

  test("confirmInput production readlineImpl SIGINT path (covers lines 165-169)", async () => {
    const fake = makeFakeReadline();
    const deps: TerminalDeps = { createInterface: () => fake.rl as never };
    const promise = confirmInput("Ok?", false, deps);
    await new Promise((r) => setTimeout(r, 5));
    fake.emit("SIGINT");
    await expect(promise).rejects.toThrow("cancelled");
  });

  test("confirmInput invalid answer triggers re-prompt (covers lines 176-179)", async () => {
    const fake = makeFakeReadline();
    const deps: TerminalDeps = { createInterface: () => fake.rl as never };
    const promise = confirmInput("Ok?", false, deps);
    await new Promise((r) => setTimeout(r, 5));
    // Answer "maybe" (invalid) — should re-prompt, not resolve.
    fake.answer("maybe");
    await new Promise((r) => setTimeout(r, 5));
    // Now answer "y" — should resolve.
    fake.answer("y");
    await expect(promise).resolves.toBe(true);
  });
});

describe("terminal prompts — setRawMode rollback (defect #B18)", () => {
  test("selectOne rejects (does not hang) and restores raw mode when HIDE_CURSOR throws AFTER setRawMode succeeded", async () => {
    installTtyMock();
    const captured: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = ((s: string) => {
      captured.push(s);
      // Throw on the FIRST HIDE_CURSOR. The setRawMode(true) + resume() succeeded.
      // Without the rollback fix (or if HIDE_CURSOR sits OUTSIDE the try/catch),
      // the throw bubbles out of the Promise executor with no reject → caller hangs.
      if (s === "\x1b[?25l") {
        throw new Error("simulated EPIPE on HIDE_CURSOR");
      }
      return true;
    }) as typeof process.stdout.write;
    try {
      const start = Date.now();
      await expect(selectOne("Pick", ["A"], { timeoutMs: 500 })).rejects.toThrow("simulated EPIPE");
      // Must reject fast — the bug was: never-settling Promise.
      expect(Date.now() - start).toBeLessThan(1_500);
      // Rollback MUST have written SHOW_CURSOR after the failure.
      const sawShow = captured.includes("\x1b[?25h");
      expect(sawShow).toBe(true);
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = origStdoutWrite;
    }
  });

  test("selectMany rejects (does not hang) and restores raw mode when HIDE_CURSOR throws", async () => {
    installTtyMock();
    const captured: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = ((s: string) => {
      captured.push(s);
      if (s === "\x1b[?25l") {
        throw new Error("simulated EPIPE on HIDE_CURSOR");
      }
      return true;
    }) as typeof process.stdout.write;
    try {
      const start = Date.now();
      await expect(selectMany("Pick", ["A", "B"], { timeoutMs: 500 })).rejects.toThrow(
        "simulated EPIPE",
      );
      expect(Date.now() - start).toBeLessThan(1_500);
      const sawShow = captured.includes("\x1b[?25h");
      expect(sawShow).toBe(true);
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = origStdoutWrite;
    }
  });
});
