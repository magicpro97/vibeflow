import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closePinnedDirectory,
  openPinnedDescendant,
  openPrivateDirectory,
} from "../../src/durability/native.js";

/**
 * Descending two levels is what makes the loop in openPinnedDescendant iterate: the second pass
 * reads the pin the first pass installed. Every existing test descends one level and throws, so
 * the hand-off between iterations — closing the previous fd while keeping the new pin — was
 * never executed.
 */
describe("openPinnedDescendant across multiple levels", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("descends two levels and hands the pin between iterations", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vf-descend-")));
    roots.push(root);
    const base = openPrivateDirectory(root, true);
    try {
      const nested = join(root, "one", "two");
      const pinned = openPinnedDescendant(base, nested, true);
      try {
        expect(pinned.path).toBe(nested);
        expect(pinned.fd).toBeGreaterThanOrEqual(0);
      } finally {
        closePinnedDirectory(pinned);
      }
    } finally {
      closePinnedDirectory(base);
    }
  });
});
