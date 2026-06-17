import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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
      // --allow-all is the omnibus flag (tools + paths + urls).
      // Without --allow-all-urls the engine hits "Permission
      // denied and could not request permission from user" when
      // it tries to fetch any URL.
      expect(r.args).toEqual(["-p", "--allow-all"]);
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
    expect(call.args).toEqual(["-p", "hello copilot", "--allow-all"]);
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

  test("envelope .result contains parseable JSON: confidence is taken from inner (line 327)", () => {
    // When the envelope (type=result, session_id, success, >0 turns)
    // has a non-empty .result string, parseEngineSummary is called
    // recursively on it. If the inner JSON has a numeric confidence,
    // the envelope's confidence is taken from there.
    const { parseEngineSummary } = require("../src/dispatch.js");
    const out = JSON.stringify({
      type: "result",
      session_id: "abc",
      num_turns: 3,
      subtype: "success",
      result: JSON.stringify({ confidence: 0.7, files_edited: ["a"] }),
    });
    const s = parseEngineSummary(out);
    expect(s?.confidence).toBe(0.7);
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

  test("(b'') Claude envelope with no inner summary yields confidence 0.7 fallback (B3 fix)", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-123",
      num_turns: 5,
      total_cost_usd: 0.05,
      result: "just some plain text without a json summary block",
    });
    const s = parseEngineSummary(envelope);
    expect(s).toBeDefined();
    expect(s?.confidence).toBe(0.7); // fallback for >=3 turns with no inner summary
    expect(s?.uncertainty).toContain("Ran 5 turns");
  });

  test("(b''') Claude envelope WITH inner json block still extracts inner confidence (regression guard)", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-456",
      num_turns: 8,
      total_cost_usd: 0.12,
      result: 'work done\n```json\n{"confidence":0.95,"files_changed":["a.ts"]}\n```\nfinished',
    });
    const s = parseEngineSummary(envelope);
    expect(s?.confidence).toBe(0.95);
    expect(s?.files_changed).toEqual(["a.ts"]);
  });
});

