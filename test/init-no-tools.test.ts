import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands/init.js";
import { CTX_DIR } from "../src/core.js";

function readyPreflight() {
  return [{ engine: "claude" as const, level: "ready" as const, detail: "ok", checkedAt: "now" }];
}

describe("vf init --no-tools", () => {
  test("skips Phase 1.6 provisioning but keeps later init phases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-no-tools-"));
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync(join(dir, CTX_DIR), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "SETTINGS.json"),
        JSON.stringify({ tools: { codegraph: true } }),
      );
      let spawnCalls = 0;
      const code = await init(
        { engine: "claude", "no-ai": true, "no-hooks": true, "no-memory": true, "no-tools": true },
        {
          syncSpawner: () => {
            spawnCalls++;
            return { status: 0 };
          },
          detectTool: () => false,
          hookSetup: null,
          preflight: readyPreflight,
        },
      );

      expect(code).toBe(0);
      expect(spawnCalls).toBe(0);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("default init still provisions enabled missing tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-init-default-tools-"));
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      mkdirSync(join(dir, CTX_DIR), { recursive: true });
      writeFileSync(
        join(dir, ".vibeflow", "SETTINGS.json"),
        JSON.stringify({ tools: { codegraph: true } }),
      );
      let spawnCalls = 0;
      const code = await init(
        { engine: "claude", "no-ai": true, "no-hooks": true, "no-memory": true },
        {
          syncSpawner: () => {
            spawnCalls++;
            return { status: 0 };
          },
          detectTool: () => false,
          preflight: readyPreflight,
        },
      );

      expect(code).toBe(0);
      expect(spawnCalls).toBeGreaterThan(0);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
