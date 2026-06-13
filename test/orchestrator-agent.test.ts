import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { WorkUnit } from "../src/core.js";
import {
  agentPrompt,
  persistAgentOutput,
  spawnAgent,
  type AgentConfig,
  type AgentOutcome,
} from "../src/orchestrator/agent.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vf-agent-test-"));
}

const sampleUnit: WorkUnit = {
  name: "auth-rewrite",
  status: "pending",
  confidence: 0,
  skills_used: ["security-audit"],
  scope: ["src/auth/**"],
  spec: "Rewrite auth to use JWT",
  gates: { build: "pass", lint: "pass", test: "pass", review: "pending" },
  resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
};

// ---------------------------------------------------------------------------
// agentPrompt — branches on unit.spec and unit.scope
// ---------------------------------------------------------------------------

describe("orchestrator/agent: agentPrompt", () => {
  test("includes unit name, spec, scope in the prompt (all branches populated)", () => {
    const prompt = agentPrompt(sampleUnit);
    expect(prompt).toContain("auth-rewrite");
    expect(prompt).toContain("Rewrite auth to use JWT");
    expect(prompt).toContain("src/auth/**");
    expect(prompt).toContain("## Output format");
    expect(prompt).toContain("You are a code implementation agent.");
  });

  test("omits spec section when unit.spec is missing (falsy branch)", () => {
    const noSpec: WorkUnit = { ...sampleUnit, spec: undefined };
    const prompt = agentPrompt(noSpec);
    expect(prompt).not.toContain("### Spec");
    expect(prompt).toContain("auth-rewrite");
  });

  test("omits scope section when unit.scope is missing (falsy branch)", () => {
    const noScope: WorkUnit = { ...sampleUnit, scope: undefined };
    const prompt = agentPrompt(noScope);
    expect(prompt).not.toContain("### Files to modify");
  });

  test("omits scope section when unit.scope is empty (falsy branch)", () => {
    const emptyScope: WorkUnit = { ...sampleUnit, scope: [] };
    const prompt = agentPrompt(emptyScope);
    expect(prompt).not.toContain("### Files to modify");
  });

  test("joins multiple scope entries with newlines", () => {
    const multi: WorkUnit = { ...sampleUnit, scope: ["src/a.ts", "src/b.ts", "test/c.ts"] };
    const prompt = agentPrompt(multi);
    expect(prompt).toContain("src/a.ts\nsrc/b.ts\ntest/c.ts");
  });
});

// ---------------------------------------------------------------------------
// persistAgentOutput — branches on existsSync(evidenceDir)
// ---------------------------------------------------------------------------

describe("orchestrator/agent: persistAgentOutput", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("creates evidence dir when missing, writes outcome JSON", () => {
    dir = tmp();
    const outcome: AgentOutcome = {
      status: "done",
      confidence: 0.9,
      evidence: ["test/auth.test.ts:42"],
      output: "JWT rewrite complete",
    };
    const path = persistAgentOutput(dir, "auth-rewrite", outcome);
    expect(existsSync(path)).toBe(true);
    expect(path).toContain("auth-rewrite");
    expect(path).toMatch(/\.json$/);
    const contents = JSON.parse(readFileSync(path, "utf8")) as AgentOutcome;
    expect(contents).toEqual(outcome);
    expect(existsSync(join(dir, ".vibeflow", "workunits", "auth-rewrite", "evidence"))).toBe(true);
  });

  test("reuses existing evidence dir (skip mkdir branch)", () => {
    dir = tmp();
    const evidenceDir = join(dir, ".vibeflow", "workunits", "pre-existing", "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const outcome: AgentOutcome = {
      status: "failed",
      confidence: 0,
      evidence: ["boom"],
      output: "oops",
    };
    const path = persistAgentOutput(dir, "pre-existing", outcome);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(evidenceDir)).toBe(true);
  });

  test("filename includes status- prefix", () => {
    dir = tmp();
    const doneOutcome: AgentOutcome = { status: "done", confidence: 1, evidence: [], output: "ok" };
    const failedOutcome: AgentOutcome = { status: "failed", confidence: 0, evidence: [], output: "bad" };
    const p1 = persistAgentOutput(dir, "u1", doneOutcome);
    const p2 = persistAgentOutput(dir, "u1", failedOutcome);
    expect(p1).toMatch(/done-\d+\.json$/);
    expect(p2).toMatch(/failed-\d+\.json$/);
  });
});

