// #805 regression: bridge-mode dispatch on Windows must run a quoted command string.
//
// `VIBEFLOW_AI` / `opts.bridgeCmd` is a command string and may hold quoted paths with spaces
// (`"C:\Users\Linh Ngo\...\bun.exe" "C:\...\bridge.mjs"`). Passing that string to `cmd.exe` as one
// argv element cannot work — Bun re-escapes the quotes (`\"`) and cmd.exe then reads
// `\"C:\...\bun.exe\"` as the program name. The string is tokenized and launched directly.
//
// These tests run the REAL owned launch (no injected seam) because only a real spawn proves the
// argv survives the launcher. They are Windows-only: the Linux `check` job covers the tokenizer
// through the platform-mocked unit tests in test/dispatch.test.ts. Wired into the Windows CI job
// with its 30s test timeout — an owned launch on Windows costs seconds by design (PowerShell
// start-identity probes + the terminate grace window), which is why the default 5s test timeout
// is not enough here.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellLaunchArgv } from "../src/core.js";
import { runDispatchAsync } from "../src/dispatch.js";
import { runOwnedAiRoute } from "../src/dispatch/owned-ai-route.js";
import { RUNTIME_PLATFORM } from "../src/durability/process-identity-contract.js";

const windowsOnly = process.platform === RUNTIME_PLATFORM.WINDOWS ? test : test.skip;
/** Owned launches on Windows burn the start-identity probe budget and the terminate grace. */
const OWNED_LAUNCH_TIMEOUT_MS = 60_000;

const ENGINE_SCRIPT =
  'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("BRIDGE-OK\\n"); process.stderr.write("BRIDGE-STDERR\\n"); });';

/** Bare engine name that exists ONLY as a `.cmd` shim — the shape npm installs on Windows. */
const SHIM_NAME = "vf-bridge-shim";
const SHIM_MARKER = "BRIDGE-SHIM-OK";
/** Reads stdin to EOF (the prompt) so the parent's write cannot EPIPE, then proves it ran. */
const SHIM_SCRIPT = `@echo off\r\nmore >nul\r\necho ${SHIM_MARKER}\r\n`;
/** Echoes the first argument back, so a mis-split argv is observable and not just a bad exit. */
const SHIM_ARGUMENT_MARKER = "BRIDGE-SHIM-ARG=";
const SHIM_SCRIPT_WITH_ARGUMENT = `@echo off\r\nmore >nul\r\necho ${SHIM_MARKER}\r\necho ${SHIM_ARGUMENT_MARKER}[%~1]\r\n`;

