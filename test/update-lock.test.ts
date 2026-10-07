import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUpdateLock } from "../src/update/update-lock.js";

describe("update lock", () => {
  test("acquires, refuses a second holder, and frees on release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-update-lock-"));
    const path = join(dir, "update.lock");
    try {
      const release = acquireUpdateLock(path);
      expect(release).not.toBeNull();
      expect(acquireUpdateLock(path)).toBeNull(); // second holder refused
      await release?.();
      const again = acquireUpdateLock(path);
      expect(again).not.toBeNull(); // freed
      await again?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
