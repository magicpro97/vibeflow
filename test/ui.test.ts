import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { link, panel, progressBar, table } from "../src/ui.js";

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
    const r = execFileSync("bun", [
      "-e",
      'import { link } from "./src/ui.js"; process.stdout.write(link("click here", "https://example.com"));',
    ]);
    const out = new TextDecoder().decode(r);
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
});