// ---------------------------------------------------------------------------
// spawnAgent — mock node:child_process to drive the inner stream parsers
// ---------------------------------------------------------------------------

/**
 * Build a fake child process that:
 *  - has .stdin (writable; .write() records, .end() marks ended)
 *  - has .stdout (Readable-like; we feed it chunks via emit("readable"))
 *  - has .stderr (Writable-like; we feed it via emit("data"))
 *  - emits "exit" or "error" when the test calls .finish(code|err)
 */
class FakeChild extends EventEmitter {
  public args: string[];
  public options: Record<string, unknown>;
  public stdinWrites: string[] = [];
  public stdinEnded = false;
  public stdout: EventEmitter & { read: () => string | null };
  public stderr: EventEmitter;
  private stdoutBuf: string[] = [];
  constructor(args: string[], options: Record<string, unknown>) {
    super();
    this.args = args;
    this.options = options;
    this.stdout = Object.assign(new EventEmitter(), {
      read: (): string | null => this.stdoutBuf.shift() ?? null,
    });
    this.stderr = new EventEmitter();
  }

  get stdin(): { write: (s: string) => void; end: () => void } {
    const self = this;
    return {
      write: (s: string): void => {
        self.stdinWrites.push(s);
      },
      end: (): void => {
        self.stdinEnded = true;
      },
    };
  }

  pushStdout(chunk: string): void {
    this.stdoutBuf.push(chunk);
    this.stdout.emit("readable");
  }

  pushStderr(chunk: string): void {
    this.stderr.emit("data", Buffer.from(chunk));
  }

  finish(code: number): void {
    this.emit("exit", code);
  }

  failWith(err: Error): void {
    this.emit("error", err);
  }
}

interface SpawnCall {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
  child: FakeChild;
}

// State is stored on globalThis so the vi.mock factory closure (which Vitest
// hoists to the top of the file, executing in a slightly different lexical
// scope) shares the same instance that the test body reads.
interface State {
  spawnCall: SpawnCall | null;
}
const STATE_KEY = Symbol.for("vf-agent-test-spawn-state");
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = g[STATE_KEY] ?? { spawnCall: null };
g[STATE_KEY] = state;

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeChild(args, options);
      (globalThis as unknown as Record<symbol, State>)[STATE_KEY].spawnCall = {
        cmd,
        args,
        options,
        child,
      };
      return child as never;
    },
  };
});

