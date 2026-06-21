import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../src/core.js";
import type { EngineReadiness } from "../src/preflight.js";

function allReady(engines: Engine[]): EngineReadiness[] {
  return engines.map((e) => ({ engine: e, level: "ready" as const, detail: "ok", checkedAt: "" }));
}

describe("commands.init — codegraph install path (line 445-459)", () => {
  let dir: string;
  let origCwd: string;
  let origIsTTY: boolean | undefined;
  let origStderrIsTTY: boolean | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-init-cov-"));
    origCwd = process.cwd();
    process.chdir(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
    origIsTTY = process.stdin.isTTY;
    origStderrIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
  });
  afterEach(() => {
    process.chdir(origCwd);
    if (origIsTTY === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
    else Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    if (origStderrIsTTY === undefined) Reflect.deleteProperty(process.stderr, "isTTY");
    else
      Object.defineProperty(process.stderr, "isTTY", {
        value: origStderrIsTTY,
        configurable: true,
      });
    mock.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("install path runs when codegraph is not on PATH (line 445-459)", async () => {
    // 1. Hide codegraph from Bun.which → hasCommand("codegraph") = false.
    const origWhich = Bun.which;
    // @ts-expect-error: bun's Bun.which is writable.
    Bun.which = (cmd: string) => (cmd === "codegraph" ? undefined : origWhich.call(Bun, cmd));
    // 2. Stub spawnSync to return success without actually shelling out.
    mock.module("node:child_process", () => {
      const real = require("node:child_process");
      return {
        ...real,
        spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      };
    });
    try {
      const { init } = await import("../src/commands.js");
      const code = await init({ "no-ai": true }, { preflight: allReady });
      expect(typeof code).toBe("number");
    } finally {
      Bun.which = origWhich;
      // Restore the real node:child_process so subsequent tests
      // (file-size-gate, etc.) can use cpSpawnSync normally.
      mock.module("node:child_process", () => {
        // Re-export the real module
        return require("node:child_process");
      });
    }
  });
});
