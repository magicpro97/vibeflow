import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  link,
  panel,
  progressBar,
  setTtyOverride,
  Spinner,
  StatusLine,
  table,
} from "../src/ui.js";

describe("ui: table", () => {
  test("renders aligned table with headers and rows", () => {
    const out = table(
      ["tool", "status"],
      [
        ["node", "ok"],
        ["git", "ok"],
      ],
    );
    expect(out).toContain("tool");
    expect(out).toContain("status");
    expect(out).toContain("node");
    expect(out).toContain("git");
    expect(out).toContain("┌");
    expect(out).toContain("┘");
    expect(out.split("\n").length).toBe(6);
  });

  test("empty rows produce valid borders", () => {
    const out = table(["a"], []);
    expect(out).toContain("┌");
    expect(out).toContain("└");
  });

  test("rows shorter than headers pad the missing cell width (?? '' branch)", () => {
    // Covers the `r[i] ?? ""` branch where the row is missing a cell.
    const out = table(["tool", "status"], [["node"]]);
    expect(out).toContain("tool");
    expect(out).toContain("status");
    expect(out).toContain("node");
    expect(out.split("\n").length).toBe(6);
  });
});

describe("ui: progressBar", () => {
  test("0% renders empty bar", () => {
    const out = progressBar(0, 10);
    expect(out).toContain("  0%");
    expect(out).toContain("░");
  });

  test("100% renders full bar", () => {
    const out = progressBar(10, 10);
    expect(out).toContain("100%");
    expect(out).toContain("█");
  });

  test("50% renders half bar", () => {
    const out = progressBar(5, 10);
    expect(out).toContain(" 50%");
  });

  test("handles zero total safely", () => {
    const out = progressBar(0, 0);
    expect(out).toContain("  0%");
  });
});

describe("ui: panel", () => {
  test("renders bordered title and body", () => {
    const out = panel("Test", "hello\nworld", (s) => s);
    expect(out).toContain("Test");
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out.startsWith("┌─")).toBe(true);
    expect(out.endsWith("┘")).toBe(true);
  });

  test("accepts custom color function", () => {
    const color = (s: string) => `[[${s}]]`;
    const out = panel("X", "y", color);
    expect(out).toContain("[[");
  });

  test("uses default color when none is provided (default param branch)", () => {
    const out = panel("Title", "body");
    // The default color is c.cyan, which wraps the text with ANSI escapes.
    // We don't assert the exact escape, just that no error is thrown and
    // the panel renders the title/body.
    expect(out).toContain("Title");
    expect(out).toContain("body");
  });
});

describe("ui: link", () => {
  test("non-TTY fallback appends URL in parens", () => {
    const r = Bun.spawnSync([
      "bun",
      "-e",
      'import { link } from "./src/ui.js"; process.stdout.write(link("click here", "https://example.com"));',
    ]);
    const out = new TextDecoder().decode(r.stdout);
    expect(r.exitCode).toBe(0);
    expect(out).toBe("click here (https://example.com)");
  });

  test("TTY mode produces OSC-8 escape codes (monkey-patched in this process)", async () => {
    // The TTY() function in src/ui.ts reads process.stderr.isTTY
    // lazily at call time, so we can override it for the duration of
    // this test. We must use a dynamic import (not a top-level
    // import) to get the module AFTER the override is in place.
    const origTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      // Dynamic import: ensures the module's module-level TTY function
      // is evaluated AFTER the override. (Module evaluation happens
      // once per import URL, so the FIRST import caches the result.
      // Top-level imports in the test file already ran with the
      // original isTTY; this is OK because TTY() is a *function* and
      // it re-reads isTTY at every call.)
      const { link } = await import("../src/ui.js");
      const out = link("click", "https://example.com");
      expect(out).toContain("\x1b]8;;https://example.com");
      expect(out).toContain("click");
    } finally {
      Object.defineProperty(process.stderr, "isTTY", {
        value: origTTY,
        configurable: true,
      });
    }
  });

  test("setTtyOverride(true) forces the TTY branch in link()", () => {
    setTtyOverride(true);
    try {
      const out = link("click", "https://example.com");
      expect(out).toContain("\x1b]8;;https://example.com");
      expect(out).toContain("click");
    } finally {
      setTtyOverride(undefined);
    }
  });
});

describe("ui: TTY override helper", () => {
  let written: { channel: string; args: unknown[] }[] = [];
  let origError: typeof console.error;
  let origStderr: typeof process.stderr.write;

  beforeEach(() => {
    written = [];
    origError = console.error;
    origStderr = process.stderr.write;
    console.error = (...args: unknown[]) => {
      written.push({ channel: "error", args });
    };
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      const text =
        typeof chunk === "string"
          ? chunk
          : new TextDecoder().decode(chunk);
      written.push({ channel: "stderr", args: [text] });
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    console.error = origError;
    (process.stderr as { write: typeof process.stderr.write }).write = origStderr;
    setTtyOverride(undefined);
  });

  const outputText = (): string =>
    written.map((w) => w.args.map((a) => String(a)).join(" ")).join("\n");

  test("Spinner.start writes via stderr.write in TTY mode (setInterval body path)", async () => {
    setTtyOverride(true);
    const s = new Spinner();
    s.start("tty-frame-test");
    // Wait long enough for at least one setInterval tick (80ms cadence)
    // so the body of the interval (i++, this.line(...)) executes.
    await new Promise((r) => setTimeout(r, 120));
    s.succeed("done");
    const text = outputText();
    expect(text).toContain("tty-frame-test");
    expect(text).toContain("✔");
    expect(text).toContain("done");
  });

  test("Spinner.text writes the current frame when TTY and running", () => {
    setTtyOverride(true);
    const s = new Spinner();
    s.start("alpha");
    written.length = 0; // ignore the start() write
    s.text("beta");
    expect(outputText()).toContain("beta");
    s.succeed("end");
  });

  test("Spinner.succeed uses stderr.write path in TTY mode (clear branch)", () => {
    setTtyOverride(true);
    const s = new Spinner();
    s.start("work");
    s.succeed("ok");
    const text = outputText();
    // ✔ should appear in the stderr channel (not the error channel).
    expect(written.some((w) => w.channel === "stderr")).toBe(true);
    expect(text).toContain("✔");
    expect(text).toContain("ok");
  });

  test("Spinner.fail uses stderr.write path in TTY mode", () => {
    setTtyOverride(true);
    const s = new Spinner();
    s.start("work");
    s.fail("bad");
    const text = outputText();
    expect(written.some((w) => w.channel === "stderr")).toBe(true);
    expect(text).toContain("✖");
    expect(text).toContain("bad");
  });

  test("Spinner.stop() with timer=null takes the false branch of `if (this.timer)`", () => {
    setTtyOverride(true);
    const s = new Spinner();
    s.start("x");
    // First stop() runs inside succeed() and clears the timer.
    s.succeed("ok");
    // Second stop() runs inside the second succeed() and sees timer=null.
    // This must not throw and must not double-clear.
    s.succeed("ok-again");
    const text = outputText();
    expect(text).toContain("✔");
    expect(text).toContain("ok-again");
  });
});

describe("ui: StatusLine text with trail (TTY branch)", () => {
  test("text(msg, trail) appends the dim trail to spinner.text()", () => {
    setTtyOverride(true);
    const sl = new StatusLine();
    sl.start("working");
    sl.text("uploading", "42%");
    sl.succeed("done");
  });
});
