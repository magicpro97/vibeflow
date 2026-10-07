import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  test("an unusable lock path reports 'unavailable', not 'held'", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-update-lock-bad-"));
    try {
      // A FILE where the lock path needs a parent DIRECTORY: writeFileSafe's
      // recursive mkdir throws (ENOTDIR) — the catch must classify it as
      // unavailable, never as "another update is running".
      writeFileSync(join(dir, "blocker"), "x");
      const result = acquireUpdateLock(join(dir, "blocker", "nested", "update.lock"));
      expect(result).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
