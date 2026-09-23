import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closePinnedDirectory,
  createAt,
  linkAt,
  openAt,
  openPrivateDirectory,
  renameAt,
  tryOpenAt,
} from "../../src/durability/native.js";

/**
 * Every *at() entry point resolves its name against a pinned directory, so the name must be a
 * single path component. Rejecting only "/" left Windows open: join() collapses "..\outside"
 * straight out of the pin (C:\pinned + "..\outside" -> C:\outside), which defeats the whole
 * point of pinning the directory in the first place.
 */
describe("relative name confinement", () => {
  const roots: string[] = [];

  const pinned = () => {
    const root = mkdtempSync(join(tmpdir(), "vf-at-confinement-"));
    roots.push(root);
    return openPrivateDirectory(root, true);
  };

  const escapes = ["..\\outside", "sub\\child", "../outside", "sub/child", "..", ".", ""] as const;

  test("openAt rejects every name that is not a single component", () => {
    const directory = pinned();
    try {
      for (const name of escapes)
        expect(() => openAt(directory, name, 0)).toThrow("unsafe relative native path name");
    } finally {
      closePinnedDirectory(directory);
    }
  });

  test("tryOpenAt, createAt, renameAt and linkAt reject traversal on both separators", () => {
    const directory = pinned();
    try {
      expect(() => tryOpenAt(directory, "..\\outside", 0)).toThrow(
        "unsafe relative native path name",
      );
      expect(() => createAt(directory, "..\\outside", 0, 0o600)).toThrow(
        "unsafe relative native path name",
      );
      expect(() => renameAt(directory, "..\\outside", "target")).toThrow(
        "unsafe relative native path name",
      );
      expect(() => renameAt(directory, "source", "..\\outside")).toThrow(
        "unsafe relative native path name",
      );
      expect(() => linkAt(directory, "..\\outside", "target")).toThrow(
        "unsafe relative native path name",
      );
    } finally {
      closePinnedDirectory(directory);
    }
  });

  test("a plain component is still accepted", () => {
    const directory = pinned();
    try {
      expect(() => createAt(directory, "plain-name", 0, 0o600)).not.toThrow();
    } finally {
      closePinnedDirectory(directory);
    }
  });

  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
});
