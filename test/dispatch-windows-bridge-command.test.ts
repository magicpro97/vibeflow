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
import { runDispatchAsync } from "../src/dispatch.js";
import { runOwnedAiRoute } from "../src/dispatch/owned-ai-route.js";
import { RUNTIME_PLATFORM } from "../src/durability/process-identity-contract.js";

const windowsOnly = process.platform === RUNTIME_PLATFORM.WINDOWS ? test : test.skip;
/** Owned launches on Windows burn the start-identity probe budget and the terminate grace. */
const OWNED_LAUNCH_TIMEOUT_MS = 60_000;

const ENGINE_SCRIPT =
  'process.stdin.resume(); process.stdin.on("end", () => { process.stdout.write("BRIDGE-OK\\n"); process.stderr.write("BRIDGE-STDERR\\n"); });';

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
});
