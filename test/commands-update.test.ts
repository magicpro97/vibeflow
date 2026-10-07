import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type UpdateCommandSeams, defaultSpawnInstall, update } from "../src/commands/update.js";
import type { UpdateRequestV1 } from "../src/update/update-contract.js";
import type { UpdateStateV1 } from "../src/update/update-state.js";

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
    writeState: () => {},
    acquireLock: () => async () => {},
    writeAutoMarker: () => {},
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
  test("a successful update records the previous version for rollback", async () => {
    const states: UpdateStateV1[] = [];
    const h = harness({ writeState: (s: UpdateStateV1) => states.push(s) });
    expect(await update([], {}, h.seams)).toBe(0);
    expect(states).toEqual([
      expect.objectContaining({ schema_version: 1, previous_version: "0.20.0", manager: "npm" }),
    ]);
  });
  test("--rollback reinstalls the recorded version without --force (downgrade is a change)", async () => {
    const states: UpdateStateV1[] = [];
    let installedCall = 0;
    const h = harness({
      readState: () => ({ schema_version: 1, previous_version: "0.20.9", manager: "npm", at: 1 }),
      readInstalled: () => (++installedCall === 1 ? "0.21.0" : "0.20.9"),
      // A server on OLDER code than the rollback target is stale and MUST be swapped.
      enumerate: () => [{ base: "/repo", pid: 111, port: 7799, app_version: "0.20.0" }],
      writeState: (s: UpdateStateV1) => states.push(s),
    });
    expect(await update([], { rollback: true }, h.seams)).toBe(0);
    expect(h.installs).toEqual([["npm", "install", "-g", "@magicpro97/vibeflow@0.20.9"]]);
    expect(states[0]?.previous_version).toBe("0.21.0"); // record swaps → toggle semantics
    expect(h.requests[0]?.request.target_version).toBe("0.20.9");
  });
  test("a running server NEWER than the rollback target is left alone (no live downgrade)", async () => {
    let installedCall = 0;
    const h = harness({
      readState: () => ({ schema_version: 1, previous_version: "0.20.9", manager: "npm", at: 1 }),
      readInstalled: () => (++installedCall === 1 ? "0.21.0" : "0.20.9"),
      enumerate: () => [{ base: "/repo", pid: 111, port: 7799, app_version: "0.21.0" }],
    });
    expect(await update([], { rollback: true }, h.seams)).toBe(0);
    expect(h.installs).toHaveLength(1); // the install happened…
    expect(h.requests).toEqual([]); // …and the newer live frontend keeps serving
  });
  test("--rollback when already on the recorded version exits 1 without installing", async () => {
    const h = harness({
      readState: () => ({ schema_version: 1, previous_version: "0.21.0", manager: "npm", at: 1 }),
      readInstalled: () => "0.21.0",
    });
    expect(await update([], { rollback: true }, h.seams)).toBe(1);
    expect(h.installs).toEqual([]);
  });
  test("--rollback defaults to the manager recorded with the undo point", async () => {
    const states: UpdateStateV1[] = [];
    let installedCall = 0;
    const h = harness({
      readState: () => ({ schema_version: 1, previous_version: "0.20.9", manager: "pnpm", at: 1 }),
      readInstalled: () => (++installedCall === 1 ? "0.21.0" : "0.20.9"),
      enumerate: () => [{ base: "/repo", pid: 111, port: 7799, app_version: "0.21.0" }],
      writeState: (s: UpdateStateV1) => states.push(s),
    });
    expect(await update([], { rollback: true }, h.seams)).toBe(0);
    expect(h.installs).toEqual([["pnpm", "add", "-g", "@magicpro97/vibeflow@0.20.9"]]);
    expect(states[0]?.manager).toBe("pnpm"); // the swap records the manager that ran
  });
  test("--rollback honors an explicit --manager over the recorded one", async () => {
    let installedCall = 0;
    const h = harness({
      readState: () => ({ schema_version: 1, previous_version: "0.20.9", manager: "pnpm", at: 1 }),
      readInstalled: () => (++installedCall === 1 ? "0.21.0" : "0.20.9"),
      enumerate: () => [{ base: "/repo", pid: 111, port: 7799, app_version: "0.21.0" }],
    });
    expect(await update([], { rollback: true, manager: "bun" }, h.seams)).toBe(0);
    expect(h.installs).toEqual([["bun", "add", "-g", "@magicpro97/vibeflow@0.20.9"]]);
  });
  test("--rollback without a record exits 2 and names the manual escape hatch", async () => {
    const h = harness({ readState: () => null });
    expect(await update([], { rollback: true }, h.seams)).toBe(2);
    expect(h.installs).toEqual([]);
  });
  test("--rollback combined with --spec or --check is refused before any install", async () => {
    const flagSets: Record<string, string | boolean>[] = [
      { rollback: true, spec: "./pkg.tgz" },
      { rollback: true, check: true },
    ];
    for (const flags of flagSets) {
      const h = harness();
      expect(await update([], flags, h.seams)).toBe(2);
      expect(h.installs).toEqual([]);
    }
  });
  test("--force with an unchanged version writes no record (no same-version undo point)", async () => {
    const states: UpdateStateV1[] = [];
    const h = harness({
      fetchLatest: async () => "0.22.0", // newer than installed → apply() really runs
      readInstalled: () => "0.21.0", // …and the install keeps the version
      writeState: (s: UpdateStateV1) => states.push(s),
    });
    expect(await update([], { force: true }, h.seams)).toBe(0);
    expect(h.installs).toEqual([["npm", "install", "-g", "@magicpro97/vibeflow@0.22.0"]]);
    expect(states).toEqual([]);
  });
  test("refuses to start a second update while the machine-global lock is held", async () => {
    const h = harness({ acquireLock: () => null });
    expect(await update([], {}, h.seams)).toBe(1);
    expect(h.installs).toEqual([]);
    expect(h.lines.some((l) => l.includes("already running"))).toBe(true);
  });
  test("releases the lock after a successful update", async () => {
    let releases = 0;
    const h = harness({
      acquireLock: () => async () => {
        releases += 1;
      },
    });
    expect(await update([], {}, h.seams)).toBe(0);
    expect(releases).toBe(1);
  });
  test("releases the lock when the install fails", async () => {
    let releases = 0;
    const h = harness({
      spawner: () => ({ status: 1 }),
      acquireLock: () => async () => {
        releases += 1;
      },
    });
    expect(await update([], {}, h.seams)).toBe(1);
    expect(releases).toBe(1);
  });
  test("a version-changing install refreshes the auto-update marker", async () => {
    const markers: { version: string; attempted_at: number }[] = [];
    const h = harness({
      writeAutoMarker: (m: { version: string; attempted_at: number }) => markers.push(m),
    });
    expect(await update([], {}, h.seams)).toBe(0);
    expect(markers).toEqual([expect.objectContaining({ version: "0.21.0" })]);
  });
  test("a same-version --force install writes no auto-update marker", async () => {
    const markers: { version: string }[] = [];
    const h = harness({
      fetchLatest: async () => "0.22.0",
      readInstalled: () => "0.21.0",
      writeAutoMarker: (m: { version: string }) => markers.push(m),
    });
    expect(await update([], { force: true }, h.seams)).toBe(0);
    expect(markers).toEqual([]);
  });
});