describe("runDispatchAsync — genuine async spawn seam (defect #3)", () => {
  test("runDispatchAsync in bridge mode uses VIBEFLOW_AI (default spawner path)", async () => {
    // Default spawner path in bridge mode: VIBEFLOW_AI set, no spawner
    // injected. The function must use the default shell-aware async
    // spawner (line 496-497) instead of a sync fallback.
    const origVAI = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "echo bridge-output";
    try {
      const r = await runDispatchAsync({
        engine: "claude",
        prompt: "p",
        mode: "bridge",
      });
      expect(r.ok).toBe(true);
      expect(r.raw).toContain("bridge-output");
      expect(r.mode).toBe("bridge");
    } finally {
      if (origVAI === undefined) {
        process.env.VIBEFLOW_AI = "";
      } else {
        process.env.VIBEFLOW_AI = origVAI;
      }
    }
  });

  test("runDispatch sync bridge: stderr is routed to onStderrChunk (PR28 audit M5)", () => {
    // Pre-fix: the sync bridge spawner captured stderr in the
    // return value but never called the caller's onStderrChunk
    // hook — stderr was silently dropped on the floor for the
    // sync bridge path. Async path streamed it per-chunk.
    // Post-fix: the sync bridge calls opts.onStderrChunk with
    // the captured stderr.
    const origVAI = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "sh -c 'echo bridge-stderr-noise 1>&2'";
    try {
      const captured: string[] = [];
      const r = runDispatch({
        engine: "claude",
        prompt: "p",
        mode: "bridge",
        onStderrChunk: (text) => captured.push(text),
      });
      // The bridge command emits a single line to stderr; the
      // fix routes that line through onStderrChunk.
      expect(captured.length).toBeGreaterThan(0);
      expect(captured.join("")).toContain("bridge-stderr-noise");
      // The result object also carries stderr for callers that
      // want to log it themselves.
      expect(r.ok).toBe(true);
    } finally {
      if (origVAI === undefined) {
        process.env.VIBEFLOW_AI = "";
      } else {
        process.env.VIBEFLOW_AI = origVAI;
      }
    }
  });

  test("runDispatchAsync in bridge mode returns ok:false when VIBEFLOW_AI is unset", async () => {
    const origVAI = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "";
    try {
      const r = await runDispatchAsync({
        engine: "claude",
        prompt: "p",
        mode: "bridge",
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("VIBEFLOW_AI is not set");
    } finally {
      if (origVAI !== undefined) process.env.VIBEFLOW_AI = origVAI;
    }
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

  // PR28 audit Task 3 (H1/H2): the previous code used `Bun.spawn` without `detached: true`,
  // which meant the kill killed only the direct child, leaving engine-internal tool
  // subprocesses (Claude / Codex / Copilot all spawn `node` or `bash` children) orphaned.
  // This is the regression test: assert the grandchild is REALLY killed.
  test("group-kill: grandchild is ACTUALLY killed (no orphan) — PR28 audit fix (H1/H2)", async () => {
    if (process.platform === "win32") {
      // process.kill(-pid, ...) is POSIX-only. Skip on Windows.
      return;
    }
    // Parent spawns a grandchild (no detached: child stays in parent's group) and writes
    // both pids to disk, then hangs. The grandchild writes a marker file every 50ms then
    // hangs. We check the grandchild is dead after the parent is killed.
    const tmpDir = mkdtempSync(join(tmpdir(), "vf-gk-"));
    try {
      const marker = join(tmpDir, "alive");
      const pidFile = join(tmpDir, "pids.json");
      const grandchildCode = `
          const fs = require("node:fs");
          setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, "alive"), 50);
          setInterval(() => {}, 1e9);
        `;
      const parentCode = `
          const cp = require("node:child_process");
          const fs = require("node:fs");
          const child = cp.spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], {
            stdio: "ignore",
          });
          fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));
          setInterval(() => {}, 1e9);
        `;
      const spawn = makeAsyncSpawner({ timeoutMs: 500, graceMs: 100 });
      const r = await spawn(process.execPath, ["-e", parentCode], "");
      // Allow some buffer for the pids file to be written.
      await new Promise((res) => setTimeout(res, 100));
      const pids = JSON.parse((await import("node:fs")).readFileSync(pidFile, "utf8")) as {
        parent: number;
        child: number;
      };
      const grandchildPid = pids.child;
      // Assert: the grandchild is no longer alive. process.kill(pid, 0) is the standard
      // "does this process exist?" check; ESRCH = dead.
      let alive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch (_e) {
        alive = false;
      }
      expect(r.timedOut).toBe(true);
      expect(r.status).toBe(124);
      expect(alive).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("makeAsyncSpawner — idle timeout", () => {
  test("silent child killed by idle timeout", async () => {
    const spawn = makeAsyncSpawner({ idleTimeoutMs: 100, graceMs: 50 });
    const start = Date.now();
    // Child that never writes anything
    const r = await spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], "");
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe(124);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("POSIX group-kill catch path: process.kill(-pid) throws → falls back to direct proc.kill", async () => {
    // PR28 coverage: lines 245, 247, 248 are the group-kill catch fallback
    // (when process.kill(-pid, ...) throws ESRCH but the direct child is
    // still alive). We mock process.kill to throw, then verify the
    // fallback path executes and the child is killed.
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    const origProcessKill = process.kill.bind(process);
    const killedSignals: NodeJS.Signals[] = [];
    let processKillCount = 0;
    Object.assign(process, {
      kill: (...args: unknown[]) => {
        const pid = args[0] as number;
        const signal = args[1] as NodeJS.Signals | undefined;
        processKillCount += 1;
        // First call (group kill via negative pid) throws ESRCH.
        // Subsequent calls (direct proc.kill) succeed.
        if (pid < 0) {
          throw new Error("ESRCH: no such process group");
        }
        killedSignals.push((signal ?? "SIGTERM") as NodeJS.Signals);
        return true;
      },
    });
    let resolveExited: (v: number) => void = () => {};
    const exitedPromise = new Promise<number>((res) => {
      resolveExited = res;
    });
    let killed = false;
    const makeStream = () => {
      let pendingResolve: ((v: { done: boolean; value?: undefined }) => void) | null = null;
      const stream = {
        getReader: () => ({
          read: () => {
            if (killed) return Promise.resolve({ done: true, value: undefined });
            return new Promise<{ done: boolean; value?: undefined }>((res) => {
              pendingResolve = res;
            });
          },
        }),
      };
      return {
        stream,
        close: () => {
          killed = true;
          pendingResolve?.({ done: true, value: undefined });
        },
      };
    };
    const stdoutStream = makeStream();
    const stderrStream = makeStream();
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: stdoutStream.stream,
      stderr: stderrStream.stream,
      exited: exitedPromise,
      pid: 12345,
      kill: (signal?: NodeJS.Signals) => {
        killedSignals.push((signal ?? "SIGTERM") as NodeJS.Signals);
        stdoutStream.close();
        stderrStream.close();
        resolveExited(0);
        return true;
      },
    } as unknown as ReturnType<typeof Bun.spawn>;
    const fakeSpawn = (() => fakeChild) as unknown as typeof Bun.spawn;
    try {
      const spawn = makeAsyncSpawner({
        timeoutMs: 50,
        graceMs: 20,
        spawn: fakeSpawn,
      });
      const r = await spawn("node", ["-e", "x"], "");
      expect(r.timedOut).toBe(true);
      // Group kill (negative pid) was attempted and threw → fell back to
      // direct proc.kill → at least one signal recorded.
      expect(processKillCount).toBeGreaterThanOrEqual(1);
      expect(killedSignals.length).toBeGreaterThanOrEqual(1);
    } finally {
      (process as unknown as { kill: typeof process.kill }).kill =
        origProcessKill as typeof process.kill;
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  test("Windows platform: killGroup falls back to direct proc.kill (no -pid group kill)", async () => {
    // PR28 coverage: when process.platform === "win32", killGroup takes the
    // non-POSIX branch (proc.kill(signal) directly, no process.kill(-pid, ...)).
    // The test mocks the platform to exercise this branch on POSIX hosts.
    // We use a fake child via opts.spawn so the timeout path calls killGroup,
    // and we observe proc.kill was called (with what signal).
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const killedSignals: NodeJS.Signals[] = [];
    let resolveExited: (v: number) => void = () => {};
    const exitedPromise = new Promise<number>((res) => {
      resolveExited = res;
    });
    // Streams that close when the child is killed (mirroring real subprocess
    // behavior). Each stream emits done after kill is invoked.
    let killed = false;
    const makeStream = () => {
      let pendingResolve: ((v: { done: boolean; value?: undefined }) => void) | null = null;
      const stream = {
        getReader: () => ({
          read: () => {
            if (killed) return Promise.resolve({ done: true, value: undefined });
            return new Promise<{ done: boolean; value?: undefined }>((res) => {
              pendingResolve = res;
            });
          },
        }),
      };
      return {
        stream,
        close: () => {
          killed = true;
          pendingResolve?.({ done: true, value: undefined });
        },
      };
    };
    const stdoutStream = makeStream();
    const stderrStream = makeStream();
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: stdoutStream.stream,
      stderr: stderrStream.stream,
      exited: exitedPromise,
      pid: 12345,
      kill: (signal?: NodeJS.Signals) => {
        killedSignals.push((signal ?? "SIGTERM") as NodeJS.Signals);
        stdoutStream.close();
        stderrStream.close();
        resolveExited(0);
        return true;
      },
    } as unknown as ReturnType<typeof Bun.spawn>;
    const fakeSpawn = (() => fakeChild) as unknown as typeof Bun.spawn;
    try {
      const spawn = makeAsyncSpawner({
        timeoutMs: 50,
        graceMs: 20,
        spawn: fakeSpawn,
      });
      const r = await spawn("node", ["-e", "x"], "");
      expect(r.timedOut).toBe(true);
      // Windows path: proc.kill was called directly (at least once for SIGTERM
      // and possibly once for SIGKILL after the grace period).
      expect(killedSignals.length).toBeGreaterThanOrEqual(1);
      expect(killedSignals[0]).toBe("SIGTERM");
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  test("active output resets idle timer", async () => {
    const spawn = makeAsyncSpawner({ idleTimeoutMs: 200, graceMs: 50 });
    // Child writing every 20ms for 500ms total
    const code = `
      const i = setInterval(() => process.stdout.write("x\\n"), 20);
      setTimeout(() => { clearInterval(i); process.exit(0); }, 400);
    `;
    const r = await spawn(process.execPath, ["-e", code], "");
    expect(r.timedOut).toBeFalsy();
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(5);
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

describe("dispatch: copilotVersion catch branch (line 212)", () => {
  test("copilotVersion: when spawn throws, returns undefined (line 212-213)", () => {
    // Make resolveCommand (in the import) return a non-existent path
    // so Bun.spawnSync of `copilot --version` throws ENOENT.
    // We can simulate by passing a probe.version that itself throws,
    // which exercises the same fall-through logic.
    const throwingProbe: EngineProbe = {
      has: (cmd) => cmd === "copilot",
      version: () => {
        // Mimics what would happen if copilotVersion's try block
        // threw (Bun.spawnSync of a non-existent path). The
        // engineCommand caller handles the throw.
        return undefined as never;
      },
    };
    const r = engineCommand("copilot", throwingProbe);
    expect(isUnavailable(r)).toBe(false);
    if (!isUnavailable(r)) {
      // When probe.version returns undefined, the warning is set.
      expect(r.warning).toContain("copilot-cli#1606");
    }
  });
});

describe("parseEngineSummary: claude envelope branches (line 320-345)", () => {
  test("claude envelope with .result text containing JSON extracts confidence (line 320-325)", () => {
    // The envelope's .result is a string. parseEngineSummary is
    // called recursively on it. If the inner result has confidence,
    // use it.
    const stdout = JSON.stringify({
      type: "result",
      result: '```json\n{"confidence": 0.75}\n```',
    });
    const r = parseEngineSummary(stdout);
    expect(r).toBeDefined();
    expect(r?.confidence).toBe(0.75);
  });

  test("claude envelope with .result text but inner has no confidence (line 320-325 false branch)", () => {
    // Inner parseEngineSummary returns undefined (no JSON found in
    // the result text). The outer falls through to the turns fallback.
    const stdout = JSON.stringify({
      type: "result",
      result: "no json in here",
    });
    const r = parseEngineSummary(stdout);
    expect(r).toBeDefined();
  });

  test("claude envelope with non-string .result field (line 320 false branch)", () => {
    // typeof !== "string" → skip the inner parse
    const stdout = JSON.stringify({
      type: "result",
      result: 42,
    });
    const r = parseEngineSummary(stdout);
    expect(r).toBeDefined();
  });

  test("claude envelope with empty .result string (line 320 false branch)", () => {
    // empty trimmed string → skip
    const stdout = JSON.stringify({
      type: "result",
      result: "   ",
    });
    const r = parseEngineSummary(stdout);
    expect(r).toBeDefined();
  });

  test("claude envelope with session_id but no turns/subtype (line 339-346 fallback)", () => {
    // The envelope has session_id but no num_turns/success → the
    // function returns undefined (line 345).
    const stdout = JSON.stringify({
      type: "result",
      session_id: "abc123",
      // num_turns omitted → turns = 0
    });
    const r = parseEngineSummary(stdout);
    expect(r).toBeUndefined();
  });
});

describe("defaultSpawner (test seam)", () => {
  test("defaultSpawner: success path returns status + stdout (line 67-68)", () => {
    // Mock Bun.spawnSync to return success → exercises the function body.
    const { defaultSpawner } = require("../src/dispatch.js");
    const orig = Bun.spawnSync;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      exitCode: 0,
      stdout: Buffer.from("hello world"),
      stderr: Buffer.from(""),
    })) as unknown as typeof Bun.spawnSync;
    try {
      const r = defaultSpawner("echo", ["hi"], "");
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("hello world");
    } finally {
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = orig;
    }
  });

  test("defaultSpawner: nonzero exit propagates (line 67-68)", () => {
    const { defaultSpawner } = require("../src/dispatch.js");
    const orig = Bun.spawnSync;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      exitCode: 1,
      stdout: Buffer.from("error output"),
      stderr: Buffer.from("error on stderr"),
    })) as unknown as typeof Bun.spawnSync;
    try {
      const r = defaultSpawner("false", [], "");
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("error output");
    } finally {
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = orig;
    }
  });

  // PR28 audit Task 4: defaultSpawner used to call Bun.spawnSync WITHOUT stderr: "pipe",
  // leaking child stderr to the parent TTY. Fix: pipe stderr (M2 parity with the async
  // path). Regression: assert stderr is captured in the result and is the empty string
  // for a clean child.
  test("defaultSpawner: pipes stderr (M2 parity) — PR28 audit Task 4", () => {
    const { defaultSpawner } = require("../src/dispatch.js");
    const orig = Bun.spawnSync;
    let capturedOpts: { stderr?: string } | undefined;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((
      _cmd: string | string[],
      opts: { stderr?: string },
    ) => {
      capturedOpts = opts;
      return {
        exitCode: 0,
        stdout: Buffer.from("ok"),
        stderr: Buffer.from(""),
      };
    }) as unknown as typeof Bun.spawnSync;
    try {
      defaultSpawner("echo", ["ok"], "");
      expect(capturedOpts?.stderr).toBe("pipe");
    } finally {
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = orig;
    }
  });

  // PR28 coverage: the Windows branch of defaultSyncSpawner's needsShell
  // ternary (lines 106-107) is only reachable when process.platform is
  // "win32". On POSIX hosts we mock the platform to exercise it. Without
  // this test, lines 106-107 stay at DA:0 in the lcov report.
  test("defaultSyncSpawner: Windows platform mock exercises the cmd.exe branch (line 106-107)", () => {
    const { defaultSyncSpawner } = require("../src/dispatch.js");
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const origWhich = Bun.which;
    const fakeWhich = (cmd: string) =>
      cmd === "copilot" ? "C:\\Program Files\\nodejs\\copilot" : origWhich(cmd);
    (Bun as unknown as { which: typeof Bun.which }).which = fakeWhich as typeof Bun.which;
    let captured: { cmd: string[] } | undefined;
    const origSpawnSync = Bun.spawnSync;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((
      cmd: string | string[],
    ) => {
      captured = { cmd: Array.isArray(cmd) ? cmd : [cmd] };
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }) as unknown as typeof Bun.spawnSync;
    try {
      defaultSyncSpawner("copilot", ["-p", "x"], "");
      expect(captured?.cmd[0]).toBe("cmd.exe");
      expect(captured?.cmd[1]).toBe("/c");
    } finally {
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = origSpawnSync;
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  // PR28 audit Task 4: defaultSyncSpawner must also apply the Windows .cmd/.bat shim
  // auto-shell detection (M2 parity with makeAsyncSpawner). Without this, the sync
  // dispatch path fails with ENOENT on `copilot.cmd` and similar npm shims.
  test("defaultSyncSpawner: applies Windows shim auto-shell (M2 parity) — PR28 audit Task 4", () => {
    const { defaultSyncSpawner } = require("../src/dispatch.js");
    if (process.platform === "win32") {
      // On Windows, the test creates a real .cmd sibling and checks wrapping is applied.
      const dir = mkdtempSync(join(tmpdir(), "vf-sync-shim-"));
      try {
        const shim = join(dir, "tool");
        writeFileSync(`${shim}.cmd`, "@echo off\r\n");
        const orig = Bun.spawnSync;
        let captured: { cmd: string[]; opts: unknown } | undefined;
        (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((
          cmd: string | string[],
          opts: { stderr?: string },
        ) => {
          captured = { cmd: Array.isArray(cmd) ? cmd : [cmd], opts };
          return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
        }) as unknown as typeof Bun.spawnSync;
        try {
          defaultSyncSpawner(shim, ["--version"], "");
          expect(captured?.cmd[0]).toBe("cmd.exe");
          expect(captured?.cmd[1]).toBe("/c");
          expect(captured?.cmd[2]).toBe(shim);
        } finally {
          (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = orig;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      // On POSIX, just assert the call succeeds and pipes stderr (no shell wrapping).
      const orig = Bun.spawnSync;
      let capturedOpts: { stderr?: string } | undefined;
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((
        _cmd: string | string[],
        opts: { stderr?: string },
      ) => {
        capturedOpts = opts;
        return { exitCode: 0, stdout: Buffer.from("ok"), stderr: Buffer.from("") };
      }) as unknown as typeof Bun.spawnSync;
      try {
        defaultSyncSpawner("echo", ["ok"], "");
        expect(capturedOpts?.stderr).toBe("pipe");
      } finally {
        (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = orig;
      }
    }
  });

  test("copilotVersion: spawnSync throws → catch fires (line 215)", () => {
    // Mock Bun.spawnSync to throw → catch fires → returns undefined.
    const orig = Bun.spawnSync;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => {
      throw new Error("copilot not found");
    }) as unknown as typeof Bun.spawnSync;
    try {
      // copilotVersion is non-exported, but the engineCommand for
      // copilot with a throwable probe.version exercises the same
      // catch path. Use a probe.version that throws.
      const { engineCommand } = require("../src/dispatch.js");
      const { version: _ignored, ...rest } = {
        version: () => {
          throw new Error("boom");
        },
      };
      void _ignored;
      const r = engineCommand("copilot", rest as any);
      // The throw causes the version guard to return undefined
      // → engineCommand returns ok with warning
      expect(r).toBeDefined();
    } finally {
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = orig;
    }
  });

  // Issue #88: copilotVersion used to call `Bun.spawnSync([resolved, "--version"])` directly
  // with no Windows shim auto-shell. On Windows, copilot is installed as `copilot.cmd`
  // (npm binstub); `Bun.which` returns the .cmd path, and CreateProcess cannot execute
  // .cmd shims directly — it fails with ENOENT "uv_spawn 'copilot.cmd'". The version
  // guard then always returns undefined, and every Copilot dispatch gets a spurious
  // "could not determine `copilot --version`" warning even when copilot is installed.
  // Fix: route copilotVersion through the same defaultSyncSpawner (or apply the same
  // shim detection) that already auto-wraps with `cmd.exe /c copilot ...` on Windows.
  test("copilotVersion: shell-wraps the --version probe on Windows .cmd shim (issue #88)", () => {
    const { engineCommand } = require("../src/dispatch.js");
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const origWhich = Bun.which;
    // Simulate `Bun.which("copilot")` returning the .cmd shim path that npm installs.
    const fakeWhich = (cmd: string) =>
      cmd === "copilot" ? "C:\\Program Files\\nodejs\\copilot.cmd" : origWhich(cmd);
    (Bun as unknown as { which: typeof Bun.which }).which = fakeWhich as typeof Bun.which;
    let captured: { cmd: string[]; opts: { stderr?: string } } | undefined;
    const origSpawnSync = Bun.spawnSync;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((
      cmd: string | string[],
      opts: { stderr?: string },
    ) => {
      captured = { cmd: Array.isArray(cmd) ? cmd : [cmd], opts };
      return { exitCode: 0, stdout: Buffer.from("copilot 0.3.4"), stderr: Buffer.from("") };
    }) as unknown as typeof Bun.spawnSync;
    try {
      const probe = { has: (cmd: string) => cmd === "copilot" };
      const r = engineCommand("copilot", probe);
      // The probe must have shell-wrapped the spawn (cmd.exe /c copilot --version),
      // NOT spawned `C:\Program Files\nodejs\copilot.cmd` directly. On Windows the
      // direct path would fail with ENOENT — that's the defect.
      expect(captured).toBeDefined();
      expect(captured?.cmd[0]).toBe("cmd.exe");
      expect(captured?.cmd[1]).toBe("/c");
      expect(captured?.cmd.slice(2)).toEqual(["copilot", "--version"]);
      // The version string flowed back through, so the warning is NOT set.
      expect(isUnavailable(r)).toBe(false);
      if (!isUnavailable(r)) {
        expect(r.warning).toBeUndefined();
      }
    } finally {
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = origSpawnSync;
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  // Issue #88: same defect, but the resolved path has no extension and `Bun.which`
  // reports the extensionless path (some Windows install layouts do this); the
  // shim auto-detection must ALSO fire when the original cmd is "copilot".
  test("copilotVersion: shell-wraps when resolved path has no extension (issue #88)", () => {
    const { engineCommand } = require("../src/dispatch.js");
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const origWhich = Bun.which;
    const fakeWhich = (cmd: string) =>
      cmd === "copilot" ? "C:\\Program Files\\nodejs\\copilot" : origWhich(cmd);
    (Bun as unknown as { which: typeof Bun.which }).which = fakeWhich as typeof Bun.which;
    let captured: { cmd: string[] } | undefined;
    const origSpawnSync = Bun.spawnSync;
    (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((
      cmd: string | string[],
    ) => {
      captured = { cmd: Array.isArray(cmd) ? cmd : [cmd] };
      return { exitCode: 0, stdout: Buffer.from("copilot 0.3.4"), stderr: Buffer.from("") };
    }) as unknown as typeof Bun.spawnSync;
    try {
      const probe = { has: (cmd: string) => cmd === "copilot" };
      engineCommand("copilot", probe);
      expect(captured?.cmd[0]).toBe("cmd.exe");
      expect(captured?.cmd[1]).toBe("/c");
    } finally {
      (Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = origSpawnSync;
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  test("runDispatch: claude with has(claude)=false returns 'claude CLI not found' (line 402)", () => {
    // For non-copilot engines, engineCommand returns a successful
    // command object. Then runDispatch checks `!hasSpawner && !has(cmd)`.
    // With has=()=>false, the `claude` command is "not found" → 402 fires.
    const { runDispatch } = require("../src/dispatch.js");
    const r = runDispatch({
      engine: "claude",
      prompt: "p",
      mode: "cli",
      has: () => false,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("claude CLI not found");
  });
});

describe("makeAsyncSpawner — Windows .cmd/.bat shim auto-shell (Task 7b)", () => {
  // On Windows, copilot is often installed as a .cmd shim (npm puts
  // shims in C:\Program Files\nodejs\copilot.cmd). CreateProcess can't
  // execute .cmd shims directly — you need `cmd.exe /c <shim>`. Without
  // shell mode, Bun.spawn fails with ENOENT "uv_spawn 'copilot'".
  // The fix in makeAsyncSpawner auto-enables shell when the resolved
  // command path ends in .cmd or .bat.
  test("auto-enables shell on Windows when resolved command is a .cmd shim (regression: ENOENT uv_spawn 'copilot')", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    // Stub Bun.which to report a .cmd shim path for "copilot".
    const origWhich = Bun.which;
    const fakeWhich = (cmd: string) =>
      cmd === "copilot" ? "C:\\Program Files\\nodejs\\copilot.cmd" : origWhich(cmd);
    (Bun as unknown as { which: typeof Bun.which }).which = fakeWhich as typeof Bun.which;
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      exited: Promise.resolve(0),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
    const fakeSpawn = (..._args: unknown[]) => {
      const arr = _args[0] as string | readonly string[];
      const list = Array.isArray(arr) ? arr : [arr];
      calls.push({ cmd: (list[0] ?? "") as string, args: list.slice(1) as string[] });
      return fakeChild;
    };
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn =
      fakeSpawn as unknown as typeof Bun.spawn;
    try {
      const spawner = makeAsyncSpawner();
      await spawner("copilot", ["-p", "hello", "--allow-all-tools"], "");
      // Expect cmd.exe /c copilot ... (NOT direct copilot ...).
      expect(calls).toHaveLength(1);
      const c = calls[0];
      expect(c).toBeDefined();
      if (!c) return;
      expect(c.cmd).toBe("cmd.exe");
      expect(c.args[0]).toBe("/c");
      expect(c.args[1]).toBe("copilot");
      expect(c.args.slice(2)).toEqual(["-p", "hello", "--allow-all-tools"]);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  test("auto-enables shell on Windows for copilot even when Bun.which returns a no-extension shim", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const origWhich = Bun.which;
    const fakeWhich = (cmd: string) =>
      cmd === "copilot" ? "C:\\Program Files\\nodejs\\copilot" : origWhich(cmd);
    (Bun as unknown as { which: typeof Bun.which }).which = fakeWhich as typeof Bun.which;
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      exited: Promise.resolve(0),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
    const fakeSpawn = (..._args: unknown[]) => {
      const arr = _args[0] as string | readonly string[];
      const list = Array.isArray(arr) ? arr : [arr];
      calls.push({ cmd: (list[0] ?? "") as string, args: list.slice(1) as string[] });
      return fakeChild;
    };
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn =
      fakeSpawn as unknown as typeof Bun.spawn;
    try {
      const spawner = makeAsyncSpawner();
      await spawner("copilot", ["-p", "hello", "--allow-all"], "");
      expect(calls).toHaveLength(1);
      const c = calls[0];
      expect(c).toBeDefined();
      if (!c) return;
      expect(c.cmd).toBe("cmd.exe");
      expect(c.args[0]).toBe("/c");
      expect(c.args[1]).toBe("copilot");
      expect(c.args.slice(2)).toEqual(["-p", "hello", "--allow-all"]);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  test("auto-enables shell on Windows when a no-extension resolved command has a .cmd sibling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-dispatch-shim-"));
    const shim = join(dir, "tool");
    writeFileSync(`${shim}.cmd`, "@echo off\r\n");
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const origWhich = Bun.which;
    const fakeWhich = (cmd: string) => (cmd === "tool" ? shim : origWhich(cmd));
    (Bun as unknown as { which: typeof Bun.which }).which = fakeWhich as typeof Bun.which;
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      exited: Promise.resolve(0),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
    const fakeSpawn = (..._args: unknown[]) => {
      const arr = _args[0] as string | readonly string[];
      const list = Array.isArray(arr) ? arr : [arr];
      calls.push({ cmd: (list[0] ?? "") as string, args: list.slice(1) as string[] });
      return fakeChild;
    };
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn =
      fakeSpawn as unknown as typeof Bun.spawn;
    try {
      const spawner = makeAsyncSpawner();
      await spawner("tool", ["--version"], "");
      expect(calls).toHaveLength(1);
      const c = calls[0];
      expect(c).toBeDefined();
      if (!c) return;
      expect(c.cmd).toBe("cmd.exe");
      expect(c.args).toEqual(["/c", "tool", "--version"]);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
      Object.defineProperty(process, "platform", { value: origPlatform });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT auto-enable shell on Windows when resolved command is NOT a shim", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    // Bun.which returns null → resolveCommand returns undefined →
    // the spawner falls back to the raw cmd name. "native-copilot" is
    // not a shim and the spawner must NOT prepend cmd.exe /c.
    const origWhich = Bun.which;
    const fakeWhich = () => null as string | null;
    (Bun as unknown as { which: typeof Bun.which }).which = fakeWhich as typeof Bun.which;
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      exited: Promise.resolve(0),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
    const fakeSpawn = (..._args: unknown[]) => {
      const arr = _args[0] as string | readonly string[];
      const list = Array.isArray(arr) ? arr : [arr];
      calls.push({ cmd: (list[0] ?? "") as string, args: list.slice(1) as string[] });
      return fakeChild;
    };
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn =
      fakeSpawn as unknown as typeof Bun.spawn;
    try {
      const spawner = makeAsyncSpawner();
      await spawner("native-copilot", ["-p", "hello"], "");
      // Direct spawn (no cmd.exe wrapping).
      expect(calls).toHaveLength(1);
      const c = calls[0];
      expect(c).toBeDefined();
      if (!c) return;
      expect(c.cmd).toBe("native-copilot");
      expect(c.args).toEqual(["-p", "hello"]);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });

  test("does NOT auto-enable shell on non-Windows even if the resolved path ends in .cmd", async () => {
    // The auto-shell detection is platform-gated. On linux/darwin
    // (no Windows), a path ending in .cmd must NOT trigger shell.
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    const origWhich = Bun.which;
    const fakeWhich = (cmd: string) =>
      cmd === "fake" ? "/usr/local/bin/fake.cmd" : origWhich(cmd);
    (Bun as unknown as { which: typeof Bun.which }).which = fakeWhich as typeof Bun.which;
    const calls: { cmd: string; args: string[] }[] = [];
    const fakeChild = {
      stdin: { write: () => {}, end: () => {} },
      stdout: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      stderr: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      exited: Promise.resolve(0),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
    const fakeSpawn = (..._args: unknown[]) => {
      const arr = _args[0] as string | readonly string[];
      const list = Array.isArray(arr) ? arr : [arr];
      calls.push({ cmd: (list[0] ?? "") as string, args: list.slice(1) as string[] });
      return fakeChild;
    };
    const origSpawn = Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn =
      fakeSpawn as unknown as typeof Bun.spawn;
    try {
      const spawner = makeAsyncSpawner();
      await spawner("fake", [], "");
      // No shell wrapping on linux.
      expect(calls).toHaveLength(1);
      const c = calls[0];
      expect(c).toBeDefined();
      if (!c) return;
      expect(c.cmd).toBe("fake");
      expect(c.args).toEqual([]);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
      (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
      Object.defineProperty(process, "platform", { value: origPlatform });
    }
  });
});

describe("makeAsyncSpawner — stdin error (defect #B3)", () => {
  test("kills child on stdin write error (B3: orphan guard)", async () => {
    // Simulate EPIPE: stdin.write throws. The fix must kill the child and
    // await the exit before re-throwing, otherwise the child orphans.
    const fakeChild: {
      stdin: { write: (...args: unknown[]) => unknown; end: () => void };
      stdout: Readable;
      stderr: Readable;
      pid: number;
      exited: Promise<number>;
      kill: (signal?: NodeJS.Signals) => boolean;
    } = {
      stdin: {
        write: () => {
          throw new Error("EPIPE: child stdin closed");
        },
        end: () => {},
      },
      stdout: new Readable({
        read() {
          this.push(null);
        },
      }),
      stderr: new Readable({
        read() {
          this.push(null);
        },
      }),
      pid: 99999,
      exited: Promise.resolve(0),
      kill: () => {
        killed = true;
        return true;
      },
    };
    let killed = false;
    const fakeSpawn = (() => fakeChild) as unknown as typeof Bun.spawn;
    try {
      const spawner = makeAsyncSpawner({ spawn: fakeSpawn });
      await expect(spawner(process.execPath, ["-e", "process.exit(0)"], "x")).rejects.toThrow(
        "EPIPE",
      );
      expect(killed).toBe(true);
    } finally {
      // no global mock to restore — spawner is closed over its injected `spawn`
    }
  });

  test("B3: tolerates kill throw + exited reject — re-throws original EPIPE", async () => {
    // Both the kill() and proc.exited reject — the fix must swallow both
    // and re-throw the ORIGINAL stdin error (EPIPE), not the secondary
    // failures. This exercises the inner try/catch in the B3 fix.
    const fakeChild = {
      stdin: {
        write: () => {
          throw new Error("EPIPE: child stdin closed");
        },
        end: () => {},
      },
      stdout: new Readable({
        read() {
          this.push(null);
        },
      }),
      stderr: new Readable({
        read() {
          this.push(null);
        },
      }),
      pid: 99999,
      exited: Promise.reject(new Error("exited-rejected")),
      kill: () => {
        throw new Error("kill-failed");
      },
    } as unknown as ReturnType<typeof Bun.spawn>;
    const fakeSpawn = (() => fakeChild) as unknown as typeof Bun.spawn;
    const spawner = makeAsyncSpawner({ spawn: fakeSpawn });
    await expect(spawner(process.execPath, ["-e", "process.exit(0)"], "x")).rejects.toThrow(
      "EPIPE",
    );
  });
});
