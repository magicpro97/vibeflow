import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 5317;
const CLI = resolve("src/cli.ts");
const WORKSPACE = resolve(".e2e-workspace");

/**
 * Seed a throwaway workspace BEFORE the webServer spawns (Playwright starts webServer
 * before globalSetup, and it needs the cwd to exist). Anything the UI generates lands
 * here, never in the project tree.
 */
// Retry rmSync a few times — `vf init` may leave temp files open on macOS
// (e.g. `.DS_Store`, hardlink races during .vibeflow regen). ENOTEMPTY is
// transient and resolves within a few ms.
function rmSyncRetry(p: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(p, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") throw err;
      if (i === 4) throw err;
      // biome-ignore lint/suspicious/noConsole: diagnostic on retry
      console.warn(`[e2e-setup] retry ${i + 1}/5: ${code} removing ${p}`);
    }
  }
}

// Each Playwright worker imports its own copy of this config module, so the
// workspace setup below runs once per worker. The race is benign when all
// workers finish in the same order (last writeFileSync wins) but lethal when
// a slow mkdir loses to a fast rmSync from another worker — the rmSync's
// recursive wipe can land BETWEEN mkdirSync(WORKSPACE) and writeFileSync(...),
// deleting the freshly-created parent directory. The per-process SETUP_FLAG
// makes the setup idempotent: if another worker already finished, this
// worker sees the flag and skips the rm/mkdir/write.
const SETUP_FLAG = resolve(WORKSPACE, ".e2e-setup-complete");
if (!existsSync(SETUP_FLAG)) {
  try {
    rmSyncRetry(WORKSPACE);
    mkdirSync(WORKSPACE, { recursive: true });
    writeFileSync(
      resolve(WORKSPACE, "package.json"),
      JSON.stringify(
        {
          name: "e2e-demo",
          scripts: { build: "tsc", test: "echo ok" },
          dependencies: { express: "^4.19.0" },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      resolve(WORKSPACE, "README.md"),
      "# E2E Demo\n\nA demo service for VibeFlow web e2e.\n",
    );
    writeFileSync(SETUP_FLAG, new Date().toISOString());
  } catch (err) {
    // If another worker raced us, both the workspace dir and the flag
    // may be gone. Re-create the directory unconditionally (it's safe
    // even if it already exists) — the other worker will have written
    // the files we need, and any further race becomes a no-op.
    if (existsSync(SETUP_FLAG)) {
      // another worker finished — we're done
    } else {
      try {
        mkdirSync(WORKSPACE, { recursive: true });
      } catch {
        // If we still can't create the dir, fall through and re-throw
        // the original error.
      }
      if (!existsSync(SETUP_FLAG)) throw err;
    }
  }
}

/**
 * Web e2e: drive the real VibeFlow dashboard in Chromium. Specs use the `.e2e.ts` suffix
 * so the unit runner (`bun test`, which matches *.test/*.spec) ignores them.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  // Per-test budget. Some specs drive real round-trips (settings save + reload, the engine
  // probe) that are machine-dependent and can run long on a loaded CI box; 60s leaves
  // headroom so a slow-but-correct round-trip isn't flagged as a failure.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun run ${CLI} ui --no-open --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: WORKSPACE,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