/** Write the shim into `dir` and PREPEND `dir` to PATH; returns a PATH restore thunk. */
function withShimOnPath(dir: string): () => void {
  writeFileSync(join(dir, `${SHIM_NAME}.cmd`), SHIM_SCRIPT);
  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${dir};${originalPath}`;
  return () => {
    process.env.PATH = originalPath;
  };
}

describe("bridge dispatch runs a quoted command string on Windows (#805)", () => {
  windowsOnly(
    "runDispatchAsync bridge mode survives a script path containing spaces",
    async () => {
      // The space in the temp dir is the regression: it forces the command string to quote the
      // script path, which is exactly what cmd.exe used to receive mangled.
      const dir = mkdtempSync(join(tmpdir(), "vf bridge spaces-"));
      const base = mkdtempSync(join(tmpdir(), "vf-bridge-base-"));
      try {
        const engineScript = join(dir, "bridge engine.mjs");
        writeFileSync(engineScript, ENGINE_SCRIPT);
        const stderr: string[] = [];
        const result = await runDispatchAsync({
          engine: "claude",
          prompt: "prompt",
          mode: "bridge",
          bridgeCmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(engineScript)}`,
          base,
          onStderrChunk: (chunk) => stderr.push(chunk),
        });
        expect(result.ok).toBe(true);
        expect(result.raw).toContain("BRIDGE-OK");
        expect(stderr.join("")).toContain("BRIDGE-STDERR");
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    },
    OWNED_LAUNCH_TIMEOUT_MS,
  );

  windowsOnly(
    "runOwnedAiRoute runs the VIBEFLOW_AI bridge command with a quoted path containing spaces",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "vf bridge route spaces-"));
      try {
        const engineScript = join(dir, "route engine.mjs");
        writeFileSync(engineScript, ENGINE_SCRIPT);
        const result = await runOwnedAiRoute({
          engine: "claude",
          command: `${JSON.stringify(process.execPath)} ${JSON.stringify(engineScript)}`,
          input: "prompt",
          cwd: dir,
          shell: true,
          timeoutMs: 30_000,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("BRIDGE-OK");
        expect(result.stderr).toContain("BRIDGE-STDERR");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    OWNED_LAUNCH_TIMEOUT_MS,
  );

  // Copilot review on PR #815: tokenizing the command string is not enough. `copilot --json` has
  // no `.cmd` suffix on the TOKEN, so shim detection must resolve the token against PATH — npm
  // installs engines as `copilot.cmd`, which CreateProcess cannot execute.
  windowsOnly(
    "runDispatchAsync bridge mode resolves a bare name to its .cmd shim on PATH",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "vf bridge shim-"));
      const base = mkdtempSync(join(tmpdir(), "vf-bridge-shim-base-"));
      const restorePath = withShimOnPath(dir);
      try {
        // The launch form this path must choose: the tokenized bare name through cmd.exe —
        // CreateProcess cannot execute a batch file. Before the fix the token carried no `.cmd`
        // suffix and shim detection missed it, so the argv was launched directly.
        expect(shellLaunchArgv(`${SHIM_NAME} --json`, [], false)).toEqual([
          "cmd.exe",
          "/c",
          SHIM_NAME,
          "--json",
        ]);
        const stderr: string[] = [];
        const result = await runDispatchAsync({
          engine: "claude",
          prompt: "prompt",
          mode: "bridge",
          bridgeCmd: `${SHIM_NAME} --json`,
          base,
          onStderrChunk: (chunk) => stderr.push(chunk),
        });
        expect(result.raw).toContain(SHIM_MARKER);
        expect(result.ok).toBe(true);
      } finally {
        restorePath();
        rmSync(dir, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    },
    OWNED_LAUNCH_TIMEOUT_MS,
  );

  // #819: a quoted ABSOLUTE shim path with spaces makes cmd.exe's `/c` remainder START with a
  // quote, and cmd.exe then strips the leading and trailing quote and re-splits the path at its
  // first space (`'C:\…\vf' is not recognized …`) — the shim never runs, or runs the wrong
  // sibling `.cmd` with a mangled argv. The argument has to arrive intact, not just exit clean.
  windowsOnly(
    "runDispatchAsync bridge mode runs a quoted absolute .cmd shim path with spaces plus a quoted argument",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "vf bridge quoted shim-"));
      const base = mkdtempSync(join(tmpdir(), "vf-bridge-quoted-shim-base-"));
      try {
        const shim = join(dir, "vf bridge shim tool.cmd");
        writeFileSync(shim, SHIM_SCRIPT_WITH_ARGUMENT);
        // Plain quotes, the way `VIBEFLOW_AI` is written; JSON-escaping would double every
        // backslash in the tokenized path.
        const bridgeCmd = `"${shim}" "arg with space"`;
        // The launch form that survives cmd.exe's quote handling: `call` keeps a never-quoted
        // token in front of the quoted command line, so the leading-quote strip never applies.
        expect(shellLaunchArgv(bridgeCmd, [], false)).toEqual([
          "cmd.exe",
          "/d",
          "/c",
          "call",
          shim,
          "arg with space",
        ]);
        const stderr: string[] = [];
        const result = await runDispatchAsync({
          engine: "claude",
          prompt: "prompt",
          mode: "bridge",
          bridgeCmd,
          base,
          onStderrChunk: (chunk) => stderr.push(chunk),
        });
        expect(result.ok).toBe(true);
        expect(result.raw).toContain(SHIM_MARKER);
        expect(result.raw).toContain(`${SHIM_ARGUMENT_MARKER}[arg with space]`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    },
    OWNED_LAUNCH_TIMEOUT_MS,
  );

  windowsOnly(
    "runOwnedAiRoute reaches the same .cmd shim when the command arrives as an argv list",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "vf bridge shim argv-"));
      const restorePath = withShimOnPath(dir);
      try {
        const result = await runOwnedAiRoute({
          engine: "claude",
          command: SHIM_NAME,
          args: ["--json"],
          input: "prompt",
          cwd: dir,
          timeoutMs: 30_000,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(SHIM_MARKER);
      } finally {
        restorePath();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    OWNED_LAUNCH_TIMEOUT_MS,
  );
});
