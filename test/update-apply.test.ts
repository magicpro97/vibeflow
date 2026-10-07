import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultInstallSpec,
  enumerateLiveUiServers,
  installArgv,
  serversNeedingRestart,
} from "../src/update/update-apply.js";

describe("enumerateLiveUiServers", () => {
  test("keeps only alive, pid-bearing servers", () => {
    const servers = enumerateLiveUiServers({
      readRegistry: () => [{ path: "/a" }, { path: "/b" }, { path: "/c" }, { path: "/d" }],
      readDiscovery: (base) =>
        base === "/a"
          ? { port: 7799, pid: 111, hook_origin: "http://127.0.0.1:7799", app_version: "0.20.0" }
          : base === "/b"
            ? { port: 7800, pid: 222, hook_origin: "http://127.0.0.1:7800" } // dead pid below
            : base === "/c"
              ? { port: 7801, hook_origin: "http://127.0.0.1:7801" } // legacy: no pid
              : null,
      isAlive: (pid) => pid === 111,
    });
    expect(servers).toEqual([{ base: "/a", pid: 111, port: 7799, app_version: "0.20.0" }]);
  });

  test("default discovery reader + real liveness probe are exercised", () => {
    const live = mkdtempSync(join(tmpdir(), "vf-update-apply-live-"));
    const gone = mkdtempSync(join(tmpdir(), "vf-update-apply-gone-"));
    try {
      mkdirSync(join(live, ".vibeflow"), { recursive: true });
      writeFileSync(
        join(live, ".vibeflow", ".ui-port"),
        JSON.stringify({
          schema_version: "1.0",
          port: 7123,
          pid: process.pid, // alive by definition
          started_at: 1,
          hook_origin: "http://127.0.0.1:7123",
          app_version: "0.20.0",
        }),
      );
      const servers = enumerateLiveUiServers({
        readRegistry: () => [{ path: live }, { path: gone }, { path: join(gone, "missing") }],
      });
      // `gone` entries have no .ui-port (default reader catch arm); `live` resolves
      // through the real pid probe (no override).
      expect(servers).toEqual([
        { base: live, pid: process.pid, port: 7123, app_version: "0.20.0" },
      ]);
    } finally {
      rmSync(live, { recursive: true, force: true });
      rmSync(gone, { recursive: true, force: true });
    }
  });

  test("a stale pid is filtered out by the real liveness probe", () => {
    const servers = enumerateLiveUiServers({
      readRegistry: () => [{ path: "/tmp" }],
      readDiscovery: () => ({ port: 7124, pid: 2147483646, hook_origin: "http://127.0.0.1:7124" }),
    });
    expect(servers).toEqual([]);
  });
});

describe("serversNeedingRestart", () => {
  test("stale or version-less servers qualify; equal/newer do not", () => {
    const mk = (app_version?: string) => ({
      base: "/x",
      pid: 1,
      port: 1,
      ...(app_version ? { app_version } : {}),
    });
    expect(
      serversNeedingRestart([mk("0.20.0"), mk(), mk("0.21.0"), mk("0.22.0")], "0.21.0"),
    ).toHaveLength(2);
  });
  test("prerelease staleness uses precedence: rc.1 is stale for rc.2, not the reverse", () => {
    const mk = (app_version: string) => ({ base: "/x", pid: 1, port: 1, app_version });
    expect(serversNeedingRestart([mk("0.21.0-rc.1"), mk("0.21.0-rc.2")], "0.21.0-rc.2")).toEqual([
      mk("0.21.0-rc.1"),
    ]);
    expect(serversNeedingRestart([mk("0.21.0-rc.2")], "0.21.0-rc.1")).toEqual([]);
  });
});

describe("installArgv", () => {
  test("manager-specific global installs", () => {
    expect(installArgv("npm", "s")).toEqual({ cmd: "npm", args: ["install", "-g", "s"] });
    expect(installArgv("bun", "s")).toEqual({ cmd: "bun", args: ["add", "-g", "s"] });
    expect(installArgv("pnpm", "s")).toEqual({ cmd: "pnpm", args: ["add", "-g", "s"] });
  });
  test("default spec is the scoped package at the version", () => {
    expect(defaultInstallSpec("0.21.0")).toBe("@magicpro97/vibeflow@0.21.0");
  });
});
