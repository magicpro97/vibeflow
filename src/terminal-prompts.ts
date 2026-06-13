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

function restoreRawMode(wasRaw: boolean): void {
  process.stdin.setRawMode?.(wasRaw);
  process.stdin.pause();
  write(SHOW_CURSOR);
}

function normalizeIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

async function readLine(question: string, defaultValue = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` ${c.dim(`[${defaultValue}]`)}` : "";
  return await new Promise<string>((resolve) => {
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
    rl.question(`${question}${suffix}: `, (answer) => {
      settle(answer.trim() || defaultValue);
    });
    rl.once("close", () => settle(defaultValue));
  });
}

export async function textInput(question: string, defaultValue = ""): Promise<string> {
  return await readLine(question, defaultValue);
}

export async function confirmInput(question: string, defaultValue = false): Promise<boolean> {
  const answer = (await readLine(`${question} ${defaultValue ? "(Y/n)" : "(y/N)"}`)).trim();
  if (!answer) return defaultValue;
  if (/^(y|yes|true|1)$/i.test(answer)) return true;
  if (/^(n|no|false|0)$/i.test(answer)) return false;
  return await confirmInput(`${question} ${c.yellow("(answer yes or no)")}`, defaultValue);
}

export interface SelectOptions {
  allowCustom?: boolean;
  customLabel?: string;
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
  const items = selectItems(options, opts);
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    return await readLine(`${question} (${items.map((i) => i.label).join("/")})`);
  }

  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw ?? false;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  write(HIDE_CURSOR);

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
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("keypress", onKeypress);
      restoreRawMode(wasRaw);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("selection timed out"));
    }, opts.timeoutMs ?? SELECT_TIMEOUT_MS);
    timer.unref?.();
    const finish = async (value: string, custom: boolean) => {
      cleanup();
      try {
        resolve(custom ? await readLine(`${question} custom`) : value);
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
  if (!process.stdin.isTTY || !process.stdin.setRawMode) {
    const raw = await readLine(`${question} (${items.map((i) => i.label).join(",")})`);
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw ?? false;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  write(HIDE_CURSOR);

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
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off("keypress", onKeypress);
      restoreRawMode(wasRaw);
    };
    const timer = setTimeout(() => {
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
          ? await readLine(`${question} custom`)
          : "";
        resolve([
          ...picked.filter((item) => !item.custom).map((item) => item.label),
          ...custom
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        ]);
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
