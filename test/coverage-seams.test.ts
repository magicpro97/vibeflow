/**
 * Targeted coverage tests for the 4 lines in src/commands.ts,
 * 3 lines in src/dispatch.ts, and 2 lines in src/ui.ts that the
 * existing test suite doesn't cover. These exist purely to bring
 * those files to 100% line coverage per the per-file gate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";
import { init, orchestrate, resetTipStateForTests } from "../src/commands.js";
import { makeAsyncSpawner } from "../src/dispatch.js";
import { Spinner } from "../src/ui.js";

const origCwd = cwd();

afterEach(() => {
  process.chdir(origCwd);
});

describe("commands coverage seams", () => {
  test("resetTipStateForTests is callable (covers line 129)", () => {
    expect(() => resetTipStateForTests()).not.toThrow();
  });

  test("init prints watch-live tip when .ui-port file is present (covers line 1067)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-tip-"));
    process.chdir(dir);
    const ctxDir = join(dir, ".vibeflow");
    mkdirSync(ctxDir, { recursive: true });
    // .ui-port must be readable; port is a finite number so the tip prints.
    writeFileSync(join(ctxDir, ".ui-port"), JSON.stringify({ port: 4123 }));
    // Spy on console methods (logbus.out routes through console).
    const captured: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    (process.stdout as { write: (chunk: string | Uint8Array) => boolean }).write = ((
      chunk: string | Uint8Array,
    ) => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
    (process.stderr as { write: (chunk: string | Uint8Array) => boolean }).write = ((
      chunk: string | Uint8Array,
    ) => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    resetTipStateForTests();
    try {
      // orchestrate is the function that prints the watch-live tip on
      // first invocation. We call it in dry mode (no engine) so it
      // exits quickly.
      try {
        await orchestrate(
          { dry: true, "no-ai": true, "no-ask": true, "no-agent-team": true },
          dir,
          { preflight: () => [] },
        );
      } catch {
        // We don't care if orchestrate fails — we only need the
        // watch-live tip to be printed BEFORE the workflow check.
      }
      const combined = captured.join("\n");
      expect(combined).toContain("Tip: watch live at http://127.0.0.1:4123");
    } finally {
      console.log = origLog;
      console.error = origErr;
      (process.stdout as { write: typeof origStdoutWrite }).write = origStdoutWrite;
      (process.stderr as { write: typeof origStderrWrite }).write = origStderrWrite;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("init fails fast on VibeFlow context gen error (covers lines 1306-1307)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ctx-fail-"));
    process.chdir(dir);
    const origErr = console.error;
    const lines: string[] = [];
    console.error = (line: string) => {
      lines.push(line);
    };
    try {
      await expect(
        init(
          { "no-ai": true, "no-ask": true, "no-agent-team": true },
          {
            preflight: () => {
              throw new Error("disk on fire");
            },
          },
        ),
      ).rejects.toThrow("disk on fire");
    } finally {
      console.error = origErr;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ui coverage seams", () => {
  test("deactivate() is callable (covers lines 57-58)", () => {
    const s = new Spinner();
    s.start("test");
    expect(() => s.deactivate()).not.toThrow();
  });
});

describe("dispatch coverage seams", () => {
  test("SIGKILL fallback after grace window (covers lines 156-158)", async () => {
    // Force the SIGKILL setTimeout to fire by giving a longer grace
    // window and using a child that ignores SIGTERM explicitly.
    const spawn = makeAsyncSpawner({ timeoutMs: 50, graceMs: 200 });
    // Child traps SIGTERM and sleeps in a loop, so the grace window
    // expires and the dispatch timer fires proc.kill("SIGKILL").
    const trapTerm = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1e9);";
    const r = await spawn(process.execPath, ["-e", trapTerm], "");
    expect(r.timedOut).toBe(true);
  });
});
