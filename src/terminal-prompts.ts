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

function normalizeIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return (index + length) % length;
}

/**
 * Test seam: dependencies injected into terminal prompts so unit tests can
 * drive the prompt flow in-process. Production callers leave this undefined
 * and the production implementations (`node:readline` + raw keypress events)
 * are used. The seam is intentionally narrow: only the surfaces that need
 * to be mocked (readLine, isTTY, setRawMode) are exposed. Everything else
 * (render, clearLines, normalizeIndex) is left as pure helpers and is
 * covered by exercising the public functions end-to-end.
 */
export interface TerminalDeps {
  /**
   * Replacement for the readLine fallback used when stdin is not a TTY
   * (or, with `forceReadLine: true`, in TTY mode too). Defaults to
   * `readLineImpl`, the production `node:readline`-backed implementation.
   */
  readLine?: (question: string, defaultValue: string, deps?: TerminalDeps) => Promise<string>;
  /**
   * Override the isTTY check. Defaults to `() => Boolean(process.stdin.isTTY)`.
   * Set to `() => true` to force the raw-mode path in unit tests, or
   * `() => false` to force the readLine fallback.
   */
  isTTY?: () => boolean;
  /**
   * Override stdin.setRawMode. Defaults to `process.stdin.setRawMode`.
   * Useful when the test environment has no setRawMode.
   */
  setRawMode?: ((value: boolean) => void) | null;
  /**
   * Override the SIGINT listener registration. Defaults to registering
   * `process.stdin` directly via `rl.on("SIGINT", ...)`. Tests that
   * have already mocked readLine generally don't need to override this.
   */
  onSigint?: (handler: () => void) => () => void;
  /**
   * Override the EOF ("close" event) listener registration. Defaults
   * to `rl.once("close", ...)`. Tests that have already mocked
   * readLine generally don't need to override this.
   */
  onClose?: (handler: () => void) => () => void;
  /**
   * Override the keypress listener registration. Defaults to
   * `process.stdin.on("keypress", handler)`. Tests can pass
   * `() => () => {}` to suppress keypress wiring entirely when
   * driving via timers.
   */
  onKeypress?: (
    handler: (str: string, key: { name?: string; ctrl?: boolean }) => void,
  ) => () => void;
  /**
   * Override emitKeypressEvents. Defaults to `emitKeypressEvents(process.stdin)`.
   * Set to `() => {}` in tests that don't need keypress events.
   */
  emitKeypressEvents?: (input: NodeJS.ReadableStream) => void;
  /**
   * Override the default keypress handler registration for readLine.
   * `false` (default) means readLine uses the production
   * `rl.question` + `rl.on("SIGINT")` + `rl.once("close")` paths.
   * `true` means readLine is fully mocked by `deps.readLine`.
   */
  forceReadLine?: boolean;
  /**
   * Override the `node:readline` createInterface factory. Defaults to
   * the production `createInterface` from `node:readline`. Used by
   * readLineImpl to allow unit tests to inject a fake readline
   * interface that supports the question/SIGINT/close events.
   */
  createInterface?: typeof createInterface;
}

