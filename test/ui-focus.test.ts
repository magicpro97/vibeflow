import { describe, expect, test } from "bun:test";
import { focusTerminal, maybeFocus } from "../src/ui-focus.js";

describe("focusTerminal", () => {
  test("darwin + iTerm.app → osascript iTerm", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    focusTerminal({
      platform: "darwin",
      termProgram: "iTerm.app",
      run: (cmd, args) => calls.push({ cmd, args }),
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.cmd).toBe("osascript");
    expect(calls[0]?.args.join(" ")).toContain('tell application "iTerm" to activate');
  });

  test("darwin + Apple_Terminal → osascript Terminal", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    focusTerminal({
      platform: "darwin",
      termProgram: "Apple_Terminal",
      run: (cmd, args) => calls.push({ cmd, args }),
    });
    expect(calls.length).toBe(1);
    expect(calls[0]?.cmd).toBe("osascript");
    expect(calls[0]?.args.join(" ")).toContain('tell application "Terminal" to activate');
  });

  test("darwin + undefined termProgram → defaults to Terminal (env cleared)", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const saved = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = undefined;
    try {
      focusTerminal({
        platform: "darwin",
        termProgram: undefined,
        run: (cmd, args) => calls.push({ cmd, args }),
      });
    } finally {
      if (saved !== undefined) process.env.TERM_PROGRAM = saved;
    }
    expect(calls.length).toBe(1);
    expect(calls[0]?.args.join(" ")).toContain('tell application "Terminal" to activate');
  });

  test("linux → no-op (spy never called)", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    focusTerminal({
      platform: "linux",
      run: (cmd, args) => calls.push({ cmd, args }),
    });
    expect(calls.length).toBe(0);
  });

  test("win32 → no-op (spy never called)", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    focusTerminal({
      platform: "win32",
      run: (cmd, args) => calls.push({ cmd, args }),
    });
    expect(calls.length).toBe(0);
  });

  test("no inject → uses real platform (coverage safety)", () => {
    // Should not throw; real platform may or may not spawn.
    expect(() => focusTerminal()).not.toThrow();
  });

  test("darwin + no inject.run → default spawnSync path (line 15)", () => {
    // Forces darwin path without injecting run so default spawnSync executes.
    // On non-darwin hosts osascript won't exist; spawnSync silently fails w/ stdio:ignore.
    expect(() =>
      focusTerminal({ platform: "darwin", termProgram: "iTerm.app" }),
    ).not.toThrow();
  });

  test("darwin + no inject.run + undefined termProgram → default spawnSync + Terminal fallback", () => {
    expect(() =>
      focusTerminal({ platform: "darwin", termProgram: undefined }),
    ).not.toThrow();
  });
});

describe("maybeFocus", () => {
  test("focus=true + isTTY=true + darwin → calls focusTerminal", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    maybeFocus(
      { focus: true, isTTY: true },
      {
        platform: "darwin",
        termProgram: "iTerm.app",
        run: (cmd, args) => calls.push({ cmd, args }),
      },
    );
    expect(calls.length).toBe(1);
  });

  test("focus=true + isTTY=false → no-op", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    maybeFocus(
      { focus: true, isTTY: false },
      {
        platform: "darwin",
        run: (cmd, args) => calls.push({ cmd, args }),
      },
    );
    expect(calls.length).toBe(0);
  });

  test("focus=false + isTTY=true → no-op", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    maybeFocus(
      { focus: false, isTTY: true },
      {
        platform: "darwin",
        run: (cmd, args) => calls.push({ cmd, args }),
      },
    );
    expect(calls.length).toBe(0);
  });

  test("focus=true + isTTY=true + linux → no-op", () => {
    const calls: { cmd: string; args: string[] }[] = [];
    maybeFocus(
      { focus: true, isTTY: true },
      {
        platform: "linux",
        run: (cmd, args) => calls.push({ cmd, args }),
      },
    );
    expect(calls.length).toBe(0);
  });
});
