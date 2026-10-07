import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type UpdateCommandSeams, defaultSpawnInstall, update } from "../src/commands/update.js";
import type { UpdateRequestV1 } from "../src/update/update-contract.js";

interface Harness {
  seams: UpdateCommandSeams;
  lines: string[];
  installs: string[][];
  requests: { base: string; request: UpdateRequestV1 }[];
}

function harness(over: Record<string, unknown> = {}): Harness {
  const lines: string[] = [];
  const installs: string[][] = [];
  const requests: { base: string; request: UpdateRequestV1 }[] = [];
  let clock = 1_700_000_000_000;
  let installedCall = 0;
  const seams: UpdateCommandSeams = {
    fetchLatest: async () => "0.21.0",
    readInstalled: () => (++installedCall === 1 ? "0.20.0" : "0.21.0"),
    spawner: (cmd: string, args: readonly string[]) => {
      installs.push([cmd, ...args]);
      return { status: 0 };
    },
    enumerate: () => [{ base: "/repo", pid: 111, port: 7799, app_version: "0.20.0" }],
    writeRequest: (base: string, request: UpdateRequestV1) => {
      requests.push({ base, request });
    },
    readHandoff: () => {
      const request = requests.at(-1)?.request;
      if (!request) return null;
      return {
        schema_version: "1.0",
        request_id: request.request_id,
        state: "drained",
        from_version: "0.20.0",
        target_version: request.target_version,
        at: clock,
      };
    },
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    drainWaitMs: 5_000,
    readSettings: () => ({}),
    outFn: (_channel: string, ...parts: unknown[]) => {
      lines.push(parts.filter((p) => typeof p === "string").join(" "));
    },
  };
  Object.assign(seams, over);
  return { seams, lines, installs, requests };
}

