import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUpdateLock } from "../src/update/update-lock.js";

describe("update lock", () => {
  test("acquires, refuses a second holder (reason: held), and frees on release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-update-lock-"));
    const path = join(dir, "update.lock");
    try {
      const first = acquireUpdateLock(path);
      expect(first.ok).toBe(true);
      expect(acquireUpdateLock(path)).toEqual({ ok: false, reason: "held" });
      if (first.ok) await first.release();
      const again = acquireUpdateLock(path);
      expect(again.ok).toBe(true); // freed
      if (again.ok) await again.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
