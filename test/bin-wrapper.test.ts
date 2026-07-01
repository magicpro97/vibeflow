import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("npm wrapper", () => {
  test("package.json bin points to shell wrapper", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf-8"));
    expect(pkg.bin?.vf).toBe("./bin/vf");
  });

  test("bin/vf exists with proper quoting for Windows paths", () => {
    const wrapperPath = join(import.meta.dir, "../bin/vf");
    expect(existsSync(wrapperPath)).toBe(true);
    const content = readFileSync(wrapperPath, "utf-8");
    expect(content.startsWith("#!/bin/sh")).toBe(true);
    // Must properly quote variables to handle spaces in Windows paths
    expect(content).toMatch(/"\$SCRIPT_DIR"/);
    // Must reference the actual CLI entry point
    expect(content).toContain("dist/cli.js");
  });
});
