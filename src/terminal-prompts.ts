import { createInterface, emitKeypressEvents } from "node:readline";
import { c } from "./core.js";

const CLEAR_LINE = "\x1b[2K";
const CURSOR_START = "\r";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const SELECT_TIMEOUT_MS = 30_000;
const READLINE_TIMEOUT_MS = 60_000;

function write(text: string): void {
  process.stdout.write(text);
}

function clearLines(count: number): void {
  for (let i = 0; i < count; i++) {
    write("\x1b[1A");
    write(`${CLEAR_LINE}${CURSOR_START}`);
  }
}

function restoreRawMode(wasRaw: boolean, cursorHidden = false): void {
  try {
    process.stdin.setRawMode?.(wasRaw);
  } finally {
    process.stdin.pause();
    if (cursorHidden) write(SHOW_CURSOR);
  }
}

/** B4: throw a clear error when a TTY-only prompt is invoked on a non-TTY stdin.
 *  Today textInput/confirmInput silently fall into readLine and hang for 60s
 *  on a non-interactive stdin (CI, piped scripts). Fail fast instead so the
 *  caller can decide what to do (default, auto-yes, etc.). */
function ensureTtyOrThrow(label: string): void {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    throw new Error(
      `${label}: stdin is not a TTY (setRawMode=${String(process.stdin.setRawMode)}, isTTY=${String(process.stdin.isTTY)}). Provide a default or run interactively.`,
    );
  }
}

function normalizeIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

async function readLine(question: string, defaultValue = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` ${c.dim(`[${defaultValue}]`)}` : "";
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => settle(defaultValue), READLINE_TIMEOUT_MS);
    timer.unref?.();
    const settle = (value: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(value);
    };
    const rejectSettle = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      reject(err);
    };
    rl.question(`${question}${suffix}: `, (answer) => {
      settle(answer.trim() || defaultValue);
    });
    rl.on("SIGINT", () => rejectSettle(new Error("cancelled")));
    rl.once("close", () => settle(defaultValue));
  });
}

export async function textInput(question: string, defaultValue = ""): Promise<string> {
  ensureTtyOrThrow("textInput");
  return await readLine(question, defaultValue);
}

export async function confirmInput(question: string, defaultValue = false): Promise<boolean> {
  ensureTtyOrThrow("confirmInput");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let suffix = "";
    const timer = setTimeout(() => settle(defaultValue), READLINE_TIMEOUT_MS);
    timer.unref?.();
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(value);
    };
    const rejectSettle = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      reject(err);
    };
    const ask = () => {
      rl.question(`${question}${suffix} ${defaultValue ? "(Y/n)" : "(y/N)"}: `, (raw) => {
        const answer = raw.trim();
        if (!answer) settle(defaultValue);
        else if (/^(y|yes|true|1)$/i.test(answer)) settle(true);
        else if (/^(n|no|false|0)$/i.test(answer)) settle(false);
        else {
          suffix = ` ${c.yellow("(answer yes or no)")}`;
          ask();
        }
      });
    };
    rl.on("SIGINT", () => rejectSettle(new Error("cancelled")));
    rl.once("close", () => settle(defaultValue));
    ask();
  });
}

export interface SelectOptions {
  allowCustom?: boolean;
  customLabel?: string;
  defaultValue?: string;
  defaultValues?: string[];
  timeoutMs?: number;
}

interface SelectItem {
  label: string;
  custom: boolean;
}

function selectItems(options: string[], opts: SelectOptions): SelectItem[] {
  const items = options.map((label) => ({ label, custom: false }));
  if (opts.allowCustom) items.push({ label: opts.customLabel ?? "Custom...", custom: true });
  return items;
}

