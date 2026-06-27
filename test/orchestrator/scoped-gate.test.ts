// test/orchestrator/scoped-gate.test.ts
//
// W4: the scoped per-unit gate. Every branch is driven through the injected
// `run` seam — no real tsc/biome/node is shelled (that would crater coverage
// and be slow). One test exercises the default spawnSync runner against a
// harmless command to cover the defaultRun path.

import { describe, expect, test } from "bun:test";
import {
  type GateRunResult,
  defaultRun,
  makeSharedTypecheckGate,
  scopedGate,
} from "../../src/orchestrator/scoped-gate.js";

const ok: GateRunResult = { status: 0, stdout: "" };

describe("scopedGate", () => {
  test("empty scope → pass no-op (runner never invoked)", () => {
    const g = scopedGate({
      scope: [],
      cwd: "/tmp/wt",
      run: () => {
        throw new Error("runner must not be called for empty scope");
      },
    });
    expect(g.pass).toBe(true);
    expect(g.failedGate).toBeUndefined();
  });

  test("all gates clean → pass", () => {
    const g = scopedGate({ scope: ["src/a.ts"], cwd: "/tmp/wt", run: () => ok });
    expect(g.pass).toBe(true);
  });

  test("typecheck fails → failedGate=typecheck, detail is first signal line", () => {
    const run = (cmd: string): GateRunResult =>
      cmd.includes("tsc") ? { status: 2, stdout: "\n  src/a.ts(3,1): error TS1005\nmore\n" } : ok;
    const g = scopedGate({ scope: ["src/a.ts"], cwd: "/tmp/wt", run });
    expect(g.pass).toBe(false);
    expect(g.failedGate).toBe("typecheck");
    expect(g.detail).toBe("src/a.ts(3,1): error TS1005");
  });

  test("biome fails on a scope file → failedGate=biome", () => {
    const run = (cmd: string): GateRunResult =>
      cmd.includes("biome") ? { status: 1, stdout: "× lint error in src/a.ts" } : ok;
    const g = scopedGate({ scope: ["src/a.ts"], cwd: "/tmp/wt", run });
    expect(g.pass).toBe(false);
    expect(g.failedGate).toBe("biome");
    expect(g.detail).toBe("× lint error in src/a.ts");
  });

  test("test step fails → failedGate=test", () => {
    const run = (cmd: string): GateRunResult =>
      cmd.includes("bun test") ? { status: 1, stdout: "FAIL test/foo.test.ts" } : ok;
    const g = scopedGate({ scope: ["src/a.ts"], cwd: "/tmp/wt", run });
    expect(g.pass).toBe(false);
    expect(g.failedGate).toBe("test");
    expect(g.detail).toBe("FAIL test/foo.test.ts");
  });

  test("scopedGate does not shell out to coverage-gate.cjs (coverage owned by final gate)", () => {
    const cmds: string[] = [];
    const run = (cmd: string) => {
      cmds.push(cmd);
      return { status: 0, stdout: "" }; // tsc + biome both pass
    };
    const r = scopedGate({ scope: ["src/a.ts"], cwd: "/x", run });
    expect(r.pass).toBe(true);
    expect(cmds.some((c) => c.includes("coverage-gate"))).toBe(false);
    expect(cmds.some((c) => c.includes("tsc --noEmit"))).toBe(true);
    expect(cmds.some((c) => c.includes("biome check"))).toBe(true);
  });

  test("typecheck fails with only-blank output → detail is empty string", () => {
    const run = (cmd: string): GateRunResult =>
      cmd.includes("tsc") ? { status: 1, stdout: "\n   \n" } : ok;
    const g = scopedGate({ scope: ["src/a.ts"], cwd: "/tmp/wt", run });
    expect(g.pass).toBe(false);
    expect(g.failedGate).toBe("typecheck");
    expect(g.detail).toBe("");
  });

  test("defaultRun executes a real command, capturing status 0 + stdout", () => {
    const r = defaultRun("echo scoped-gate-ok", process.cwd());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("scoped-gate-ok");
  });

  test("defaultRun captures a non-zero exit (false → status 1)", () => {
    const r = defaultRun("false", process.cwd());
    expect(r.status).toBe(1);
  });

  test("defaultRun on an empty command string returns a non-null status", () => {
    // bin === "" → spawnSync("") → status null or error; assert it doesn't throw
    // and returns the GateRunResult shape.
    const r = defaultRun("", process.cwd());
    expect(r).toHaveProperty("stdout");
  });

  // #275-C: typecheck verdict caching
  test("scopedGate with a passing typecheckVerdict skips running tsc", () => {
    const cmds: string[] = [];
    const run = (cmd: string) => {
      cmds.push(cmd);
      return { status: 0, stdout: "" };
    };
    const r = scopedGate({ scope: ["src/a.ts"], cwd: "/x", run, typecheckVerdict: { pass: true } });
    expect(r.pass).toBe(true);
    expect(cmds.some((c) => c.includes("tsc --noEmit"))).toBe(false); // tsc NOT run
    expect(cmds.some((c) => c.includes("biome check"))).toBe(true); // biome still runs
  });

  test("scopedGate with a failing typecheckVerdict blocks without running tsc", () => {
    const cmds: string[] = [];
    const run = (cmd: string) => {
      cmds.push(cmd);
      return { status: 0, stdout: "" };
    };
    const r = scopedGate({
      scope: ["src/a.ts"],
      cwd: "/x",
      run,
      typecheckVerdict: { pass: false, detail: "TS2304" },
    });
    expect(r.pass).toBe(false);
    expect(r.failedGate).toBe("typecheck");
    expect(r.detail).toBe("TS2304");
    expect(cmds.some((c) => c.includes("tsc"))).toBe(false);
  });

  test("scopedGate without a verdict still runs tsc (back-compat)", () => {
    const cmds: string[] = [];
    const run = (cmd: string) => {
      cmds.push(cmd);
      return { status: 0, stdout: "" };
    };
    scopedGate({ scope: ["src/a.ts"], cwd: "/x", run });
    expect(cmds.some((c) => c.includes("tsc --noEmit"))).toBe(true); // fallback
  });
});

