import { c } from "./core.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Read TTY status lazily from process.stderr.isTTY so tests can stub it
// via Object.defineProperty(process.stderr, 'isTTY', ...). The isatty(2)
// syscall is NOT stubbable from JS, so we use the property that the
// Node.js runtime exposes on the stderr stream.
const TTY = (): boolean => Boolean(process.stderr?.isTTY);

/* ─── Global spinner tracker ─────────────────────────────────────────────── */

export let activeSpinner: Spinner | null = null;
/** @internal reset for tests */
export function resetActiveSpinner(): void {
  activeSpinner = null;
}

/* ─── Spinner ─────────────────────────────────────────────────────────────── */

export class Spinner {
  private i = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private msg = "";
  private running = false;

  start(msg: string): void {
    this.msg = msg;
    if (!TTY()) {
      console.error(`  ${msg}...`);
      return;
    }
    this.running = true;
    activeSpinner = this;
    this.timer = setInterval(() => {
      this.i = (this.i + 1) % SPINNER_FRAMES.length;
      this.line(`${c.cyan(SPINNER_FRAMES[this.i] ?? "")} ${this.msg}`);
    }, 80);
    this.line(`${c.cyan(SPINNER_FRAMES[0] ?? "")} ${this.msg}`);
  }

  succeed(msg?: string): void {
    this.stop();
    if (msg) this.msg = msg;
    if (TTY()) this.line(`${c.green("✔")} ${this.msg}`);
    else console.error(`${c.green("✔")} ${this.msg}`);
  }

  fail(msg?: string): void {
    this.stop();
    if (msg) this.msg = msg;
    if (TTY()) this.line(`${c.red("✖")} ${this.msg}`);
    else console.error(`${c.red("✖")} ${this.msg}`);
  }

  /** Stop animation so logs can write cleanly without spinner interference. */
  deactivate(): void {
    this.stop();
    process.stderr.write("\r\x1b[K");
  }

  text(msg: string): void {
    this.msg = msg;
    if (TTY() && this.running) this.line(`${c.cyan(SPINNER_FRAMES[this.i] ?? "")} ${this.msg}`);
  }

  private stop(): void {
    this.running = false;
    activeSpinner = null;
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
  if (!TTY()) return `${text} (${url})`;
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
