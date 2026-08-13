import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "../src/commands.js";
import { writeState } from "../src/core.js";
import { type SandboxRuntime, lockfileDigest } from "../src/sandbox.js";
import { asSpawnSync, makeFakeSpawner } from "./helpers/fake-spawner.js";

const image = "example/vf@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function project(): string {
  const base = mkdtempSync(join(tmpdir(), "vf-sandbox-verify-"));
  mkdirSync(join(base, "scripts"), { recursive: true });
  writeFileSync(join(base, "bun.lock"), "lock");
  writeFileSync(join(base, "package.json"), JSON.stringify({ scripts: { lint: "biome check" } }));
  writeFileSync(join(base, "scripts", "waiver-policy.cjs"), "process.exit(0)\n");
  execFileSync("git", ["init", "-q"], { cwd: base });
  execFileSync("git", ["add", "bun.lock", "package.json", "scripts/waiver-policy.cjs"], {
    cwd: base,
  });
  writeState(base, {
    task_id: "T554",
    goal: "sandbox verify",
    success_criteria: [],
    work_units: [],
    totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  });
  return base;
}

function runtime(base: string, docker = true): SandboxRuntime {
  const digest = lockfileDigest(base);
  return {
    hasDocker: () => docker,
    run: (args) => ({
      status: 0,
      stdout: args[0] === "volume" ? `${digest}\n` : "",
      stderr: "",
    }),
    uid: () => 501,
    gid: () => 20,
  };
}

describe("verify docker sandbox (#554)", () => {
  test("fails closed before gate spawn when Docker is unavailable", () => {
    const base = project();
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const callerCwd = process.cwd();
    try {
      expect(
        verify({
          projectDir: base,
          requireReviewEvidence: false,
          sandbox: { image, dependencyVolume: "vf-deps" },
          sandboxRuntime: runtime(base, false),
          spawner: asSpawnSync(makeFakeSpawner({ calls })),
        }),
      ).toBe(1);
      expect(calls).toHaveLength(0);
      expect(process.cwd()).toBe(callerCwd);
    } finally {
      try {
        expect(process.cwd()).toBe(callerCwd);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  });

  test("runs gates in hardened Docker argv and removes disposable target", () => {
    const base = project();
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const callerCwd = process.cwd();
    try {
      expect(
        verify({
          projectDir: base,
          requireReviewEvidence: false,
          sandbox: { image, dependencyVolume: "vf-deps" },
          sandboxRuntime: runtime(base),
          spawner: asSpawnSync(makeFakeSpawner({ calls })),
        }),
      ).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.cmd === "docker")).toBe(true);
      const args = calls[0]?.args ?? [];
      expect(args).toContain("--network");
      expect(args).toContain("none");
      expect(args).toContain("--cap-drop");
      expect(args).not.toContain("-e");
      const mounted = String(args[args.indexOf("-v") + 1]).replace(/:\/w$/, "");
      expect(mounted).not.toBe(base);
      expect(existsSync(mounted)).toBe(false);
      expect(process.cwd()).toBe(callerCwd);
    } finally {
      try {
        expect(process.cwd()).toBe(callerCwd);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  });

  test("force-removes a timed-out container and fails the gate", () => {
    const base = project();
    const runtimeCalls: string[][] = [];
    const sandboxRuntime = runtime(base);
    sandboxRuntime.run = (args) => {
      runtimeCalls.push(args);
      return {
        status: 0,
        stdout: args[0] === "volume" ? `${lockfileDigest(base)}\n` : "",
        stderr: "",
      };
    };
    const callerCwd = process.cwd();
    try {
      expect(
        verify({
          projectDir: base,
          requireReviewEvidence: false,
          sandbox: { image, dependencyVolume: "vf-deps" },
          sandboxRuntime,
          spawner: asSpawnSync(makeFakeSpawner({ defaultStatus: null })),
        }),
      ).toBe(1);
      expect(runtimeCalls.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
      expect(process.cwd()).toBe(callerCwd);
    } finally {
      try {
        expect(process.cwd()).toBe(callerCwd);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  });
});
