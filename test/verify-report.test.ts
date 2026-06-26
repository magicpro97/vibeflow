import { describe, expect, test } from "bun:test";
import { collectVerifyReport } from "../src/commands/tools-detect.js";

// ponytail: minimal tests for the extracted seam — no framework, no fixtures.

// ponytail: fake spawner cast — avoids full spawnSync overload signature
const fakeSpawner = (status: number) => (() => ({ status, signal: null })) as any;

describe("collectVerifyReport", () => {
  test("runs toolchain gates and returns structured report", () => {
    const report = collectVerifyReport(process.cwd(), { spawner: fakeSpawner(0) });
    expect(report).toHaveProperty("toolchain");
    expect(report).toHaveProperty("policy");
    expect(Array.isArray(report.toolchain)).toBe(true);
    expect(typeof report.policy).toBe("object");
    expect(Array.isArray(report.policy.passed)).toBe(true);
    expect(Array.isArray(report.policy.warnings)).toBe(true);
    expect(Array.isArray(report.policy.failures)).toBe(true);
    expect(typeof report.ok).toBe("boolean");
  });

  test("marks failing gates in toolchain when spawner returns non-zero", () => {
    const report = collectVerifyReport(process.cwd(), { spawner: fakeSpawner(1) });
    expect(report.ok).toBe(false);
    expect(report.toolchain.some((g) => !g.pass)).toBe(true);
  });

  test("structure is correct regardless of pass/fail", () => {
    const report = collectVerifyReport(process.cwd(), { spawner: fakeSpawner(0) });
    expect(typeof report.ok).toBe("boolean");
    expect(Array.isArray(report.toolchain)).toBe(true);
  });

  test("toolchain gates have label and pass fields", () => {
    const report = collectVerifyReport(process.cwd(), { spawner: fakeSpawner(0) });
    for (const gate of report.toolchain) {
      expect(typeof gate.label).toBe("string");
      expect(typeof gate.pass).toBe("boolean");
    }
  });
});