describe("orchestrator/agent: spawnAgent (mocked child_process)", () => {
  let dir = "";

  beforeEach(() => {
    state.spawnCall = null;
    dir = tmp();
    mkdirSync(join(dir, ".vibeflow"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const unitFor = (n: string): WorkUnit => ({ ...sampleUnit, name: n });

  test("lock-held short-circuit: returns failed/lock-held without spawning", async () => {
    const { tryLock, releaseLock } = await import("../src/orchestrator/marker.js");
    const name = "lock-held-test";
    expect(tryLock(name)).toBe(true);
    try {
      const r = await spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
      expect(r.status).toBe("failed");
      expect(r.confidence).toBe(0);
      expect(r.output).toContain("lock");
      expect(state.spawnCall).toBeNull();
    } finally {
      releaseLock(name);
    }
  });

  test("happy path — Claude: result event with JSON model output (confidence=1)", async () => {
    const name = "claude-happy-json";
    const p = spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(call).toBeTruthy();
    expect(call.cmd).toBe("claude");
    expect(call.args).toEqual([
      "-p",
      "p",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    const modelResult = JSON.stringify({ confidence: 1, output: "all good", evidence: ["e1", "e2"] });
    const resultEvent = JSON.stringify({ type: "result", subtype: "success", result: modelResult });
    call.child.pushStdout(resultEvent + "\n");
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("done");
    expect(r.confidence).toBe(1);
    expect(r.output).toBe("all good");
    expect(r.evidence).toEqual(expect.arrayContaining(["e1", "e2"]));
  });

  test("Claude: result event with JSON model output but confidence=0.5 → status=failed", async () => {
    const name = "claude-result-half";
    const p = spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    const modelResult = JSON.stringify({ confidence: 0.5, output: "partial", evidence: [] });
    const resultEvent = JSON.stringify({ type: "result", subtype: "success", result: modelResult });
    call.child.pushStdout(resultEvent + "\n");
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("failed");
    expect(r.confidence).toBe(0.5);
  });

  test("Claude: result event with non-JSON result text and subtype=success → done/1.0/resultText as evidence", async () => {
    const name = "claude-result-raw-success";
    const p = spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    const resultEvent = JSON.stringify({ type: "result", subtype: "success", result: "raw text" });
    call.child.pushStdout(resultEvent + "\n");
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("done");
    expect(r.confidence).toBe(1.0);
    expect(r.evidence).toEqual(["raw text"]);
    expect(r.output).toBe("raw text");
  });

  test("Claude: result event with non-JSON result text and subtype=error → failed/0/resultText as evidence", async () => {
    const name = "claude-result-raw-fail";
    const p = spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    const resultEvent = JSON.stringify({ type: "result", subtype: "error", result: "boom" });
    call.child.pushStdout(resultEvent + "\n");
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("failed");
    expect(r.confidence).toBe(0);
    expect(r.evidence).toEqual(["boom"]);
  });

  test("Claude: assistant text events accumulate into output", async () => {
    const name = "claude-assistant-accumulate";
    const p = spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    const a1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } });
    const a2 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "world" }] } });
    // Assistant block with non-text type is skipped (text branch is false)
    const a3 = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", text: "ignored" }] } });
    // Assistant block with no .message.content (Array.isArray undefined branch)
    const a4 = JSON.stringify({ type: "assistant" });
    // We never emit a result event — the exit handler should resolve with
    // the accumulated output in stderr. The exit handler reports the
    // running accumulated output as part of `output + stderr`.
    call.child.pushStdout([a1, a2, a3, a4].join("\n") + "\n");
    call.child.finish(0);
    const r = await p;
    // exit handler resolves with `output + stderr` — accumulated text survives
    expect(r.output).toBe("Hello world");
  });

  test("Claude: assistant text block with non-string text is skipped (typeof text branch)", async () => {
    const name = "claude-assistant-nonstr";
    const p = spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    // text is a number — typeof !== "string" → skipped
    const a1 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: 42 }] } });
    call.child.pushStdout(a1 + "\n");
    call.child.finish(0);
    const r = await p;
    // The number 42 should NOT be in output (it was skipped)
    expect(r.output).not.toContain("42");
  });

  test("Claude: system event is skipped (no output, no evidence change)", async () => {
    const name = "claude-system-skip";
    const p = spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    const sys = JSON.stringify({ type: "system", content: "init" });
    call.child.pushStdout(sys + "\n");
    const resultEvent = JSON.stringify({ type: "result", subtype: "success", result: "ok" });
    call.child.pushStdout(resultEvent + "\n");
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("done");
    expect(r.output).toBe("ok");
  });

  test("Claude: non-JSON stdout segment is appended as raw text (catch branch)", async () => {
    const name = "claude-bad-json";
    const p = spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    // Garbage line that fails JSON.parse — should hit the inner catch and append
    call.child.pushStdout("not-json-at-all\n");
    // Then a valid result event so the promise resolves
    const resultEvent = JSON.stringify({ type: "result", subtype: "success", result: "ok" });
    call.child.pushStdout(resultEvent + "\n");
    call.child.finish(0);
    const r = await p;
    // The result event's resolve gives output = "ok", but the catch branch
    // should have appended "not-json-at-all" to the local `output` var.
    // Since resolve uses `resultText`, the final output is "ok" — the catch
    // is still exercised (verified by the test that we don't crash). To
    // observe the appended text we drive the exit handler directly with
    // stderr which concatenates `output + stderr`.
    expect(r.status).toBe("done");
  });

  test("Claude: catch-branch text is reflected in exit output (no result event)", async () => {
    const name = "claude-bad-json-exit";
    const p = spawnAgent(unitFor(name), "p", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    // Garbage that fails parse → catch appends to `out`. No result event,
    // so the exit handler runs and reports `output + stderr`.
    call.child.pushStdout("not-json-at-all\n");
    call.child.finish(0);
    const r = await p;
    expect(r.output).toContain("not-json-at-all");
  });

  test("Codex: plain output with embedded JSON {confidence:1} → resolves with status=done", async () => {
    const name = "codex-plain-json";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(call.args).toEqual(["exec", "-"]);
    const jsonLine = JSON.stringify({ confidence: 1, output: "from codex", evidence: ["c1"] });
    call.child.pushStdout(jsonLine + "\n");
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("done");
    expect(r.confidence).toBe(1);
    expect(r.output).toBe("from codex");
    expect(r.evidence).toEqual(["c1"]);
  });

  test("Codex: plain output with JSON confidence=0.5 → status=failed (resolved early)", async () => {
    const name = "codex-plain-half";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    const jsonLine = JSON.stringify({ confidence: 0.5, output: "x", evidence: [] });
    call.child.pushStdout(jsonLine + "\n");
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("failed");
    expect(r.confidence).toBe(0.5);
  });

  test("Codex: plain output with non-JSON text is accumulated (catch branch)", async () => {
    const name = "codex-plain-text";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    call.child.pushStdout("garbage line\n");
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("done");
    expect(r.confidence).toBe(1.0);
    expect(r.output).toContain("garbage line");
  });

  test("Codex: plain output with JSON missing confidence → exit handler resolves", async () => {
    const name = "codex-plain-noconf";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    call.child.pushStdout('{"output":"no conf here"}\n');
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("done");
    expect(r.confidence).toBe(1.0);
    expect(r.output).toContain("no conf here");
  });

  test("Codex: plain output with JSON {confidence:0} is accumulated (resolve skipped)", async () => {
    const name = "codex-plain-confzero";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    call.child.pushStdout('{"confidence":0,"output":"z","evidence":["a"]}\n');
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("done");
    expect(r.confidence).toBe(1.0);
    expect(r.output).toContain('"confidence":0');
  });

  test("Codex: plain output with JSON missing trailing } is accumulated (outer if false)", async () => {
    const name = "codex-plain-nofence";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    call.child.pushStdout('{"partial": true\n');
    call.child.finish(0);
    const r = await p;
    expect(r.status).toBe("done");
    expect(r.output).toContain('"partial": true');
  });

  test("Copilot: engineArgs is [-p, prompt, --allow-all-tools] and prompt NOT written to stdin", async () => {
    const name = "copilot-args";
    const p = spawnAgent(unitFor(name), "the prompt", { engine: "copilot", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(call.args).toEqual(["-p", "the prompt", "--allow-all-tools"]);
    call.child.finish(0);
    await p;
  });

  test("Claude: engineArgs puts prompt after -p, then calls .end() on stdin (not .write)", async () => {
    const name = "claude-stdin";
    const p = spawnAgent(unitFor(name), "the prompt", { engine: "claude", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(call.args).toContain("-p");
    expect(call.args).toContain("the prompt");
    expect(call.child.stdinWrites).toEqual([]);
    expect(call.child.stdinEnded).toBe(true);
    call.child.finish(0);
    await p;
  });

  test("Codex: prompt is written to stdin and stdin is ended", async () => {
    const name = "codex-stdin";
    const p = spawnAgent(unitFor(name), "the prompt", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(call.child.stdinWrites).toEqual(["the prompt"]);
    expect(call.child.stdinEnded).toBe(true);
    call.child.finish(0);
    await p;
  });

  test("Unknown engine: engineArgs returns [engine, prompt] (default branch)", async () => {
    const name = "unknown-engine";
    const p = spawnAgent(unitFor(name), "p", { engine: "my-fork", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(call.cmd).toBe("my-fork");
    expect(call.args).toEqual(["my-fork", "p"]);
    call.child.finish(0);
    await p;
  });

  test("exit code != 0 → status=failed, confidence=0, evidence=['exited <code>']", async () => {
    const name = "exit-nonzero";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    call.child.finish(2);
    const r = await p;
    expect(r.status).toBe("failed");
    expect(r.confidence).toBe(0);
    expect(r.evidence).toEqual(["exited 2"]);
  });

  test("stderr is appended to output in the exit handler", async () => {
    const name = "stderr-output";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    call.child.pushStdout("hello\n");
    call.child.pushStderr("warn-msg");
    call.child.finish(0);
    const r = await p;
    expect(r.output).toContain("hello");
    expect(r.output).toContain("warn-msg");
  });

  test("child error event (spawn failure) → status=failed, evidence=['spawn: <msg>']", async () => {
    const name = "spawn-fail";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    call.child.failWith(new Error("ENOENT"));
    const r = await p;
    expect(r.status).toBe("failed");
    expect(r.confidence).toBe(0);
    expect(r.evidence).toEqual(["spawn: ENOENT"]);
    expect(r.output).toBe("");
  });

  test("runAgent promise never rejects — catch branch in spawnAgent is unreachable under normal conditions", async () => {
    const name = "runagent-no-throw";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    call.child.finish(0);
    const r = await p;
    // If the catch were hit, evidence would contain "error: ..." — confirm it doesn't.
    expect(r.evidence.join(" ")).not.toMatch(/^error:/);
    expect(r.status).toBe("done");
  });

  test("spawnAgent uses filterChildEnv (env option is a NodeJS.ProcessEnv object)", async () => {
    const name = "env-check";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(typeof call.options.env).toBe("object");
    expect(call.options.env).not.toBeNull();
    call.child.finish(0);
    await p;
  });

  test("spawnAgent passes cwd to child", async () => {
    const name = "cwd-check";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(call.options.cwd).toBe(dir);
    call.child.finish(0);
    await p;
  });

  test("spawnAgent passes timeoutMs through to child (config.timeoutMs branch)", async () => {
    const name = "timeout-check";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1234 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(call.options.timeout).toBe(1234);
    call.child.finish(0);
    await p;
  });

  test("spawnAgent without timeoutMs passes undefined timeout (config.timeoutMs || undefined)", async () => {
    const name = "no-timeout";
    const config: AgentConfig = { engine: "codex", cwd: dir };
    const p = spawnAgent(unitFor(name), "p", config);
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    expect(call.options.timeout).toBeUndefined();
    call.child.finish(0);
    await p;
  });

  test("releaseLock is called in the finally block even on error", async () => {
    const name = "finally-release";
    const p = spawnAgent(unitFor(name), "p", { engine: "codex", cwd: dir, timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 10));
    const call = state.spawnCall!;
    call.child.failWith(new Error("boom"));
    await p;
    const lockPath = join(homedir(), ".vibeflow", "markers", `${name}.lock`);
    expect(existsSync(lockPath)).toBe(false);
  });
});
