import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const PORT = 5317;
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(PROJECT_ROOT, "dist/cli.js");
const TEST_DIR = resolve(PROJECT_ROOT, "e2e");
const WORKSPACE = resolve(PROJECT_ROOT, ".e2e-workspace");
const TEST_HOME = resolve(WORKSPACE, ".home");
const TEST_BIN = resolve(WORKSPACE, ".bin");
const SETUP_RUN_ENV = "VF_PLAYWRIGHT_SETUP_RUN";
const setupRun = process.env[SETUP_RUN_ENV] ?? randomUUID();
process.env[SETUP_RUN_ENV] = setupRun;
// Conversation isolation creates detached Git worktrees below TMPDIR. Keep that
// authority outside the repository worktree: Git correctly refuses nested worktrees.
const TEST_TMP = resolve(tmpdir(), `vibeflow-playwright-${setupRun}`);
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
const SETUP_FLAG = resolve(WORKSPACE, ".e2e-setup-complete");
const preparedRun = existsSync(SETUP_FLAG) ? readFileSync(SETUP_FLAG, "utf8").trim() : "";
if (preparedRun !== setupRun) {
  try {
    // Build the exact checked-out worktree before Playwright starts webServer.
    // Workers inherit SETUP_RUN_ENV and observe SETUP_FLAG, so one controller
    // build prepares both the CLI and its embedded UI exactly once per run.
    execFileSync("bun", ["run", "build"], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      timeout: 120_000,
    });
    rmSyncRetry(WORKSPACE);
    rmSyncRetry(TEST_TMP);
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
    writeFileSync(
      resolve(WORKSPACE, ".gitignore"),
      ".bin/\n.e2e-setup-complete\n.home/\n.vibeflow/\n",
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
    const git = (args: readonly string[]) =>
      execFileSync("git", ["-C", WORKSPACE, ...args], {
        stdio: "ignore",
        timeout: 10_000,
      });
    git(["init", "--quiet"]);
    git(["config", "user.email", "playwright@example.invalid"]);
    git(["config", "user.name", "VibeFlow Playwright"]);
    git(["add", ".gitignore", "README.md", "package.json"]);
    git(["commit", "--quiet", "-m", "test: seed isolated e2e workspace"]);
    execFileSync(process.execPath, [CLI, "init", "--no-ask", "--no-ai", "--no-hooks"], {
      cwd: WORKSPACE,
      env: {
        ...isolatedServerEnv(),
        PATH: `${TEST_BIN}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
      },
      stdio: "ignore",
      timeout: 30_000,
    });
    writeFileSync(SETUP_FLAG, setupRun);
  } catch (err) {
    // If another worker raced us, both the workspace dir and the flag
    // may be gone. Re-create the directory unconditionally (it's safe
    // even if it already exists) — the other worker will have written
    // the files we need, and any further race becomes a no-op.
    const completedRun = existsSync(SETUP_FLAG) ? readFileSync(SETUP_FLAG, "utf8").trim() : "";
    if (completedRun === setupRun) {
      // another worker finished — we're done
    } else {
      try {
        mkdirSync(WORKSPACE, { recursive: true });
      } catch {
        // If we still can't create the dir, fall through and re-throw
        // the original error.
      }
      const recoveredRun = existsSync(SETUP_FLAG) ? readFileSync(SETUP_FLAG, "utf8").trim() : "";
      if (recoveredRun !== setupRun) throw err;
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
 * suffix; the Home acceptance keeps its requested `.spec.ts` name and is selected
 * explicitly here.
 */
export default defineConfig({
  testDir: TEST_DIR,
  testMatch: ["**/*.e2e.ts", "conversation-home.spec.ts"],
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
      // The exact Node 18.0.0 probe is an opt-in compatibility job, not part of
      // canonical browser acceptance when that external runtime is unavailable.
      grepInvert: /survives a late text response after disconnect on exact Node 18\.0\.0/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
    ...(process.env.VF_NODE18_BIN
      ? [
          {
            name: "node-18-compat",
            grep: /survives a late text response after disconnect on exact Node 18\.0\.0/,
            use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
          },
        ]
      : []),
  ],
  webServer: {
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ui --no-open --port ${PORT}`,
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
