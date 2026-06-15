import { c } from "./core.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// `noUncheckedIndexedAccess` widens SPINNER_FRAMES[N] to `string | undefined`.
// Since the array is a private constant and `i` is always kept in range via
// `% length`, the lookup is always defined. A type assertion (not a
// `??` fallback) keeps the Spinner hot paths branch-free for coverage
// without sacrificing runtime safety.
const frameAt = (i: number): string => SPINNER_FRAMES[i] as string;
const FRAME_FIRST: string = SPINNER_FRAMES[0] as string;

// Read TTY status lazily from process.stderr.isTTY so tests can stub it
// via Object.defineProperty(process.stderr, 'isTTY', ...). The isatty(2)
// syscall is NOT stubbable from JS, so we use the property that the
// Node.js runtime exposes on the stderr stream.
//
// Exposed as a mutable module-level binding so tests can override the
// TTY view without monkey-patching process.stderr. The `isTTY` helper
// reads this binding first and falls back to the real stream property.
let _ttyOverride: boolean | undefined;
export const isTTY = (): boolean => {
  if (_ttyOverride !== undefined) return _ttyOverride;
  return Boolean(process.stderr?.isTTY);
};
/**
 * Test helper: force the TTY view to a specific value for the duration
 * of a test. Pass `undefined` to restore the real stream check.
 */
export const setTtyOverride = (value: boolean | undefined): void => {
  _ttyOverride = value;
};

/* ─── Spinner ─────────────────────────────────────────────────────────────── */

export class Spinner {
  private i = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private msg = "";
  private running = false;

  start(msg: string): void {
    this.msg = msg;
    if (!isTTY()) {
      console.error(`  ${msg}...`);
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      this.i = (this.i + 1) % SPINNER_FRAMES.length;
      this.line(`${c.cyan(frameAt(this.i))} ${this.msg}`);
    }, 80);
    this.line(`${c.cyan(FRAME_FIRST)} ${this.msg}`);
  }

  succeed(msg?: string): void {
    this.stop();
    if (msg) this.msg = msg;
    if (isTTY()) this.line(`${c.green("✔")} ${this.msg}`);
    else console.error(`${c.green("✔")} ${this.msg}`);
  }

  fail(msg?: string): void {
    this.stop();
    if (msg) this.msg = msg;
    if (isTTY()) this.line(`${c.red("✖")} ${this.msg}`);
    else console.error(`${c.red("✖")} ${this.msg}`);
  }

  text(msg: string): void {
    this.msg = msg;
    if (isTTY() && this.running) this.line(`${c.cyan(frameAt(this.i))} ${this.msg}`);
  }

  private stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private line(text: string): void {
    process.stderr.write(`\r\x1b[K${text}`);
  }
}

/* ─── Progress bar ────────────────────────────────────────────────────────── */

export function progressBar(current: number, total: number, width = 24): string {
  const pct = Math.min(1, Math.max(0, total === 0 ? 0 : current / total));
  const filled = Math.round(pct * width);
  const bar = c.green("█".repeat(filled)) + c.dim("░".repeat(width - filled));
  const pctLabel = `${(pct * 100).toString().padStart(3)}%`;
  return `${bar} ${pctLabel}`;
}

/* ─── Table ───────────────────────────────────────────────────────────────── */

export function table(headers: string[], rows: string[][]): string {
  const colW = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const sep = colW.map((w) => "─".repeat(w)).join("─┬─");
  const line = (row: string[]) =>
    ` ${row.map((cell, i) => cell.padEnd(colW[i] ?? 0)).join(" │ ")} `;
  const hdr = line(headers);
  const div = `─${sep}─`;
  const body = rows.map(line).join("\n");
  return `┌${div}┐\n${hdr}\n├${div}┤\n${body}\n└${div}┘`;
}

/* ─── Panel ───────────────────────────────────────────────────────────────── */

export function panel(title: string, body: string, color: (s: string) => string = c.cyan): string {
  const lines = body.split("\n");
  const w = Math.max(...lines.map((l) => l.length), title.length + 4);
  const top = color(`┌─ ${title} ${"─".repeat(Math.max(0, w - title.length - 2))}`);
  const mid = lines.map((l) => color(`│ ${l.padEnd(w)}`)).join("\n");
  const bot = color(`└${"─".repeat(w + 2)}┘`);
  return `${top}\n${mid}\n${bot}`;
}

/* ─── Hyperlink (OSC-8) ────────────────────────────────────────────────────── */

export function link(text: string, url: string): string {
  if (!isTTY()) return `${text} (${url})`;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/* ─── Status line (spinner + trailing stats) ───────────────────────────────── */

export class StatusLine {
  private spinner: Spinner;
  constructor() {
    this.spinner = new Spinner();
  }
  start(msg: string): void {
    this.spinner.start(msg);
  }
  succeed(msg?: string): void {
    this.spinner.succeed(msg);
  }
  fail(msg?: string): void {
    this.spinner.fail(msg);
  }
  text(msg: string, trail?: string): void {
    if (trail) {
      this.spinner.text(`${msg} ${c.dim(`(${trail})`)}`);
    } else {
      this.spinner.text(msg);
    }
  }
}
