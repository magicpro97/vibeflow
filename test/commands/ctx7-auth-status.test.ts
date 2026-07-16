import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../../src/commands.js";
import {
  CTX7_AUTH_STATUS_REL,
  ensureCtx7Auth,
  writeCtx7AuthStatus,
} from "../../src/commands/init-ctx7.js";
import type { EngineReadiness } from "../../src/preflight.js";

function r(
  engine: "claude" | "codex" | "copilot" | "opencode",
  level: EngineReadiness["level"],
  detail?: string,
): EngineReadiness {
  return { engine, level, detail: detail ?? level, checkedAt: "" };
}

describe("ensureCtx7Auth — non-TTY warning (#630)", () => {
  test("non-TTY emits warning and writes status file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-ctx7-"));
    const ctxDir = join(tmp, ".vibeflow", "ai-context");
    mkdirSync(ctxDir, { recursive: true });

    // Capture output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const result = await ensureCtx7Auth({
        spawner: (() => ({ status: 1, stdout: "", stderr: "" })) as any,
        base: tmp,
      });

      expect(result.authenticated).toBe(false);
      expect(result.fallback).toBe(true);
      expect(result.mode).toBe("non-tty-fallback");

      // Warning emitted
      expect(logs.some((l) => l.includes("non-interactive"))).toBe(true);

      // Status file written
      const statusPath = join(tmp, ".vibeflow", CTX7_AUTH_STATUS_REL);
      expect(existsSync(statusPath)).toBe(true);
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      expect(status.authenticated).toBe(false);
      expect(status.mode).toBe("non-tty-fallback");
      expect(status.timestamp).toBeDefined();
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
      console.log = origLog;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("TTY + already authenticated writes status file with mode tty", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-ctx7-"));
    mkdirSync(join(tmp, ".vibeflow", "ai-context"), { recursive: true });

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const result = await ensureCtx7Auth({
        spawner: (() => ({ status: 0, stdout: "user@example.com", stderr: "" })) as any,
        base: tmp,
      });

      expect(result.authenticated).toBe(true);
      expect(result.mode).toBe("tty");

      const statusPath = join(tmp, ".vibeflow", CTX7_AUTH_STATUS_REL);
      expect(existsSync(statusPath)).toBe(true);
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      expect(status.authenticated).toBe(true);
      expect(status.mode).toBe("tty");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("TTY + user skips login writes tty-skipped", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-ctx7-"));
    mkdirSync(join(tmp, ".vibeflow", "ai-context"), { recursive: true });

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const result = await ensureCtx7Auth({
        spawner: (() => ({ status: 1, stdout: "Not logged in", stderr: "" })) as any,
        askConfirm: async () => false,
        base: tmp,
      });

      expect(result.authenticated).toBe(false);
      expect(result.mode).toBe("tty-skipped");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("writeCtx7AuthStatus", () => {
  test("writes JSON with authenticated, mode, timestamp", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-ctx7-"));
    mkdirSync(join(tmp, ".vibeflow", "ai-context"), { recursive: true });
    try {
      writeCtx7AuthStatus(tmp, { authenticated: true, fallback: false, mode: "tty" });
      const statusPath = join(tmp, ".vibeflow", CTX7_AUTH_STATUS_REL);
      const data = JSON.parse(readFileSync(statusPath, "utf8"));
      expect(data.authenticated).toBe(true);
      expect(data.mode).toBe("tty");
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("does not throw when directory missing (best-effort)", () => {
    // Non-existent base — should not throw
    expect(() =>
      writeCtx7AuthStatus("/nonexistent/path", {
        authenticated: false,
        fallback: true,
        mode: "non-tty-fallback",
      }),
    ).not.toThrow();
  });
});

describe("vf doctor — ctx7 auth status line (#630)", () => {
  test("prints unauthenticated line when status file present with fallback", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-doctor-ctx7-"));
    const ctxDir = join(tmp, ".vibeflow", "ai-context");
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(
      join(tmp, ".vibeflow", CTX7_AUTH_STATUS_REL),
      JSON.stringify({ authenticated: false, mode: "non-tty-fallback", timestamp: "2026-07-16T00:00:00Z" }),
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const code = await doctor(
        {},
        { readiness: [r("claude", "ready")], base: tmp },
      );
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes("ctx7: unauthenticated"))).toBe(true);
      expect(logs.some((l) => l.includes("HTTP fallback"))).toBe(true);
    } finally {
      console.log = origLog;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("prints authenticated line when status file shows authenticated", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-doctor-ctx7-"));
    const ctxDir = join(tmp, ".vibeflow", "ai-context");
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(
      join(tmp, ".vibeflow", CTX7_AUTH_STATUS_REL),
      JSON.stringify({ authenticated: true, mode: "tty", timestamp: "2026-07-16T00:00:00Z" }),
    );

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const code = await doctor(
        {},
        { readiness: [r("claude", "ready")], base: tmp },
      );
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes("ctx7:") && l.includes("authenticated"))).toBe(true);
    } finally {
      console.log = origLog;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("prints nothing when status file absent", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-doctor-ctx7-"));
    mkdirSync(tmp, { recursive: true });

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const code = await doctor(
        {},
        { readiness: [r("claude", "ready")], base: tmp },
      );
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes("ctx7:"))).toBe(false);
    } finally {
      console.log = origLog;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("prints nothing when status file is malformed JSON", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "vf-doctor-ctx7-"));
    const ctxDir = join(tmp, ".vibeflow", "ai-context");
    mkdirSync(ctxDir, { recursive: true });
    writeFileSync(join(tmp, ".vibeflow", CTX7_AUTH_STATUS_REL), "not json{{{");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const code = await doctor(
        {},
        { readiness: [r("claude", "ready")], base: tmp },
      );
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes("ctx7:"))).toBe(false);
    } finally {
      console.log = origLog;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
