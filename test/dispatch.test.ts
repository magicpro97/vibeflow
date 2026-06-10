import { describe, expect, test } from "bun:test";
import {
  type AsyncSpawner,
  type EngineProbe,
  engineCommand,
  isUnavailable,
  makeAsyncSpawner,
  parseEngineSummary,
  runDispatch,
  runDispatchAsync,
} from "../src/dispatch.js";

describe("engineCommand — exact argv per engine (defect #1)", () => {
  test("claude → -p --output-format json", () => {
    const r = engineCommand("claude");
    expect(isUnavailable(r)).toBe(false);
    if (!isUnavailable(r)) {
      expect(r.cmd).toBe("claude");
      expect(r.args).toEqual(["-p", "--output-format", "json"]);
    }
  });

  test("codex → exec with the `-` stdin sentinel", () => {
    const r = engineCommand("codex");
    expect(isUnavailable(r)).toBe(false);
    if (!isUnavailable(r)) {
      expect(r.cmd).toBe("codex");
      expect(r.args).toEqual(["exec", "-"]);
    }
  });

  test("copilot present → copilot -p (never `gh -p`)", () => {
    const probe: EngineProbe = { has: () => true, version: () => "copilot 1.2.3" };
    const r = engineCommand("copilot", probe);
    expect(isUnavailable(r)).toBe(false);
    if (!isUnavailable(r)) {
      expect(r.cmd).toBe("copilot");
      expect(r.args).toEqual(["-p", "--allow-all-tools"]);
      expect(r.promptMode).toBe("arg");
      expect(r.cmd).not.toBe("gh");
      expect(r.warning).toBeUndefined();
    }
  });

  test("copilot absent → unavailable, NOT a bogus `gh -p`", () => {
    const probe: EngineProbe = { has: () => false };
    const r = engineCommand("copilot", probe);
    expect(isUnavailable(r)).toBe(true);
    if (isUnavailable(r)) expect(r.unavailable).toContain("copilot CLI not found");
  });

  test("copilot version unverifiable → warns (github/copilot-cli#1606 guard)", () => {
    const probe: EngineProbe = { has: () => true, version: () => undefined };
    const r = engineCommand("copilot", probe);
    expect(isUnavailable(r)).toBe(false);
    if (!isUnavailable(r)) {
      expect(r.cmd).toBe("copilot");
      expect(r.warning).toContain("copilot --version");
    }
  });

  test("no engine ever resolves to `gh -p`", () => {
    for (const engine of ["claude", "codex"] as const) {
      const r = engineCommand(engine);
      if (!isUnavailable(r)) {
        expect(r.cmd).not.toBe("gh");
        expect(r.args).not.toEqual(["-p"]);
      }
    }
  });
});

describe("runDispatch — copilot-absent path (defect #1)", () => {
  test("cli mode for absent copilot yields an unavailable reason, runs no command", () => {
    // Inject has:()=>false so this is deterministic and NEVER spawns a real engine (copilot may
    // be installed on the dev machine). Asserts the absent path → unavailable, no bogus `gh -p`.
    const r = runDispatch({ engine: "copilot", prompt: "p", mode: "cli", has: () => false });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/copilot/i);
  });

  test("cli mode passes Copilot prompt as -p argument, not stdin", () => {
    const calls: { cmd: string; args: string[]; input: string }[] = [];
    const spawner = (cmd: string, args: string[], input: string) => {
      calls.push({ cmd, args, input });
      return { status: 0, stdout: "done" };
    };
    const r = runDispatch({ engine: "copilot", prompt: "hello copilot", mode: "cli", spawner });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one spawner call");
    expect(call.cmd).toBe("copilot");
    expect(call.args).toEqual(["-p", "hello copilot", "--allow-all-tools"]);
    expect(call.input).toBe("");
  });
});

