/**
 * Live Windows conversation-bootstrap gate (issue #803).
 *
 * `vf ui` shipped broken on Windows because nothing in CI ever started the conversation
 * bootstrap on a real win32 runtime: the rejection lived in a POSIX-only mode compare
 * (`trace/path-safety.ts`) followed by an `EPERM` directory fsync, both invisible to a Linux
 * runner and to unit tests that inject fakes. This suite drives the shipped artifact the way a
 * user does — a real git project, the real `vf ui` entry point, a real HTTP request — so a
 * regression of that class fails here instead of on a user's machine.
 *
 * Windows-only by construction (the failure mode does not exist elsewhere), mirroring
 * `dispatch-owned-process-windows-live.test.ts`: skipped off win32, and VF_REQUIRE_LIVE_WINDOWS=1
 * asserts the job really did land on a real Windows runtime.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_PLATFORM } from "../src/durability/process-identity-contract.js";

const LIVE_WINDOWS_ENV = "VF_REQUIRE_LIVE_WINDOWS";
const BOOT_TIMEOUT_MS = 60_000;
const repoRoot = dirname(dirname(fileURLToPath(new URL(import.meta.url))));
const cliEntry = join(repoRoot, "dist", "cli.js");
/**
 * The shipped Windows command is `bin/vf.mjs`, which launches the artifact with Node
 * (`bin/vf.mjs:9`). This suite runs under Bun, so spawning `process.execPath` would exercise
 * `bun dist/cli.js` and stay green through a Node-only break in the real command. Resolve Node
 * from PATH — the Windows matrix installs it, and the throw below fails the gate when it is
 * missing rather than silently falling back to Bun.
 */
const nodeExecPath = Bun.which("node");
const liveWindowsTest = process.platform === RUNTIME_PLATFORM.WINDOWS ? test : test.skip;

if (process.env[LIVE_WINDOWS_ENV] === "1" && process.platform !== RUNTIME_PLATFORM.WINDOWS) {
  throw new Error(`${LIVE_WINDOWS_ENV}=1 requires a real win32 runtime`);
}

interface HomeUi {
  port: number;
  transcript: () => string;
  stop: () => Promise<void>;
}

/** Start the built CLI in `cwd` and resolve once it prints the bound Home URL. */
function startHomeUi(cwd: string): Promise<HomeUi> {
  return new Promise<HomeUi>((resolve, reject) => {
    if (nodeExecPath === null) {
      throw new Error("node is not on PATH; the shipped bin/vf.mjs launches dist/cli.js with Node");
    }
    const child = spawn(nodeExecPath, [cliEntry, "ui", "--port", "0", "--no-open"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const transcript = (): string => `${stdout}\n${stderr}`;
    /**
     * Kill the child if it is alive and resolve only once it has actually exited. Every teardown
     * path — the normal `stop()` and the boot timeout — awaits this, so no Windows orphan can
     * outlive the test and keep touching the workspace the caller deletes in its `finally`.
     */
    const stop = async (): Promise<void> => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((done) => child.once("exit", () => done()));
        child.kill();
        await exited;
      }
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await stop();
      reject(new Error(`vf ui did not boot within ${BOOT_TIMEOUT_MS}ms:\n${transcript()}`));
    }, BOOT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (!settled && match) {
        settled = true;
        clearTimeout(timer);
        resolve({ port: Number(match[1]), transcript, stop });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`vf ui exited before booting (code=${code} signal=${signal}):\n${transcript()}`),
      );
    });
  });
}

describe("conversation bootstrap on a real Windows runtime", () => {
  liveWindowsTest(
    "vf ui boots the Home server in a fresh project and serves a request",
    async () => {
      expect(existsSync(cliEntry), `missing ${cliEntry}; run bun run build first`).toBe(true);
      const root = mkdtempSync(join(tmpdir(), "vf-home-ui-live-"));
      let ui: HomeUi | undefined;
      try {
        execFileSync("git", ["init", "-q", "."], { cwd: root, stdio: "ignore" });
        ui = await startHomeUi(root);
        const response = await fetch(`http://127.0.0.1:${ui.port}/`);
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(body).toContain('name="vf-token"');
        expect(ui.transcript()).not.toContain("conversation bootstrap");
        // The bootstrap is what creates the private state tree; a directory rejected by the
        // Windows privacy authority never gets here.
        expect(existsSync(join(root, ".vibeflow", "conversation", "trace"))).toBe(true);
      } finally {
        if (ui) await ui.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    BOOT_TIMEOUT_MS + 30_000,
  );
});
