import { describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasCommand as hasCommandCore, needsShellForCommand } from "../src/core.js";
import { decideSemgrepResult, runSemgrep } from "../src/verify/semgrep.js";

/** True when `cmd` is on PATH. Lets the suite skip cleanly on hosts where
 * semgrep isn't installed (CI installs it via pip; dev laptops may not). */
function hasCommand(cmd: string): boolean {
  return hasCommandCore(cmd);
}

const semgrepOk = hasCommand("semgrep");

/**
 * Build a minimal `SpawnSyncReturns<string>` for unit testing the
 * decision function without actually spawning semgrep.
 */
function makeSpawnResult(
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  return {
    pid: 0,
    output: [""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  } as SpawnSyncReturns<string>;
}

describe("runSemgrep (integration)", () => {
  test("returns ok with no findings when no .semgrep.yml present", () => {
    const dir = mkdtempSync(join(tmpdir(), "vfsg-"));
    const r = runSemgrep(dir);
    expect(r.ok).toBe(true);
    expect(r.missing).toBe(true);
  });

  test.if(semgrepOk)("returns ok with zero findings on clean code", () => {
    const dir = mkdtempSync(join(tmpdir(), "vfsg-"));
    mkdirSync(join(dir, ".semgrep"), { recursive: true });
    writeFileSync(join(dir, ".semgrep.yml"), "rules: [.semgrep/clean.yml]\n");
    writeFileSync(
      join(dir, ".semgrep/clean.yml"),
      "rules:\n  - id: dummy\n    languages: [ts]\n    severity: INFO\n    message: x\n    pattern: foo\n",
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/index.ts"), "export const x = 1;\n");
    const r = runSemgrep(dir);
    expect(r.findings).toBe(0);
  });

  test.if(semgrepOk)("flags a planted shell-injection violation", () => {
    const dir = mkdtempSync(join(tmpdir(), "vfsg-"));
    mkdirSync(join(dir, ".semgrep"), { recursive: true });
    writeFileSync(join(dir, ".semgrep.yml"), "rules: [.semgrep/bad.yml]\n");
    writeFileSync(
      join(dir, ".semgrep/bad.yml"),
      "rules:\n  - id: bad-shell\n    languages: [ts]\n    severity: ERROR\n    message: bad\n    pattern: spawnSync($CMD, { shell: true })\n",
    );
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src/a.ts"),
      `import { spawnSync } from "node:child_process";\nspawnSync("x", { shell: true });\n`,
    );
    const r = runSemgrep(dir);
    expect(r.ok).toBe(false);
    expect(r.findings).toBeGreaterThan(0);
  });

  test("soft-passes with missing:true when semgrep binary is not installed (ENOENT)", () => {
    // Mock a spawn that always returns ENOENT — the same path that real
    // spawnSync takes when the binary is absent. The integration behaviour
    // here is what `runSemgrep` did before this fix; this test pins it.
    const dir = mkdtempSync(join(tmpdir(), "vfsg-"));
    writeFileSync(join(dir, ".semgrep.yml"), "rules: []\n");
    const fakeEnoent = makeSpawnResult({
      status: null,
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    });
    const r = runSemgrep(dir, {
      spawn: (_cmd, _args, _opts) => fakeEnoent,
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toBe(true);
    expect(r.parseError).toBe(false);
    expect(r.findings).toBe(0);
  });

  test("delegates non-ENOENT spawn results to decideSemgrepResult (no soft-pass)", () => {
    // When the binary IS installed (not ENOENT), runSemgrep should fall
    // through to the pure decision function instead of soft-passing as
    // missing. This is the production happy path: status=0 → ok clean.
    const dir = mkdtempSync(join(tmpdir(), "vfsg-"));
    writeFileSync(join(dir, ".semgrep.yml"), "rules: []\n");
    const fakeClean = makeSpawnResult({
      status: 0,
      stdout: JSON.stringify({ results: [] }),
    });
    const r = runSemgrep(dir, {
      spawn: (_cmd, _args, _opts) => fakeClean,
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toBe(false); // NOT soft-passed
    expect(r.parseError).toBe(false);
    expect(r.findings).toBe(0);
    expect(r.raw).toBe(JSON.stringify({ results: [] }));
  });
});

describe("decideSemgrepResult (pure decision function — contract test)", () => {
  // The decision function is the only place that translates spawnSync output
  // into a SemgrepResult. Testing it directly (no real binary, no PATH
  // mocking) gives us real coverage of every branch in the contract.

  test("status:0 with valid JSON 0 findings → ok:true, findings:0, parseError:false", () => {
    const r = makeSpawnResult({
      status: 0,
      stdout: JSON.stringify({ results: [] }),
    });
    const d = decideSemgrepResult(r);
    expect(d.ok).toBe(true);
    expect(d.findings).toBe(0);
    expect(d.parseError).toBe(false);
    expect(d.raw).toBe(JSON.stringify({ results: [] }));
  });

  test("status:0 always means ok:true, findings:0 (clean exit, even with JSON present)", () => {
    // Semgrep's --error flag means non-zero only on findings. status:0 is
    // always clean. If JSON is present, the count is irrelevant — the
    // exit status is the source of truth.
    const r = makeSpawnResult({
      status: 0,
      stdout: JSON.stringify({
        results: [{ check_id: "x" }, { check_id: "y" }, { check_id: "z" }],
      }),
    });
    const d = decideSemgrepResult(r);
    expect(d.ok).toBe(true);
    expect(d.findings).toBe(0);
    expect(d.parseError).toBe(false);
  });

  test("non-zero status with valid JSON findings → ok:false, findings:N, parseError:false", () => {
    // --error exits non-zero on findings; the JSON is still valid
    const r = makeSpawnResult({
      status: 1,
      stdout: JSON.stringify({ results: [{ check_id: "x" }] }),
    });
    const d = decideSemgrepResult(r);
    expect(d.ok).toBe(false);
    expect(d.findings).toBe(1);
    expect(d.parseError).toBe(false);
  });

  test("non-zero status with unparseable stdout → ok:false, findings:-1, parseError:true (THE -1 SENTINEL)", () => {
    // This is the contract that was previously unverified: when semgrep
    // exits non-zero AND its stdout is unparseable, we must use the -1
    // sentinel so downstream code can branch on parseError rather than
    // mis-reporting "0 findings" + parseError:true.
    const r = makeSpawnResult({
      status: 1,
      stdout: "this is not json\n",
      stderr: "rules invalid",
    });
    const d = decideSemgrepResult(r);
    expect(d.ok).toBe(false);
    expect(d.findings).toBe(-1);
    expect(d.parseError).toBe(true);
    expect(d.raw).toBe("this is not json\n");
  });

  test("null status with no error → ok:false, findings:-1, parseError:true (BEFORE FIX: fell through to JSON.parse and silently hard-failed)", () => {
    // The path that the previous code missed: r.status === null with no
    // r.error. We added an explicit branch so this doesn't try to JSON.parse
    // empty stdout and produce the misleading "0 findings + parseError:true".
    const r = makeSpawnResult({ status: null });
    const d = decideSemgrepResult(r);
    expect(d.ok).toBe(false);
    expect(d.findings).toBe(-1);
    expect(d.parseError).toBe(true);
  });

  test("empty stdout with non-zero status → ok:false, findings:0, parseError:false ('{}' parses cleanly)", () => {
    // Empty stdout with non-zero status falls back to '{}' which parses
    // cleanly as 0 findings. The non-zero status makes ok:false. This is
    // the same behaviour as the original code — not ideal (semgrep may
    // have failed for an unknown reason), but the parse-error sentinel
    // is reserved for actual JSON parse failures, not empty stdout.
    const r = makeSpawnResult({ status: 1, stdout: "" });
    const d = decideSemgrepResult(r);
    expect(d.ok).toBe(false);
    expect(d.findings).toBe(0);
    expect(d.parseError).toBe(false);
  });
});

describe("core utilities", () => {
  test("hasCommand: true for commands that exist on PATH (e.g. git)", () => {
    expect(hasCommand("git")).toBe(true);
  });

  test("hasCommand: false for commands that don't exist", () => {
    expect(hasCommand("definitely-not-a-real-cmd-xyzzy")).toBe(false);
  });

  test("needsShellForCommand: only true on win32 with .cmd/.bat", () => {
    if (process.platform === "win32") {
      expect(needsShellForCommand("foo.cmd")).toBe(true);
      expect(needsShellForCommand("foo.bat")).toBe(true);
      expect(needsShellForCommand("foo.exe")).toBe(false);
    } else {
      // On non-Windows, the function is always false regardless of ext.
      expect(needsShellForCommand("foo.cmd")).toBe(false);
      expect(needsShellForCommand("foo.bat")).toBe(false);
    }
  });
});