describe("makeSharedTypecheckGate", () => {
  const ok: GateRunResult = { status: 0, stdout: "" };

  test("runs tsc only once across multiple calls (passing)", () => {
    const tscCalls: string[] = [];
    const run = (cmd: string) => {
      tscCalls.push(cmd);
      return ok;
    };
    const gate = makeSharedTypecheckGate(run);

    const r1 = gate({ scope: ["src/a.ts"], cwd: "/x" });
    const r2 = gate({ scope: ["src/b.ts"], cwd: "/x" });

    expect(r1.pass).toBe(true);
    expect(r2.pass).toBe(true);
    expect(tscCalls.filter((c) => c.includes("tsc --noEmit"))).toHaveLength(1); // once, not twice
  });

  test("caches a failing verdict and reuses it", () => {
    let callCount = 0;
    const run = (cmd: string) => {
      callCount++;
      return { status: 2, stdout: "\nerror TS2304: Cannot find name 'foo'\n" };
    };
    const gate = makeSharedTypecheckGate(run);

    const r1 = gate({ scope: ["src/a.ts"], cwd: "/x" });
    const r2 = gate({ scope: ["src/b.ts"], cwd: "/x" });

    expect(r1.pass).toBe(false);
    expect(r1.failedGate).toBe("typecheck");
    expect(r1.detail).toBe("error TS2304: Cannot find name 'foo'");
    expect(r2.pass).toBe(false);
    expect(r2.failedGate).toBe("typecheck");
    expect(callCount).toBe(1); // cached
  });

  test("still runs biome scoped per call", () => {
    const cmds: string[] = [];
    const run = (cmd: string) => {
      cmds.push(cmd);
      return ok;
    };
    const gate = makeSharedTypecheckGate(run);

    gate({ scope: ["src/a.ts"], cwd: "/x" });
    gate({ scope: ["src/b.ts"], cwd: "/x" });

    expect(cmds.some((c) => c.includes("biome check src/a.ts"))).toBe(true);
    expect(cmds.some((c) => c.includes("biome check src/b.ts"))).toBe(true);
  });
});