async function readLineImpl(
  question: string,
  defaultValue = "",
  deps: TerminalDeps = {},
): Promise<string> {
  const createInterfaceFn = deps.createInterface ?? createInterface;
  const rl = createInterfaceFn({ input: process.stdin, output: process.stdout });
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

export async function textInput(
  question: string,
  defaultValue = "",
  deps: TerminalDeps = {},
): Promise<string> {
  return await (deps.readLine ?? readLineImpl)(question, defaultValue, deps);
}

export async function confirmInput(
  question: string,
  defaultValue = false,
  deps: TerminalDeps = {},
): Promise<boolean> {
  if (deps.readLine) {
    const raw = await deps.readLine(question, defaultValue ? "Y" : "N");
    const answer = raw.trim();
    if (!answer) return defaultValue;
    if (/^(y|yes|true|1)$/i.test(answer)) return true;
    if (/^(n|no|false|0)$/i.test(answer)) return false;
    throw new Error("invalid answer");
  }
  const createInterfaceFn = deps.createInterface ?? createInterface;
  const rl = createInterfaceFn({ input: process.stdin, output: process.stdout });
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
  deps: TerminalDeps = {},
): Promise<string> {
  if (options.length === 0 && !opts.allowCustom) {
    throw new Error("selectOne: no options and allowCustom is false");
  }
  const items = selectItems(options, opts);
  const fallback = opts.defaultValue ?? options[0] ?? "";
  const isTty = deps.isTTY ? deps.isTTY() : Boolean(process.stdin.isTTY);
  if (!isTty || deps.setRawMode === null || (!deps.setRawMode && !process.stdin.setRawMode)) {
    return await (deps.readLine ?? readLineImpl)(
      `${question} (${items.map((i) => i.label).join("/")})`,
      fallback,
      deps,
    );
  }

  (deps.emitKeypressEvents ?? emitKeypressEvents)(process.stdin);
  const wasRaw = process.stdin.isRaw ?? false;
  const setRaw =
    deps.setRawMode ?? (process.stdin.setRawMode?.bind(process.stdin) as (v: boolean) => void);

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
    // B18: setRawMode + resume + HIDE_CURSOR must be inside the Promise and
    // wrapped in try/catch. If HIDE_CURSOR write throws (EPIPE / child
    // stdin already closed), the rollback (SHOW_CURSOR + setRawMode(false))
    // must still run, otherwise the parent TTY stays in raw mode with a
    // hidden cursor — the terminal is "frozen" from the user's POV.
    try {
      setRaw(true);
      process.stdin.resume();
      write(HIDE_CURSOR);
    } catch (err) {
      try {
        restoreRawMode(wasRaw, true);
      } catch {
        // rollback is best-effort; original error is what matters
      }
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (deps.onKeypress) {
        offKeypress();
      } else {
        process.stdin.off("keypress", onKeypress);
      }
      restoreRawMode(wasRaw, true);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("selection timed out"));
    }, opts.timeoutMs ?? SELECT_TIMEOUT_MS);
    timer.unref?.();
    const finish = async (value: string, custom: boolean) => {
      cleanup();
      try {
        const answer = custom
          ? await (deps.readLine ?? readLineImpl)(`${question} custom`, fallback, deps)
          : value;
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
    let offKeypress: () => void = () => {};
    if (deps.onKeypress) {
      offKeypress = deps.onKeypress(onKeypress);
    } else {
      process.stdin.on("keypress", onKeypress);
    }
    render();
  });
}

export async function selectMany(
  question: string,
  options: string[],
  opts: SelectOptions = {},
  deps: TerminalDeps = {},
): Promise<string[]> {
  const items = selectItems(options, opts);
  const fallback = opts.defaultValues ?? (options[0] ? [options[0]] : []);
  const isTty = deps.isTTY ? deps.isTTY() : Boolean(process.stdin.isTTY);
  if (!isTty || deps.setRawMode === null || (!deps.setRawMode && !process.stdin.setRawMode)) {
    const raw = await (deps.readLine ?? readLineImpl)(
      `${question} (${items.map((i) => i.label).join(",")})`,
      fallback.join(","),
      deps,
    );
    const values = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return values.length ? values : fallback;
  }

  (deps.emitKeypressEvents ?? emitKeypressEvents)(process.stdin);
  const wasRaw = process.stdin.isRaw ?? false;
  const setRaw =
    deps.setRawMode ?? (process.stdin.setRawMode?.bind(process.stdin) as (v: boolean) => void);

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
    // B18: setRawMode + resume + HIDE_CURSOR must be inside the Promise and
    // wrapped in try/catch (see selectOne for the full rationale).
    try {
      setRaw(true);
      process.stdin.resume();
      write(HIDE_CURSOR);
    } catch (err) {
      try {
        restoreRawMode(wasRaw, true);
      } catch {
        // rollback is best-effort; original error is what matters
      }
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (deps.onKeypress) {
        offKeypress();
      } else {
        process.stdin.off("keypress", onKeypress);
      }
      restoreRawMode(wasRaw, true);
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
          ? await (deps.readLine ?? readLineImpl)(`${question} custom`, fallback.join(","), deps)
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
    let offKeypress: () => void = () => {};
    if (deps.onKeypress) {
      offKeypress = deps.onKeypress(onKeypress);
    } else {
      process.stdin.on("keypress", onKeypress);
    }
    render();
  });
}
