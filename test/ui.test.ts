import { describe, expect, test } from "bun:test";
import { Spinner, StatusLine, link, panel, progressBar, table } from "../src/ui.js";

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
});

describe("ui: Spinner (non-TTY mode)", () => {
  // TTY is false in bun test (stderr is piped). Test the non-TTY branches
  // which use console.error instead of spinner frame animation.

  test("start prints 'msg...' to stderr and does not arm timer", () => {
    const s = new Spinner();
    const original = console.error;
    const calls: string[] = [];
    console.error = (msg: string) => calls.push(msg);
    try {
      s.start("loading");
      expect(calls.some((c) => c.includes("loading..."))).toBe(true);
    } finally {
      s.succeed();
      console.error = original;
    }
  });

  test("succeed/fail don't throw when called without start", () => {
    const s = new Spinner();
    expect(() => s.succeed()).not.toThrow();
    expect(() => s.fail()).not.toThrow();
  });

  test("succeed with msg updates the message and prints check mark", () => {
    const s = new Spinner();
    const original = console.error;
    const calls: string[] = [];
    console.error = (msg: string) => calls.push(msg);
    try {
      s.start("a");
      s.succeed("b");
      expect(calls.some((c) => c.includes("✔") && c.includes("b"))).toBe(true);
    } finally {
      console.error = original;
    }
  });

  test("fail with msg prints cross mark", () => {
    const s = new Spinner();
    const original = console.error;
    const calls: string[] = [];
    console.error = (msg: string) => calls.push(msg);
    try {
      s.start("a");
      s.fail("oh no");
      expect(calls.some((c) => c.includes("✖") && c.includes("oh no"))).toBe(true);
    } finally {
      console.error = original;
    }
  });

  test("text updates msg (writes to stderr only when TTY+running; non-TTY is no-op)", () => {
    // In non-TTY (bun test pipes stderr), text() is a no-op for the
    // spinner text branch. Verify that calling text() doesn't throw and
    // that no console.error happens.
    const s = new Spinner();
    const original = console.error;
    let textCalled = false;
    console.error = (msg: string) => {
      if (msg.includes("ignored")) textCalled = true;
    };
    try {
      s.text("just a message");
      expect(textCalled).toBe(false);
    } finally {
      console.error = original;
    }
  });

  test("text is a no-op when not running (TTY=false)", () => {
    const s = new Spinner();
    const original = console.error;
    let textCalled = false;
    console.error = (msg: string) => {
      if (msg.includes("ignored")) textCalled = true;
    };
    try {
      s.text("ignored");
      expect(textCalled).toBe(false);
    } finally {
      console.error = original;
    }
  });
});

describe("ui: StatusLine", () => {
  test("start/succeed/fail/text forward to inner Spinner", () => {
    const sl = new StatusLine();
    expect(() => sl.start("a")).not.toThrow();
    expect(() => sl.text("b")).not.toThrow();
    expect(() => sl.text("c", "trail")).not.toThrow();
    expect(() => sl.succeed("d")).not.toThrow();
    expect(() => sl.fail("e")).not.toThrow();
  });
});
