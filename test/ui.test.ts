import { describe, expect, test } from "bun:test";
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
