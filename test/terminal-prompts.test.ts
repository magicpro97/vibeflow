import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cwd } from "node:process";
import { confirmInput, selectMany, selectOne } from "../src/terminal-prompts.js";

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
