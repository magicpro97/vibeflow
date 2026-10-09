// test/resources-quota.test.ts
//
// Best-effort engine quota probe (Task 3 of the resource-management plan;
// reworked in the Copilot-review fix round). No real spawn anywhere:
// `probeQuota` is driven by injected runners plus a TABLE seam, and the
// default runner's process seam is covered via `createProbeRunner(fakeRt)`.
//
// The production command table is EMPTY by design: no engine currently
// exposes a stable, VERIFIED headless quota command. Verified live on
// 2026-10-09: `gh api user/copilot_billing` (and every other probed route)
// answers 404; `claude usage --json` and `codex doctor --usage` do not
// exist. The table seam below keeps every runner/probe path covered until
// a verified command lands (tracked in #355/#50926) — add an entry ONLY
// after running the command for real.

import { describe, expect, test } from "bun:test";
import { parseQuotaOutput } from "../src/engine-quota.js";
import {
  type ProbeRunner,
  type ProbeRuntime,
  RESOURCE_PROBE_COMMANDS,
  createProbeRunner,
  probeQuota,
} from "../src/resources-quota.js";

/** Generic JSON quota fixture (shape owned by parseQuotaOutput's JSON branch). */
const QUOTA_JSON = '{"limit":100,"used":88,"remaining":12,"resetAt":"2026-10-10T00:00:00Z"}';

/** Test-only command table: a synthetic engine standing in for a future verified command. */
const DEMO_TABLE = Object.freeze({ demo: ["demo-tool", "quota", "--json"] });

/** Fake runtime seam; every test overrides what it needs — never real I/O. */
function fakeRuntime(over: Partial<ProbeRuntime> = {}): ProbeRuntime {
  return {
    which: () => "/usr/local/bin/demo-tool",
    spawn: () => {
      throw new Error("spawn must be stubbed per test");
    },
    ...over,
  };
}

describe("RESOURCE_PROBE_COMMANDS", () => {
  test("frozen, and EMPTY until a verified headless quota command exists (#355/#50926)", () => {
    expect(Object.keys(RESOURCE_PROBE_COMMANDS)).toEqual([]);
    expect(Object.isFrozen(RESOURCE_PROBE_COMMANDS)).toBe(true);
  });
});

describe("probeQuota", () => {
  test("table seam: runs the argv entry then parseQuotaOutput → warning at 12%", async () => {
    let argv: readonly string[] = [];
    const run: ProbeRunner = async (a) => {
      argv = a;
      return { stdout: QUOTA_JSON, exitCode: 0 };
    };
    const status = await probeQuota("demo", run, DEMO_TABLE);
    expect(argv).toEqual(["demo-tool", "quota", "--json"]);
    expect(status).toEqual(parseQuotaOutput("demo", QUOTA_JSON));
    expect(status.level).toBe("warning");
    expect(status.percentRemaining).toBe(12);
  });

  test("empty production table: every engine → unknown 'no probe command' (runner untouched)", async () => {
    const run: ProbeRunner = async () => {
      throw new Error("must not run");
    };
    for (const engine of ["copilot", "claude", "codex"]) {
      expect(await probeQuota(engine, run)).toEqual({
        level: "unknown",
        error: "no probe command",
      });
    }
  });

  test("runner throws → unknown 'probe failed', never throws", async () => {
    const run: ProbeRunner = async () => {
      throw new Error("boom");
    };
    expect(await probeQuota("demo", run, DEMO_TABLE)).toEqual({
      level: "unknown",
      error: "probe failed",
    });
  });

  test("non-zero exit → unknown 'probe failed'", async () => {
    const run: ProbeRunner = async () => ({ stdout: "", exitCode: 1 });
    expect(await probeQuota("demo", run, DEMO_TABLE)).toEqual({
      level: "unknown",
      error: "probe failed",
    });
  });

  test("raw runner exit 127 → unknown 'command not found'", async () => {
    const run: ProbeRunner = async () => ({ stdout: "", exitCode: 127 });
    expect(await probeQuota("demo", run, DEMO_TABLE)).toEqual({
      level: "unknown",
      error: "command not found",
    });
  });
});

describe("createProbeRunner", () => {
  test("undefined runtime (no Bun / Node dist) → unknown 'probe failed'", async () => {
    const run = createProbeRunner(undefined);
    expect(await probeQuota("demo", run, DEMO_TABLE)).toEqual({
      level: "unknown",
      error: "probe failed",
    });
  });

  test("which miss → exit 127 → unknown 'command not found', no spawn", async () => {
    const run = createProbeRunner(fakeRuntime({ which: () => null }));
    expect(await probeQuota("demo", run, DEMO_TABLE)).toEqual({
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
            stdout: new Response(QUOTA_JSON).body,
            kill: () => {},
          };
        },
      }),
    );
    const status = await probeQuota("demo", run, DEMO_TABLE);
    expect(spawned).toEqual(["/usr/local/bin/demo-tool", "quota", "--json"]);
    expect(status).toEqual(parseQuotaOutput("demo", QUOTA_JSON));
    expect(status.level).toBe("warning");
    expect(status.percentRemaining).toBe(12);
  });

  test("timeout: SIGTERM then SIGKILL, both observed before return → 'probe failed'", async () => {
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
    expect(await probeQuota("demo", run, DEMO_TABLE)).toEqual({
      level: "unknown",
      error: "probe failed",
    });
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("timeout: throwing kills stay contained → 'probe failed', no crash", async () => {
    const run = createProbeRunner(
      fakeRuntime({
        spawn: () => ({
          exited: new Promise<number>(() => {}),
          stdout: new ReadableStream<Uint8Array>(),
          kill: () => {
            throw new Error("ESRCH");
          },
        }),
      }),
      10,
    );
    expect(await probeQuota("demo", run, DEMO_TABLE)).toEqual({
      level: "unknown",
      error: "probe failed",
    });
  });

  test("timeout: a kill that rejects `exited` is swallowed by the bounded join", async () => {
    let reject: (err: Error) => void = () => {};
    const run = createProbeRunner(
      fakeRuntime({
        spawn: () => ({
          exited: new Promise<number>((_, reject0) => {
            reject = reject0;
          }),
          stdout: new ReadableStream<Uint8Array>(),
          kill: () => reject(new Error("ESRCH")),
        }),
      }),
      10,
    );
    expect(await probeQuota("demo", run, DEMO_TABLE)).toEqual({
      level: "unknown",
      error: "probe failed",
    });
  });

  test("timeout: an erroring stdout stream is contained (no unhandled rejection)", async () => {
    const rejections: unknown[] = [];
    const onRejection = (cause: unknown) => rejections.push(cause);
    const events = process as unknown as {
      on: (event: string, listener: (cause: unknown) => void) => void;
      off: (event: string, listener: (cause: unknown) => void) => void;
    };
    events.on("unhandledRejection", onRejection);
    try {
      const run = createProbeRunner(
        fakeRuntime({
          spawn: () => ({
            exited: new Promise<number>(() => {}),
            stdout: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("stream boom"));
              },
            }),
            kill: () => {},
          }),
        }),
        10,
      );
      expect(await probeQuota("demo", run, DEMO_TABLE)).toEqual({
        level: "unknown",
        error: "probe failed",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      events.off("unhandledRejection", onRejection);
    }
  });
});
