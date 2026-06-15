import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
rmSyncRetry(WORKSPACE);
mkdirSync(WORKSPACE, { recursive: true });
writeFileSync(
  resolve(WORKSPACE, "package.json"),
  JSON.stringify(
    { name: "e2e-demo", scripts: { build: "tsc", test: "echo ok" }, dependencies: { express: "^4.19.0" } },
    null,
    2,
  ),
);
writeFileSync(resolve(WORKSPACE, "README.md"), "# E2E Demo\n\nA demo service for VibeFlow web e2e.\n");

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
