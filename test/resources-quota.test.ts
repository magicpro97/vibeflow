// test/resources-quota.test.ts
//
// Best-effort engine quota probe (Task 3 of the resource-management plan).
// The probe runner is INJECTED in every test — no real `gh`, no real spawn:
// determinism over realism. The default runner (Bun.which + Bun.spawn) is
// exercised only by the manual smoke recorded in the task report.
//
// Manual degradation check (documented per the task brief): on a machine
// without an authenticated `gh`, `vf resources --probe` prints
// `copilot: unknown (probe failed)` — that IS the expected output; the probe
// is best-effort and never throws.

import { describe, expect, test } from "bun:test";
import { parseQuotaOutput } from "../src/engine-quota.js";
import { type ProbeRunner, RESOURCE_PROBE_COMMANDS, probeQuota } from "../src/resources-quota.js";

/** Exact copilot fixture used by test/engine-quota.test.ts. */
const COPILOT_BUDGET = '{"limit":100,"used":88,"remaining":12,"resetAt":"2026-10-10T00:00:00Z"}';

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

  test("engine without a probe command → unknown 'no probe command' (runner untouched)", async () => {
    const run: ProbeRunner = async () => {
      throw new Error("must not run");
    };
    expect(await probeQuota("claude", run)).toEqual({
      level: "unknown",
      error: "no probe command",
    });
  });

  test("command table: only engines with a stable headless probe", () => {
    expect(Object.keys(RESOURCE_PROBE_COMMANDS)).toEqual(["copilot"]);
  });
});
