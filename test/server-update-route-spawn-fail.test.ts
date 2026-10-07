// Covers defaultSpawnUpdate's real arms: the success spawn, the catch, the cwd,
// and the handleUpdateRun default arm (spawnUpdateDefault).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSpawnUpdate, spawnUpdateDefault } from "../src/server/routes-update.js";

describe("defaultSpawnUpdate (real spawn)", () => {
  test("spawns the given runtime detached and reports a pid", () => {
    // spawn(bun, ["-e", "0"]) — a real, instantly-exiting program.
    expect(defaultSpawnUpdate(["0"], { execPath: process.execPath, entry: "-e" })).toBe(true);
  });
  test("a spawn that throws synchronously answers false instead of crashing", () => {
    // An empty execPath makes child_process.spawn throw synchronously
    // (ERR_INVALID_ARG_VALUE — probed on bun 1.4) — the catch arm absorbs it.
    expect(defaultSpawnUpdate(["update"], { execPath: "", entry: "y" })).toBe(false);
  });
  test.skipIf(process.platform === "win32")("runs the child in the given cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-spawn-cwd-"));
    try {
      const out = join(dir, "out");
      expect(
        defaultSpawnUpdate([`pwd > ${out}`], { execPath: "/bin/sh", entry: "-c", cwd: dir }),
      ).toBe(true);
      let seen = "";
      for (let i = 0; i < 40 && seen === ""; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        try {
          seen = readFileSync(out, "utf8").trim();
        } catch {
          /* child has not written yet */
        }
      }
      expect(realpathSync(seen)).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("spawnUpdateDefault composes the runtime with the cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-spawn-default-"));
    try {
      expect(spawnUpdateDefault(["0"], dir, { execPath: process.execPath, entry: "-e" })).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
