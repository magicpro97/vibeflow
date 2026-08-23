import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 5317;
const CLI = resolve("src/cli.ts");
const WORKSPACE = resolve(".e2e-workspace");
const TEST_HOME = resolve(WORKSPACE, ".home");
const TEST_BIN = resolve(WORKSPACE, ".bin");
const TEST_TMP = resolve(WORKSPACE, ".tmp");
const SERVER_ENV_ALLOWLIST = [
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "CI",
  "NO_COLOR",
] as const;

function isolatedServerEnv(): Record<string, string> {
  const env: Record<string, string> = {
    HOME: TEST_HOME,
    NODE_ENV: "test",
    PLAYWRIGHT_TEST: "1",
    TMPDIR: TEST_TMP,
    TMP: TEST_TMP,
    TEMP: TEST_TMP,
  };
  for (const name of SERVER_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

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
      console.warn(`[e2e-setup] retry ${i + 1}/5: ${code} removing ${p}`);
    }
  }
}

// The controller creates a new identity for every Playwright invocation and
// workers inherit it through the environment. This makes worker config imports
// idempotent without letting a previous invocation's workflow state leak into
// the next run.
const SETUP_RUN_ENV = "VF_PLAYWRIGHT_SETUP_RUN";
const setupRun = process.env[SETUP_RUN_ENV] ?? randomUUID();
process.env[SETUP_RUN_ENV] = setupRun;
const SETUP_FLAG = resolve(WORKSPACE, ".e2e-setup-complete");
const preparedRun = existsSync(SETUP_FLAG) ? readFileSync(SETUP_FLAG, "utf8").trim() : "";
if (preparedRun !== setupRun) {
  try {
    rmSyncRetry(WORKSPACE);
    mkdirSync(WORKSPACE, { recursive: true });
    mkdirSync(TEST_HOME, { recursive: true });
    mkdirSync(TEST_BIN, { recursive: true });
    mkdirSync(TEST_TMP, { recursive: true });
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
    const claudeProbe = resolve(TEST_BIN, "claude");
    const copilotProbe = resolve(TEST_BIN, "copilot");
    const githubProbe = resolve(TEST_BIN, "gh");
    writeFileSync(
      claudeProbe,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"result","subtype":"success","session_id":"019f278f-d7ff-77d3-9c44-7459bbf08d19","result":"READY"}\'\n',
    );
    writeFileSync(copilotProbe, "#!/bin/sh\nexit 0\n");
    writeFileSync(githubProbe, "#!/bin/sh\nexit 0\n");
    for (const executable of [claudeProbe, copilotProbe, githubProbe]) {
      chmodSync(executable, 0o700);
    }
    writeFileSync(SETUP_FLAG, setupRun);
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

mkdirSync(TEST_TMP, { recursive: true });
process.env.TMPDIR = TEST_TMP;
process.env.TMP = TEST_TMP;
process.env.TEMP = TEST_TMP;

// The controller/worker process is itself the parent of every test-owned process. Scrub
// provider credentials before workers are forked, and put the deterministic readiness
// executable on PATH before Bun performs its first command lookup.
for (const name of Object.keys(process.env)) {
  if (/(?:^|_)(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i.test(name)) {
    delete process.env[name];
  }
}
process.env.PATH = `${TEST_BIN}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`;

/**
 * Web e2e: drive the real VibeFlow dashboard in Chromium. Most specs use the `.e2e.ts`
 * suffix; the conversation acceptance keeps its requested `.spec.ts` name and is selected
 * explicitly here.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/*.e2e.ts", "**/conversation.spec.ts"],
  // Per-test budget. Some specs drive real round-trips (settings save + reload, the engine
  // probe) that are machine-dependent and can run long on a loaded CI box; 60s leaves
  // headroom so a slow-but-correct round-trip isn't flagged as a failure.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // These suites share one real server and one stateful throwaway repo. Keep
  // files serial so mutation tests cannot invalidate another file's intake view.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    command: `bun run ${CLI} ui --no-open --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    cwd: WORKSPACE,
    // The dashboard registry is user-global. Give only this test-owned server a
    // throwaway home so real projects never influence or get mutated by E2E.
    // Never forward the controller's provider/API credentials into the real E2E server.
    env: isolatedServerEnv(),
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
