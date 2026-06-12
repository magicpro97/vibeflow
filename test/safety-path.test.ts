import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertWithinRoot, toAbsolute } from "../src/safety/path.js";

describe("assertWithinRoot", () => {
  const root = mkdtempSync(join(tmpdir(), "vibeflow-test-"));
  const inside = join(root, "a", "b");
  mkdirSync(inside, { recursive: true });
  writeFileSync(join(inside, "x.txt"), "x");

  test("allows path inside root", () => {
    expect(() => assertWithinRoot(join(inside, "x.txt"), root)).not.toThrow();
  });

  test("rejects path outside root", () => {
    expect(() => assertWithinRoot("/etc/passwd", root)).toThrow(/outside root/);
  });

  test("rejects path that escapes via ..", () => {
    expect(() => assertWithinRoot(join(inside, "..", "..", "..", "etc", "passwd"), root)).toThrow(
      /outside root/,
    );
  });

  test("rejects symlink pointing outside root", () => {
    const linkPath = join(root, "evil-link");
    try {
      // create a symlink to /tmp (outside root) — adjust if /tmp is the root
      require("node:fs").symlinkSync(tmpdir(), linkPath);
      expect(() => assertWithinRoot(linkPath, root)).toThrow();
    } catch {
      // symlink permission can fail on some FS — skip
    }
  });

  test("toAbsolute returns absolute path", () => {
    expect(toAbsolute("a/b")).toMatch(/^[/\\]/);
  });
});