describe("vf update", () => {
  test("up to date: no install, exit 0", async () => {
    const h = harness({ fetchLatest: async () => "0.20.0" });
    expect(await update([], {}, h.seams)).toBe(0);
    expect(h.installs).toEqual([]);
    expect(h.lines.some((l) => l.includes("up to date"))).toBe(true);
  });
  test("registry unreachable: exit 1", async () => {
    const h = harness({ fetchLatest: async () => null });
    expect(await update([], {}, h.seams)).toBe(1);
  });
  test("--check reports without installing", async () => {
    const h = harness();
    expect(await update([], { check: true }, h.seams)).toBe(0);
    expect(h.installs).toEqual([]);
    expect(h.lines.some((l) => l.includes("0.21.0"))).toBe(true);
  });
  test("--check up to date stays clean", async () => {
    const h = harness({ fetchLatest: async () => "0.20.0" });
    expect(await update([], { check: true }, h.seams)).toBe(0);
    expect(h.lines.some((l) => l.includes("up to date"))).toBe(true);
  });
  test("--check with an unreachable registry exits 1", async () => {
    const h = harness({ fetchLatest: async () => null });
    expect(await update([], { check: true }, h.seams)).toBe(1);
  });
  test("installs latest and drains the stale server", async () => {
    const h = harness();
    expect(await update([], {}, h.seams)).toBe(0);
    expect(h.installs).toEqual([["npm", "install", "-g", "@magicpro97/vibeflow@0.21.0"]]);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.request.target_version).toBe("0.21.0");
    expect(h.lines.some((l) => l.includes("drained"))).toBe(true);
  });
  test("install failure exits 1 and skips restarts", async () => {
    const h = harness({ spawner: () => ({ status: 1 }) });
    expect(await update([], {}, h.seams)).toBe(1);
    expect(h.requests).toEqual([]);
  });
  test("post-install version unchanged exits 1", async () => {
    const h = harness({ readInstalled: () => "0.20.0" });
    expect(await update([], {}, h.seams)).toBe(1);
    expect(h.requests).toEqual([]);
  });
  test("--force skips the unchanged-version guard", async () => {
    const h = harness({
      readInstalled: () => "0.20.0",
      enumerate: () => [{ base: "/repo", pid: 111, port: 7799, app_version: "0.19.0" }],
    });
    expect(await update([], { spec: "./pkg.tgz", force: true }, h.seams)).toBe(0);
    expect(h.requests[0]?.request.target_version).toBe("0.20.0");
  });
  test("an exact prerelease upgrade counts as changed and hands off (precedence)", async () => {
    let installedCall = 0;
    const h = harness({
      fetchLatest: async () => "0.21.0-rc.2",
      readInstalled: () => (++installedCall === 1 ? "0.21.0-rc.1" : "0.21.0-rc.2"),
      enumerate: () => [{ base: "/repo", pid: 111, port: 7799, app_version: "0.21.0-rc.1" }],
    });
    expect(await update([], {}, h.seams)).toBe(0); // no --force needed: rc.2 > rc.1
    expect(h.installs).toEqual([["npm", "install", "-g", "@magicpro97/vibeflow@0.21.0-rc.2"]]);
    expect(h.requests[0]?.request.target_version).toBe("0.21.0-rc.2");
  });
  test("--no-restart installs only", async () => {
    const h = harness();
    expect(await update([], { "no-restart": true }, h.seams)).toBe(0);
    expect(h.installs).toHaveLength(1);
    expect(h.requests).toEqual([]);
  });
  test("--spec skips the registry and installs the given spec", async () => {
    const h = harness({
      fetchLatest: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(await update([], { spec: "./pkg.tgz" }, h.seams)).toBe(0);
    expect(h.installs).toEqual([["npm", "install", "-g", "./pkg.tgz"]]);
    expect(h.requests[0]?.request.target_version).toBe("0.21.0");
  });
  test("--manager bun switches the argv", async () => {
    const h = harness();
    expect(await update([], { manager: "bun" }, h.seams)).toBe(0);
    expect(h.installs[0]?.[0]).toBe("bun");
  });
  test("settings update.manager is the fallback when no flag is given", async () => {
    const h = harness({ readSettings: () => ({ update: { mode: "notify", manager: "pnpm" } }) });
    expect(await update([], {}, h.seams)).toBe(0);
    expect(h.installs[0]?.[0]).toBe("pnpm");
  });
  test("invalid --manager exits 2", async () => {
    const h = harness();
    expect(await update([], { manager: "yarn" }, h.seams)).toBe(2);
  });
  test("no stale servers: reports and exits 0", async () => {
    const h = harness({
      enumerate: () => [{ base: "/repo", pid: 1, port: 1, app_version: "0.21.0" }],
    });
    expect(await update([], {}, h.seams)).toBe(0);
    expect(h.requests).toEqual([]);
    expect(h.lines.some((l) => l.includes("No running vf ui server"))).toBe(true);
  });
  test("a failed server outcome exits 1", async () => {
    const h = harness({
      readHandoff: () => ({
        schema_version: "1.0",
        request_id: "other",
        state: "drained",
        from_version: "0.20.0",
        target_version: "0.21.0",
        at: 0,
      }),
    });
    expect(await update([], {}, h.seams)).toBe(1);
    expect(h.lines.some((l) => l.includes("timed out"))).toBe(true);
  });
  test("a matching failed state reports its reason", async () => {
    const h = harness({
      readHandoff: () => {
        const request = h.requests.at(-1)?.request;
        return {
          schema_version: "1.0",
          request_id: request?.request_id ?? "x",
          state: "failed",
          failure: "boom",
          from_version: "0.20.0",
          target_version: "0.21.0",
          at: 0,
        };
      },
    });
    expect(await update([], {}, h.seams)).toBe(1);
    expect(h.lines.some((l) => l.includes("boom"))).toBe(true);
  });
  test("drain wait: the real sleep runs once, then times out", async () => {
    // No `sleep`/`now` injection: the drain loop must execute the REAL
    // `defaultSleep(500)` once (src/commands/update.ts:50). A drain window
    // narrower than that sleep makes the first deadline check miss and the
    // check after the 500ms trip the timeout. (`drainWaitMs` must stay well
    // above a couple of milliseconds: a window of 1-2ms could racily be
    // crossed between the two adjacent clock reads and skip the sleep.)
    const h = harness({
      sleep: undefined,
      now: undefined,
      drainWaitMs: 400,
      readHandoff: () => null,
    });
    const started = Date.now();
    expect(await update([], {}, h.seams)).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(h.lines.some((l) => l.includes("timed out"))).toBe(true);
  });
  test("default outFn covers the up-to-date path (no injection)", async () => {
    const seams = { fetchLatest: async () => "0.20.0", readInstalled: () => "0.20.0" };
    expect(await update([], {}, seams)).toBe(0);
  });
  test("defaultSpawnInstall runs a real (trivial) command and reports its status", () => {
    expect(defaultSpawnInstall(process.execPath, ["-e", "0"]).status).toBe(0);
  });
  test("the real install runner routes through the canonical shim predicate (win32 layouts)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "commands", "update.ts"), "utf8");
    expect(src).toContain("shouldUseWindowsShell(cmd, resolved)");
    expect(src).toContain("shellLaunchArgv(cmd, args, true)");
  });
});