describe("parseEngineSummary — robust shapes (defect #2)", () => {
  test("(a) fenced ```json block", () => {
    const out = 'noise\n```json\n{"confidence":0.9,"files_changed":["a.ts"]}\n```\ntail';
    const s = parseEngineSummary(out);
    expect(s?.confidence).toBe(0.9);
    expect(s?.files_changed).toEqual(["a.ts"]);
  });

  test("(b) claude --output-format json envelope unwraps .result", () => {
    const envelope = JSON.stringify({
      type: "result",
      result: 'done\n```json\n{"confidence":1,"tests_run":["bun test"]}\n```',
      total_cost_usd: 0.01,
    });
    const s = parseEngineSummary(envelope);
    expect(s?.confidence).toBe(1);
    expect(s?.tests_run).toEqual(["bun test"]);
  });

  test("(b') envelope with structured_output", () => {
    const envelope = JSON.stringify({ structured_output: { confidence: 0.42 } });
    const s = parseEngineSummary(envelope);
    expect(s?.confidence).toBe(0.42);
  });

  test("(c) bare object", () => {
    const s = parseEngineSummary('prefix {"confidence":0.5} suffix');
    expect(s?.confidence).toBe(0.5);
  });

  test("nested object parses (old lastIndexOf('{') slice failed here)", () => {
    const out = 'log\n{"confidence":0.8,"meta":{"nested":{"deep":1}},"files_changed":["x"]}\n';
    const s = parseEngineSummary(out);
    expect(s?.confidence).toBe(0.8);
    expect(s?.files_changed).toEqual(["x"]);
  });

  test('nested-only object {"a":{"b":1}} does not crash and yields the object', () => {
    const s = parseEngineSummary('{"a":{"b":1}}');
    expect(s).toBeDefined();
  });

  test("no JSON → undefined", () => {
    expect(parseEngineSummary("just prose, no json here")).toBeUndefined();
  });
});

describe("runDispatchAsync — genuine async spawn seam (defect #3)", () => {
  test("parses an async spawner result", async () => {
    const spawner: AsyncSpawner = async () => ({
      status: 0,
      stdout: '```json\n{"confidence":1}\n```',
    });
    const r = await runDispatchAsync({ engine: "claude", prompt: "p", mode: "cli", spawner });
    expect(r.ok).toBe(true);
    expect(r.summary?.confidence).toBe(1);
  });

  test("dry mode short-circuits", async () => {
    const r = await runDispatchAsync({ engine: "claude", prompt: "p", mode: "dry" });
    expect(r.ok).toBe(true);
    expect(r.raw).toBe("");
  });
});

describe("makeAsyncSpawner — configurable timeout group-kills a hung engine (defect #4)", () => {
  // A child that hangs forever (no shell). We spawn it via the engine `cmd` slot so the
  // timeout path arms a real kill against a real process group.
  const hangArgs = ["-e", "setInterval(() => {}, 1e9)"];

  test("a hung child is killed: resolves timedOut:true, status 124, fast", async () => {
    const spawn = makeAsyncSpawner({ timeoutMs: 50, graceMs: 50 });
    const start = Date.now();
    const r = await spawn(process.execPath, hangArgs, "");
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe(124);
    // Must resolve well under the 1e9 hang — proves the SIGTERM/SIGKILL fired.
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("group-kill: a child spawning a hung grandchild still resolves timedOut:true", async () => {
    // The parent spawns a grandchild (detached:true makes them one group). On timeout we
    // `process.kill(-pid, ...)` the whole group so the grandchild dies too. Asserting no
    // orphan portably is brittle, so we assert the documented group-kill contract: the parent
    // promise resolves timedOut:true within the budget rather than hanging on the grandchild.
    const spawnGrandchild =
      "const cp=require('node:child_process');" +
      "cp.spawn(process.execPath,['-e','setInterval(()=>{},1e9)']);" +
      "setInterval(()=>{},1e9);";
    const spawn = makeAsyncSpawner({ timeoutMs: 50, graceMs: 50 });
    const start = Date.now();
    const r = await spawn(process.execPath, ["-e", spawnGrandchild], "");
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe(124);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("a fast command under a generous timeout completes normally, timer cleared", async () => {
    const spawn = makeAsyncSpawner({ timeoutMs: 5000 });
    const r = await spawn(process.execPath, ["-e", "process.stdout.write('hi')"], "");
    expect(r.status).toBe(0);
    expect(r.timedOut).toBeFalsy();
    expect(r.stdout).toBe("hi");
    // If the timeout timer were not cleared/unref'd, the test process would hang ~5s here.
  });

  test("makeAsyncSpawner() with no timeout never arms a timer (default behavior)", async () => {
    const spawn = makeAsyncSpawner();
    const r = await spawn(process.execPath, ["-e", "process.stdout.write('ok')"], "");
    expect(r.status).toBe(0);
    expect(r.timedOut).toBeFalsy();
    expect(r.stdout).toBe("ok");
  });
});

describe("runDispatchAsync — timedOut plumbing maps to reason 'timeout'", () => {
  test("a timedOut spawner result yields ok:false with reason 'timeout'", async () => {
    const spawner: AsyncSpawner = async () => ({ status: 124, stdout: "", timedOut: true });
    const r = await runDispatchAsync({ engine: "claude", prompt: "p", mode: "cli", spawner });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("timeout");
  });

  test("a non-timeout failure keeps the engine fail reason", async () => {
    const spawner: AsyncSpawner = async () => ({ status: 1, stdout: "" });
    const r = await runDispatchAsync({ engine: "claude", prompt: "p", mode: "cli", spawner });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("claude failed");
  });
});
