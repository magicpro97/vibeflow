import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectVerifyReportAsync } from "../src/commands/tools-detect.js";

// Async-only: the route uses collectVerifyReportAsync (non-blocking); the old
// sync collectVerifyReport was removed because spawnSync froze Bun.serve.

const fakeSpawner = (status: number) => () => Promise.resolve({ status });

// Helper: create a temp dir with a package.json containing the given scripts.
function tempProject(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-verify-test-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }, null, 2));
  return dir;
}

describe("collectVerifyReportAsync", () => {
  test("runs toolchain gates and returns structured report", async () => {
    const report = await collectVerifyReportAsync(process.cwd(), { spawner: fakeSpawner(0) });
    expect(report).toHaveProperty("toolchain");
    expect(report).toHaveProperty("policy");
    expect(Array.isArray(report.toolchain)).toBe(true);
    expect(typeof report.policy).toBe("object");
    expect(Array.isArray(report.policy.passed)).toBe(true);
    expect(Array.isArray(report.policy.warnings)).toBe(true);
    expect(Array.isArray(report.policy.failures)).toBe(true);
    expect(typeof report.ok).toBe("boolean");
  });

  test("marks failing gates in toolchain when spawner returns non-zero", async () => {
    const report = await collectVerifyReportAsync(process.cwd(), { spawner: fakeSpawner(1) });
    expect(report.ok).toBe(false);
    expect(report.toolchain.some((g) => !g.pass)).toBe(true);
  });

  test("structure is correct regardless of pass/fail", async () => {
    const report = await collectVerifyReportAsync(process.cwd(), { spawner: fakeSpawner(0) });
    expect(typeof report.ok).toBe("boolean");
    expect(Array.isArray(report.toolchain)).toBe(true);
  });

  test("toolchain gates have label and pass fields", async () => {
    const report = await collectVerifyReportAsync(process.cwd(), { spawner: fakeSpawner(0) });
    for (const gate of report.toolchain) {
      expect(typeof gate.label).toBe("string");
      expect(typeof gate.pass).toBe("boolean");
    }
  });

  test("default spawner works with real spawn on temp project", async () => {
    // Create a temp project with a typecheck script, then call
    // collectVerifyReportAsync WITHOUT a fake spawner so the real
    // default spawner runs (exercising lines 90-97).
    const dir = tempProject({ typecheck: "exit 0", test: "exit 0" });
    const report = await collectVerifyReportAsync(dir);
    expect(report).toHaveProperty("ok");
    expect(Array.isArray(report.toolchain)).toBe(true);
  });

  test("default spawner error handler on non-existent binary", async () => {
    // Create a temp project with a script that calls a non-existent binary.
    // The default spawner's "error" event handler (line 96) resolves { status: 1 }.
    const dir = tempProject({ lint: "nonexistent-command-xyz-123", test: "exit 0" });
    const report = await collectVerifyReportAsync(dir);
    expect(report).toHaveProperty("ok");
    expect(Array.isArray(report.toolchain)).toBe(true);
    for (const gate of report.toolchain) {
      expect(typeof gate.label).toBe("string");
      expect(typeof gate.pass).toBe("boolean");
    }
  });

  test("gradle toolchain reports pass=false when the check fails", async () => {
    // detectToolchain returns { kind: "gradle" } when build.gradle exists
    // and no package.json is present. A failing gradle check (status 1) must
    // surface pass=false. Uses fakeSpawner(1): the real-spawner default path is
    // already covered by "default spawner error handler on non-existent binary",
    // and GitHub runners ship gradle, so a real `gradle check` hangs >30s (flaky).
    const dir = mkdtempSync(join(tmpdir(), "vf-gradle-test-"));
    writeFileSync(join(dir, "build.gradle"), "");
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(1) });
    expect(report).toHaveProperty("ok");
    expect(report.toolchain.length).toBeGreaterThanOrEqual(1);
    const first = report.toolchain[0] as { label: string; pass: boolean };
    expect(first.pass).toBe(false);
  });

  test("gradle toolchain with fakeSpawner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gradle-test-"));
    writeFileSync(join(dir, "build.gradle"), "");
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0) });
    expect(report).toHaveProperty("ok");
    expect(report.toolchain.length).toBe(1);
    const first = report.toolchain[0] as { label: string; pass: boolean };
    expect(first.label).toMatch(/gradle|check/);
    expect(first.pass).toBe(true);
  });

  test("monorepo toolchain with fakeSpawner", async () => {
    // detectToolchain returns { kind: "monorepo" } when a subdirectory
    // (web/app/frontend) contains a package.json with typecheck/lint/test scripts.
    const dir = mkdtempSync(join(tmpdir(), "vf-monorepo-test-"));
    const webDir = join(dir, "web");
    mkdirSync(webDir, { recursive: true });
    writeFileSync(
      join(webDir, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc", lint: "biome", test: "vitest" } }, null, 2),
    );
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0) });
    expect(report).toHaveProperty("ok");
    expect(report.toolchain.length).toBe(3);
    for (const gate of report.toolchain) {
      expect(gate.label).toContain("(web)");
      expect(gate.pass).toBe(true);
    }
  });

  test("returns ok=false when gradle check fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-gradle-fail-"));
    writeFileSync(join(dir, "build.gradle"), "");
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(1) });
    expect(report.ok).toBe(false);
    expect(report.toolchain.length).toBe(1);
    const first = report.toolchain[0] as { label: string; pass: boolean };
    expect(first.pass).toBe(false);
  });

  test("coverage gate runs when lcov.info exists and coverage=true", async () => {
    const dir = tempProject({ typecheck: "exit 0", test: "exit 0" });
    const covDir = join(dir, "coverage");
    mkdirSync(covDir, { recursive: true });
    writeFileSync(
      join(covDir, "lcov.info"),
      "TN:\nSF:src/index.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n",
    );
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0), coverage: true });
    const covGate = report.toolchain.find((g) => g.label === "coverage:gate") as
      | { label: string; pass: boolean }
      | undefined;
    expect(covGate).toBeDefined();
    expect((covGate as { label: string; pass: boolean }).pass).toBe(true);
  });

  test("coverage gate skipped when lcov.info missing", async () => {
    const dir = tempProject({ typecheck: "exit 0" });
    const report = await collectVerifyReportAsync(dir, { spawner: fakeSpawner(0), coverage: true });
    const covGate = report.toolchain.find((g) => g.label === "coverage:gate");
    expect(covGate).toBeUndefined();
  });
});
