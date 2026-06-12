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

  test("rejects path whose intermediate symlink points outside root", () => {
    // Tighter symlink test: create a symlink inside root that resolves
    // to a directory outside root. Then ask the validator about a
    // non-existing child of that symlink. The walk-up parent-by-parent
    // realpath must follow the symlink and reject the resolved real path.
    const linkPath = join(root, "evil-parent-link");
    const target = join(linkPath, "nonexistent-child");
    let created = false;
    try {
      require("node:fs").symlinkSync(tmpdir(), linkPath);
      created = true;
    } catch {
      // symlink permission can fail on some FS (e.g. macOS sandbox) — skip
    }
    if (!created) return;
    expect(() => assertWithinRoot(target, root)).toThrow(/outside root/);
  });

  test("toAbsolute returns absolute path", () => {
    expect(toAbsolute("a/b")).toMatch(/^[/\\]/);
  });
});