export async function selectOne(
  question: string,
  options: string[],
  opts: SelectOptions = {},
): Promise<string> {
  if (options.length === 0 && !opts.allowCustom) {
    throw new Error("selectOne: no options and allowCustom is false");
  }
  const items = selectItems(options, opts);
  const fallback = opts.defaultValue ?? options[0] ?? "";
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return await readLine(`${question} (${items.map((i) => i.label).join("/")})`, fallback);
  }

  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw ?? false;

  let cursor = 0;
  let renderedLines = 0;

  const render = () => {
    if (renderedLines) clearLines(renderedLines);
    const lines = [
      `${c.bold(question)} ${c.dim("(↑/↓ move, Enter select, Ctrl+C cancel)")}`,
      ...items.map((item, idx) => `${idx === cursor ? c.cyan("›") : " "} ${item.label}`),
    ];
    renderedLines = lines.length;
    write(`${lines.join("\n")}\n`);
  };

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    // B18: setRawMode + resume + HIDE_CURSOR must be inside the Promise
    // executor with try/catch so a failure in ANY of the three rolls back
    // gracefully (call restoreRawMode + SHOW_CURSOR, reject) instead of
    // leaving the terminal stuck in raw mode with the cursor hidden and
    // a never-settling Promise.
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      write(HIDE_CURSOR);
    } catch (err) {
      try { restoreRawMode(wasRaw, true); } catch { /* ignore */ }
      reject(err);
      return;
    }

    // B17: SIGINT/synchronous-exit backstop. If the process dies before
    // cleanup() runs (parent SIGINT, uncaught throw, OOM), the raw-mode +
    // hidden-cursor state would leak. Register a process-exit handler that
    // restores raw mode + shows the cursor, and unregister it in cleanup.
    const exitHandler = () => {
      try {
        restoreRawMode(wasRaw, true);
      } catch {
        // best-effort: never throw from a process-exit handler
      }
    };
    process.on("exit", exitHandler);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.stdin.off("keypress", onKeypress);
      process.off("exit", exitHandler);
      restoreRawMode(wasRaw, true);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("selection timed out"));
    }, opts.timeoutMs ?? SELECT_TIMEOUT_MS);
    timer.unref?.();
    const finish = async (value: string, custom: boolean) => {
      cleanup();
      try {
        const answer = custom ? await readLine(`${question} custom`, fallback) : value;
        resolve(answer || fallback);
      } catch (err) {
        reject(err);
      }
    };
    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("cancelled"));
        return;
      }
      if (key.name === "escape") {
        cleanup();
        reject(new Error("cancelled"));
        return;
      }
      if (key.name === "up") cursor = normalizeIndex(cursor - 1, items.length);
      else if (key.name === "down") cursor = normalizeIndex(cursor + 1, items.length);
      else if (key.name === "return") {
        const item = items[cursor];
        if (item) void finish(item.label, item.custom);
        return;
      }
      render();
    };
    process.stdin.on("keypress", onKeypress);
    render();
  });
}

export async function selectMany(
  question: string,
  options: string[],
  opts: SelectOptions = {},
): Promise<string[]> {
  const items = selectItems(options, opts);
  const fallback = opts.defaultValues ?? (options[0] ? [options[0]] : []);
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    const raw = await readLine(
      `${question} (${items.map((i) => i.label).join(",")})`,
      fallback.join(","),
    );
    const values = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return values.length ? values : fallback;
  }

  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw ?? false;

  let cursor = 0;
  let renderedLines = 0;
  const selected = new Set<number>();

  const render = () => {
    if (renderedLines) clearLines(renderedLines);
    const lines = [
      `${c.bold(question)} ${c.dim("(↑/↓ move, Space toggle, Enter confirm, Ctrl+C cancel)")}`,
      ...items.map((item, idx) => {
        const mark = selected.has(idx) ? "●" : "○";
        return `${idx === cursor ? c.cyan("›") : " "} ${mark} ${item.label}`;
      }),
    ];
    renderedLines = lines.length;
    write(`${lines.join("\n")}\n`);
  };

  return await new Promise<string[]>((resolve, reject) => {
    let settled = false;
    // B18: see selectOne — setRawMode + resume + HIDE_CURSOR must be inside
    // the Promise executor with one try/catch so any failure rolls back.
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      write(HIDE_CURSOR);
    } catch (err) {
      try { restoreRawMode(wasRaw, true); } catch { /* ignore */ }
      reject(err);
      return;
    }

    // B17: SIGINT/synchronous-exit backstop — see selectOne.
    const exitHandler = () => {
      try {
        restoreRawMode(wasRaw, true);
      } catch {
        // best-effort
      }
    };
    process.on("exit", exitHandler);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.stdin.off("keypress", onKeypress);
      process.off("exit", exitHandler);
      restoreRawMode(wasRaw, true);
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("selection timed out"));
    }, opts.timeoutMs ?? SELECT_TIMEOUT_MS);
    timer.unref?.();
    const finish = async () => {
      const picked = [...selected]
        .map((idx) => items[idx])
        .filter((i): i is SelectItem => Boolean(i));
      cleanup();
      try {
        const custom = picked.some((item) => item.custom)
          ? await readLine(`${question} custom`, fallback.join(","))
          : "";
        const values = [
          ...picked.filter((item) => !item.custom).map((item) => item.label),
          ...custom
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ];
        resolve(values.length ? values : fallback);
      } catch (err) {
        reject(err);
      }
    };
    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("cancelled"));
        return;
      }
      if (key.name === "escape") {
        cleanup();
        reject(new Error("cancelled"));
        return;
      }
      if (key.name === "up") cursor = normalizeIndex(cursor - 1, items.length);
      else if (key.name === "down") cursor = normalizeIndex(cursor + 1, items.length);
      else if (key.name === "space") {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
      } else if (key.name === "return") {
        void finish();
        return;
      }
      render();
    };
    process.stdin.on("keypress", onKeypress);
    render();
  });
}
