// test/resources-quota.test.ts
//
// Best-effort engine quota probe (Task 3 of the resource-management plan).
// No real spawn anywhere: `probeQuota` is driven by injected runners, and the
// default runner's process seam is covered via `createProbeRunner(fakeRt)`.
//
// Manual degradation check (documented per the task brief): on a machine
// without an authenticated `gh`, `vf resources --probe` prints
// `copilot: unknown (probe failed)` — that IS the expected output; the probe
// is best-effort and never throws.

import { describe, expect, test } from "bun:test";
import { parseQuotaOutput } from "../src/engine-quota.js";
import {
  type ProbeRunner,
  type ProbeRuntime,
  RESOURCE_PROBE_COMMANDS,
  createProbeRunner,
  probeQuota,
} from "../src/resources-quota.js";

/** Copilot budget fixture, matching the task brief's literal string. */
const COPILOT_BUDGET = '{"limit":100,"used":88,"remaining":12,"resetAt":"2026-10-10T00:00:00Z"}';

/** Fake runtime seam; every test overrides what it needs — never real I/O. */
function fakeRuntime(over: Partial<ProbeRuntime> = {}): ProbeRuntime {
  return {
    which: () => "/usr/local/bin/gh",
    spawn: () => {
      throw new Error("spawn must be stubbed per test");
    },
    ...over,
  };
}

describe("probeQuota", () => {
  test("copilot fixture: runs the argv table then parseQuotaOutput → warning at 12%", async () => {
    let argv: readonly string[] = [];
    const run: ProbeRunner = async (a) => {
      argv = a;
      return { stdout: COPILOT_BUDGET, exitCode: 0 };
    };
    const status = await probeQuota("copilot", run);
    expect(argv).toEqual(["gh", "api", "user/copilot_billing"]);
    expect(status).toEqual(parseQuotaOutput("copilot", COPILOT_BUDGET));
    expect(status.level).toBe("warning");
    expect(status.percentRemaining).toBe(12);
  });

  test("runner throws → unknown 'probe failed', never throws", async () => {
    const run: ProbeRunner = async () => {
      throw new Error("boom");
    };
    expect(await probeQuota("copilot", run)).toEqual({ level: "unknown", error: "probe failed" });
  });

  test("non-zero exit → unknown 'probe failed'", async () => {
    const run: ProbeRunner = async () => ({ stdout: "", exitCode: 1 });
    expect(await probeQuota("copilot", run)).toEqual({ level: "unknown", error: "probe failed" });
  });

  test("raw runner exit 127 → unknown 'command not found'", async () => {
    const run: ProbeRunner = async () => ({ stdout: "", exitCode: 127 });
    expect(await probeQuota("copilot", run)).toEqual({
      level: "unknown",
      error: "command not found",
    });
  });

  test("engine without a probe command → unknown 'no probe command' (runner untouched)", async () => {
    const run: ProbeRunner = async () => {
      throw new Error("must not run");
    };
    expect(await probeQuota("claude", run)).toEqual({
      level: "unknown",
      error: "no probe command",
    });
  });

  test("command table: frozen, only engines with a stable headless probe", () => {
    expect(Object.keys(RESOURCE_PROBE_COMMANDS)).toEqual(["copilot"]);
    expect(Object.isFrozen(RESOURCE_PROBE_COMMANDS)).toBe(true);
  });
});

describe("createProbeRunner", () => {
  test("undefined runtime (no Bun / Node dist) → unknown 'probe failed'", async () => {
    const run = createProbeRunner(undefined);
    expect(await probeQuota("copilot", run)).toEqual({ level: "unknown", error: "probe failed" });
  });

  test("which miss → exit 127 → unknown 'command not found', no spawn", async () => {
    const run = createProbeRunner(fakeRuntime({ which: () => null }));
    expect(await probeQuota("copilot", run)).toEqual({
      level: "unknown",
      error: "command not found",
    });
  });

  test("spawn seam: reads stdout + exit code → warning at 12%", async () => {
    let spawned: readonly string[] = [];
    const run = createProbeRunner(
      fakeRuntime({
        spawn: (argv) => {
          spawned = argv;
          return {
            exited: Promise.resolve(0),
            stdout: new Response(COPILOT_BUDGET).body,
            kill: () => {},
          };
        },
      }),
    );
    const status = await probeQuota("copilot", run);
    expect(spawned).toEqual(["/usr/local/bin/gh", "api", "user/copilot_billing"]);
    expect(status).toEqual(parseQuotaOutput("copilot", COPILOT_BUDGET));
    expect(status.level).toBe("warning");
    expect(status.percentRemaining).toBe(12);
  });

  test("timeout: kills the child and degrades to 'probe failed'", async () => {
    const kills: Array<string | undefined> = [];
    const run = createProbeRunner(
      fakeRuntime({
        spawn: () => ({
          exited: new Promise<number>(() => {}),
          stdout: new ReadableStream<Uint8Array>(),
          kill: (signal) => kills.push(signal),
        }),
      }),
      10,
    );
    expect(await probeQuota("copilot", run)).toEqual({ level: "unknown", error: "probe failed" });
    expect(kills).toContain("SIGTERM");
  });
});
