// Covers defaultSpawnUpdate's real arms: the success spawn and the catch.
import { describe, expect, test } from "bun:test";
import { defaultSpawnUpdate } from "../src/server/routes-update.js";

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
});
