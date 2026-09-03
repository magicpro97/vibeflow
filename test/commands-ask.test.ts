import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AskInvocation,
  ask,
  askInvocation,
  captureSpawn,
  framePrompt,
  inheritSpawn,
  langFence,
  materializeArgs,
  parseTarget,
  pickEngine,
  resumeInvocation,
  sliceRange,
} from "../src/commands/ask.js";
import { parseFlags } from "../src/core.js";
import type {
  OwnedAiRouteRequest,
  OwnedAiRouteResult,
  OwnedAiRouteRunner,
} from "../src/dispatch/owned-ai-route.js";
import type { EngineReadiness } from "../src/preflight/types.js";

function ready(engine: string, level: EngineReadiness["level"] = "ready"): EngineReadiness {
  return {
    engine: engine as EngineReadiness["engine"],
    level,
    detail: `${engine}: ${level}`,
    checkedAt: "t",
  };
}

/** Silence out() console noise during ask() integration tests. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("parseTarget", () => {
  test("range, single line, and defaulting end=start", () => {
    expect(parseTarget("src/x.ts:5-12")).toEqual({ path: "src/x.ts", start: 5, end: 12 });
    expect(parseTarget("src/x.ts:7")).toEqual({ path: "src/x.ts", start: 7, end: 7 });
  });
  test("Windows drive letter kept (split on LAST colon)", () => {
    expect(parseTarget("C:\\a\\b.ts:3-4")).toEqual({ path: "C:\\a\\b.ts", start: 3, end: 4 });
  });
  test.each([
    ["undefined", undefined],
    ["no colon", "src/x.ts"],
    ["empty path", ":5-12"],
    ["non-numeric", "src/x.ts:abc"],
    ["zero start", "src/x.ts:0"],
    ["backwards", "src/x.ts:12-5"],
  ])("rejects %s", (_label, spec) => {
    expect(typeof parseTarget(spec as string | undefined)).toBe("string");
  });
});

describe("sliceRange", () => {
  const text = "l1\nl2\nl3\nl4\nl5";
  test("inclusive 1-indexed slice", () => {
    expect(sliceRange(text, 2, 4)).toEqual({ snippet: "l2\nl3\nl4" });
  });
  test("single line", () => {
    expect(sliceRange(text, 3, 3)).toEqual({ snippet: "l3" });
  });
  test("end past EOF clamps to available lines", () => {
    expect(sliceRange(text, 4, 99)).toEqual({ snippet: "l4\nl5" });
  });
  test("start past EOF errors", () => {
    expect(typeof sliceRange(text, 6, 6)).toBe("string");
  });
});

describe("langFence", () => {
  test.each([
    ["a.ts", "ts"],
    ["a.py", "python"],
    ["a.rs", "rust"],
    ["a.unknownext", ""],
    ["noext", ""],
  ])("%s → %s", (path, tag) => {
    expect(langFence(path)).toBe(tag);
  });
});

describe("framePrompt", () => {
  test("contains path, fence tag, snippet and question", () => {
    const p = framePrompt("src/x.ts", 5, 12, "ts", "const a = 1;", "why?");
    expect(p).toContain("In file src/x.ts, lines 5-12:");
    expect(p).toContain("```ts");
    expect(p).toContain("const a = 1;");
    expect(p).toContain("why?");
  });
  test("single-line phrasing", () => {
    expect(framePrompt("x.ts", 5, 5, "ts", "s", "q")).toContain("line 5:");
  });
});

describe("askInvocation", () => {
  test("claude/codex stream via stdin; copilot via arg; opencode via stdin", () => {
    expect(askInvocation("claude")).toEqual({ cmd: "claude", args: ["-p"], promptMode: "stdin" });
    expect(askInvocation("codex")).toEqual({
      cmd: "codex",
      args: ["exec", "-"],
      promptMode: "stdin",
    });
    expect(askInvocation("copilot")).toEqual({
      cmd: "copilot",
      args: ["-p", "--allow-all"],
      promptMode: "arg",
    });
    expect(askInvocation("opencode")).toEqual({
      cmd: "opencode",
      args: ["run", "--format", "json"],
      promptMode: "stdin",
    });
    expect(askInvocation("antigravity" as never)).toEqual({
      cmd: "agy",
      args: ["-p"],
      promptMode: "arg",
    });
  });
});

describe("materializeArgs (#562 — copilot -p takes a VALUE, order matters)", () => {
  test("copilot: prompt spliced IMMEDIATELY after -p, --allow-all stays trailing", () => {
    // Regression: appending at the end makes -p swallow --allow-all and the
    // question is silently lost. The prompt must sit right after -p.
    expect(materializeArgs(askInvocation("copilot"), "MY QUESTION")).toEqual([
      "-p",
      "MY QUESTION",
      "--allow-all",
    ]);
  });
  test("stdin engines: args unchanged (prompt goes on stdin, not argv)", () => {
    expect(materializeArgs(askInvocation("claude"), "Q")).toEqual(["-p"]);
    expect(materializeArgs(askInvocation("codex"), "Q")).toEqual(["exec", "-"]);
    expect(materializeArgs(askInvocation("opencode"), "Q")).toEqual(["run", "--format", "json"]);
  });
  test("arg mode with no -p flag: appends at end", () => {
    expect(materializeArgs({ cmd: "x", args: ["--foo"], promptMode: "arg" }, "Q")).toEqual([
      "--foo",
      "Q",
    ]);
  });
});

describe("antigravity argv guard (30KiB UTF-8 limit)", () => {
  test("prompt under 30KiB passes through normally", () => {
    const result = materializeArgs({ cmd: "agy", args: ["-p"], promptMode: "arg" }, "small prompt");
    expect(result).toEqual(["-p", "small prompt"]);
  });

  test("prompt at 30KiB exactly throws (>=, not >)", () => {
    const big = "x".repeat(30 * 1024);
    expect(() => materializeArgs({ cmd: "agy", args: ["-p"], promptMode: "arg" }, big)).toThrow(
      "Antigravity prompt too large for agy argv",
    );
  });

  test("prompt over 30KiB throws clear error", () => {
    const big = "x".repeat(30 * 1024 + 1);
    expect(() => materializeArgs({ cmd: "agy", args: ["-p"], promptMode: "arg" }, big)).toThrow(
      "Antigravity prompt too large for agy argv",
    );
  });

  test("non-agy engines are unaffected", () => {
    expect(() =>
      materializeArgs({ cmd: "copilot", args: ["-p"], promptMode: "arg" }, "x".repeat(30001)),
    ).not.toThrow();
  });

  test("agy with stdin mode is unaffected (prompt not on argv)", () => {
    expect(() =>
      materializeArgs({ cmd: "agy", args: ["-p"], promptMode: "stdin" }, "x".repeat(30001)),
    ).not.toThrow();
  });
});

describe("resumeInvocation (#562 multi-turn — engine-native continue)", () => {
  test("claude continues most-recent via -c -p", () => {
    expect(resumeInvocation("claude")).toEqual({
      cmd: "claude",
      args: ["-c", "-p"],
      promptMode: "stdin",
    });
  });
  test("codex resumes most-recent via exec resume --last", () => {
    expect(resumeInvocation("codex")).toEqual({
      cmd: "codex",
      args: ["exec", "resume", "--last", "-"],
      promptMode: "stdin",
    });
  });
  test("copilot has no resume → error string", () => {
    expect(typeof resumeInvocation("copilot")).toBe("string");
  });
  test("opencode resumes via --continue", () => {
    expect(resumeInvocation("opencode")).toEqual({
      cmd: "opencode",
      args: ["run", "--continue", "--format", "json"],
      promptMode: "stdin",
    });
  });
  test("antigravity resumes its workspace conversation via --continue -p", () => {
    expect(resumeInvocation("antigravity" as never)).toEqual({
      cmd: "agy",
      args: ["--continue", "-p"],
      promptMode: "arg",
    });
  });
});

function ownedRouteResult(overrides: Partial<OwnedAiRouteResult> = {}): OwnedAiRouteResult {
  return {
    attemptId: "ask-attempt",
    status: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

function ownedRouteFake(
  result: OwnedAiRouteResult,
  inspect?: (request: OwnedAiRouteRequest) => void,
): OwnedAiRouteRunner {
  return async (request) => {
    inspect?.(request);
    return result;
  };
}

describe("inheritSpawn (canonical owned-process route)", () => {
  test("stdin mode forwards exact engine, prompt and cloned environment", async () => {
    let request: OwnedAiRouteRequest | undefined;
    const code = await inheritSpawn(
      askInvocation("claude"),
      "hello",
      ownedRouteFake(ownedRouteResult(), (value) => {
        request = value;
      }),
    );
    expect(code).toBe(0);
    expect(request).toMatchObject({
      engine: "claude",
      command: "claude",
      args: ["-p"],
      input: "hello",
    });
    expect(request?.sourceEnv).not.toBe(process.env);
    expect(request?.sourceEnv?.PATH).toBe(process.env.PATH);
  });

  test("opencode prompt appears exactly once on stdin and never as a positional", async () => {
    let request: OwnedAiRouteRequest | undefined;
    const prompt = "OPENCODE PROMPT ONCE";
    const code = await inheritSpawn(
      askInvocation("opencode"),
      prompt,
      ownedRouteFake(ownedRouteResult(), (value) => {
        request = value;
      }),
    );
    expect(code).toBe(0);
    expect(request).toMatchObject({
      engine: "opencode",
      command: "opencode",
      args: ["run", "--format", "json"],
      input: prompt,
    });
    expect(request?.args).not.toContain("-");
    expect(
      [...(request?.args ?? []), request?.input ?? ""].filter((value) => value === prompt),
    ).toHaveLength(1);
  });

  test("arg mode materializes the prompt in argv and leaves stdin empty", async () => {
    let request: OwnedAiRouteRequest | undefined;
    const code = await inheritSpawn(
      askInvocation("copilot"),
      "PING",
      ownedRouteFake(ownedRouteResult(), (value) => {
        request = value;
      }),
    );
    expect(code).toBe(0);
    expect(request).toMatchObject({
      engine: "copilot",
      command: "copilot",
      args: ["-p", "PING", "--allow-all"],
      input: "",
    });
  });

  test("nonzero engine exit propagates", async () => {
    const code = await inheritSpawn(
      askInvocation("codex"),
      "x",
      ownedRouteFake(ownedRouteResult({ status: 2 })),
    );
    expect(code).toBe(2);
  });
});

describe("captureSpawn (canonical owned-process route)", () => {
  test("captures stdout and calls onChunk once with the completed text", async () => {
    let chunk: string | undefined;
    const result = await captureSpawn(
      askInvocation("claude"),
      "x",
      (text) => {
        chunk = text;
      },
      ownedRouteFake(ownedRouteResult({ stdout: "HELLO" })),
    );
    expect(result).toEqual({ code: 0, text: "HELLO" });
    expect(chunk).toBe("HELLO");
  });

  test("arg mode threads exact engine identity and materialized argv", async () => {
    let request: OwnedAiRouteRequest | undefined;
    const result = await captureSpawn(
      askInvocation("antigravity"),
      "PING",
      undefined,
      ownedRouteFake(ownedRouteResult({ stdout: "PING" }), (value) => {
        request = value;
      }),
    );
    expect(result).toEqual({ code: 0, text: "PING" });
    expect(request).toMatchObject({
      engine: "antigravity",
      command: "agy",
      args: ["-p", "PING"],
      input: "",
    });
  });

  test("nonzero status propagates and empty stdout falls back to stderr", async () => {
    const result = await captureSpawn(
      askInvocation("opencode"),
      "x",
      undefined,
      ownedRouteFake(ownedRouteResult({ status: 3, stderr: "BOOM" })),
    );
    expect(result).toEqual({ code: 3, text: "BOOM" });
  });

  test("rejects commands that cannot be mapped to an exact engine", async () => {
    await expect(
      captureSpawn(
        { cmd: "unknown-ai", args: [], promptMode: "stdin" },
        "x",
        undefined,
        ownedRouteFake(ownedRouteResult()),
      ),
    ).rejects.toThrow("unsupported ask engine command");
  });
});

describe("pickEngine", () => {
  const rl = [ready("claude", "no-binary"), ready("copilot"), ready("codex")];
  test("first ready in ENGINES priority order (claude,copilot,codex)", () => {
    expect(pickEngine(rl, undefined)).toBe("copilot");
  });
  test("override wins when ready", () => {
    expect(pickEngine(rl, "codex")).toBe("codex");
  });
  test("override not ready → error string", () => {
    expect(typeof pickEngine(rl, "claude")).toBe("string");
  });
  test("unknown override → error string", () => {
    expect(typeof pickEngine(rl, "gpt")).toBe("string");
  });
  test("none ready → error string", () => {
    expect(typeof pickEngine([ready("claude", "no-binary")], undefined)).toBe("string");
  });
});

describe("ask() integration (injected seams)", () => {
  function withFile(body: string, fn: (path: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "vf-ask-"));
    const path = join(dir, "snippet.ts");
    writeFileSync(path, body);
    return fn(path).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  function withRepoFile(body: string, fn: (path: string) => Promise<void>) {
    const dir = mkdtempSync(join(process.cwd(), ".vf-ask-"));
    const path = join(dir, "snippet.ts");
    writeFileSync(path, body);
    return fn(path).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  test("happy path: frames the prompt, calls spawn, returns its status", async () => {
    await withFile("a\nb\nc\nd\n", async (path) => {
      let seen: { inv: AskInvocation; prompt: string } | undefined;
      const code = await quiet(() =>
        ask(
          [`${path}:2-3`, "what", "is", "this?"],
          {},
          {
            readiness: () => [ready("claude")],
            spawn: (inv, prompt) => {
              seen = { inv, prompt };
              return 0;
            },
          },
        ),
      );
      expect(code).toBe(0);
      expect(seen?.inv.cmd).toBe("claude");
      expect(seen?.prompt).toContain("b\nc"); // the sliced range
      expect(seen?.prompt).toContain("what is this?"); // joined question
    });
  });

  test("propagates the engine's non-zero exit", async () => {
    await withFile("a\nb\n", async (path) => {
      const code = await quiet(() =>
        ask([`${path}:1-2`, "q"], {}, { readiness: () => [ready("claude")], spawn: () => 3 }),
      );
      expect(code).toBe(3);
    });
  });

  test("missing question → nonzero, spawn never called", async () => {
    await withFile("a\n", async (path) => {
      let called = false;
      const code = await quiet(() =>
        ask(
          [`${path}:1`],
          {},
          {
            readiness: () => [ready("claude")],
            spawn: () => {
              called = true;
              return 0;
            },
          },
        ),
      );
      expect(code).not.toBe(0);
      expect(called).toBe(false);
    });
  });

  test("bad target → nonzero", async () => {
    const code = await quiet(() =>
      ask(["not-a-target", "q"], {}, { readiness: () => [ready("claude")] }),
    );
    expect(code).not.toBe(0);
  });

  test("missing file → nonzero", async () => {
    const code = await quiet(() =>
      ask(["/no/such/file.ts:1-2", "q"], {}, { readiness: () => [ready("claude")] }),
    );
    expect(code).not.toBe(0);
  });

  test("range past EOF → nonzero", async () => {
    await withFile("a\nb\n", async (path) => {
      const code = await quiet(() =>
        ask([`${path}:50-60`, "q"], {}, { readiness: () => [ready("claude")] }),
      );
      expect(code).not.toBe(0);
    });
  });

  test("no ready engine → nonzero, spawn never called", async () => {
    await withFile("a\n", async (path) => {
      let called = false;
      const code = await quiet(() =>
        ask(
          [`${path}:1`, "q"],
          {},
          {
            readiness: () => [ready("claude", "no-binary")],
            spawn: () => {
              called = true;
              return 0;
            },
          },
        ),
      );
      expect(code).not.toBe(0);
      expect(called).toBe(false);
    });
  });

  test("--engine override threads through to spawn", async () => {
    await withFile("a\nb\n", async (path) => {
      let cmd = "";
      await quiet(() =>
        ask(
          [`${path}:1-2`, "q"],
          { engine: "codex" },
          {
            readiness: () => [ready("claude"), ready("codex")],
            spawn: (inv) => {
              cmd = inv.cmd;
              return 0;
            },
          },
        ),
      );
      expect(cmd).toBe("codex");
    });
  });

  test("--engine not ready → nonzero", async () => {
    await withFile("a\n", async (path) => {
      const code = await quiet(() =>
        ask(
          [`${path}:1`, "q"],
          { engine: "codex" },
          {
            readiness: () => [ready("claude"), ready("codex", "no-binary")],
          },
        ),
      );
      expect(code).not.toBe(0);
    });
  });

  test("--resume: continues most-recent, no target needed, sends only the question", async () => {
    let seen: { inv: AskInvocation; prompt: string } | undefined;
    const code = await quiet(() =>
      ask(
        ["and", "why", "is", "that?"],
        { resume: true },
        {
          readiness: () => [ready("claude")],
          spawn: (inv, prompt) => {
            seen = { inv, prompt };
            return 0;
          },
        },
      ),
    );
    expect(code).toBe(0);
    expect(seen?.inv.args).toEqual(["-c", "-p"]); // resume invocation, not a fresh ask
    expect(seen?.prompt).toBe("and why is that?"); // raw question, no snippet framing
  });

  test("--resume with no question → nonzero", async () => {
    const code = await quiet(() =>
      ask([], { resume: true }, { readiness: () => [ready("claude")] }),
    );
    expect(code).not.toBe(0);
  });

  test("--resume on copilot (no resume support) → nonzero", async () => {
    let called = false;
    const code = await quiet(() =>
      ask(
        ["follow up"],
        { resume: true, engine: "copilot" },
        {
          readiness: () => [ready("copilot")],
          spawn: () => {
            called = true;
            return 0;
          },
        },
      ),
    );
    expect(code).not.toBe(0);
    expect(called).toBe(false);
  });

  // REGRESSION (codex review): the documented `vf ask --resume "question"` goes
  // through the REAL parseFlags, which binds the next non-dash token as the flag's
  // VALUE → flags.resume === "question" (a string, not `true`). A naive
  // `flags.resume === true` check misses it and the headline feature breaks. Drive
  // the actual parser here, not a hand-built {resume:true}.
  test("--resume through the REAL flag parser: question bound as the flag value still resumes", async () => {
    const { positionals, flags } = parseFlags(["--resume", "ok, and is that thread-safe?"]);
    expect(flags.resume).toBe("ok, and is that thread-safe?"); // parseFlags swallowed it
    let seen: { inv: AskInvocation; prompt: string } | undefined;
    const code = await quiet(() =>
      ask(positionals, flags, {
        readiness: () => [ready("claude")],
        spawn: (inv, prompt) => {
          seen = { inv, prompt };
          return 0;
        },
      }),
    );
    expect(code).toBe(0);
    expect(seen?.inv.args).toEqual(["-c", "-p"]); // resumed, not a fresh ask
    expect(seen?.prompt).toBe("ok, and is that thread-safe?");
  });

  test("--resume value + trailing positionals concatenate into the question", async () => {
    const { positionals, flags } = parseFlags(["--resume", "why", "is", "that"]);
    let seen: { prompt: string } | undefined;
    const code = await quiet(() =>
      ask(positionals, flags, {
        readiness: () => [ready("claude")],
        spawn: (_inv, prompt) => {
          seen = { prompt };
          return 0;
        },
      }),
    );
    expect(code).toBe(0);
    expect(seen?.prompt).toBe("why is that");
  });

  test("--conversation routes the framed prompt through the shared conversation service", async () => {
    await withFile("a\nb\nc\n", async (path) => {
      let seen = "";
      const code = await quiet(() =>
        ask(
          [`${path}:2-3`, "why"],
          { conversation: "conversation-123" },
          {
            readiness: () => [ready("claude")],
            createService: () =>
              ({
                message: async (_id: string, request: { content: string }) => {
                  seen = request.content;
                  return {
                    message_id: "message-1",
                    accepted: true,
                    child_conversation_id: "conversation-124",
                  };
                },
                snapshot: async () => ({ lifecycle: "COMPLETED" }),
                subscribe: () => () => undefined,
              }) as never,
          },
        ),
      );
      expect(code).toBe(0);
      expect(seen).toContain("b\nc");
      expect(seen).toContain("why");
    });
  });

  test("fresh ask without an injected spawn uses the shared direct-policy conversation service", async () => {
    await withFile("a\nb\nc\n", async (path) => {
      let started: Record<string, unknown> | undefined;
      const code = await quiet(() =>
        ask(
          [`${path}:2-3`, "explain", "this"],
          {},
          {
            readiness: () => [ready("claude")],
            createService: () =>
              ({
                start: async (request: {
                  topic: string;
                  policy: string;
                  participants: unknown[];
                }) => {
                  started = request as unknown as Record<string, unknown>;
                  return {
                    conversation_id: "conversation-1",
                    revision_id: "revision-1",
                    operation_id: "operation-1",
                    completion: Promise.resolve({
                      conversation_id: "conversation-1",
                      revision_id: "revision-1",
                      result: {
                        operation_id: "operation-1",
                        status: "completed",
                        artifact_refs: [],
                      },
                    }),
                  };
                },
                subscribe: () => () => undefined,
              }) as never,
          },
        ),
      );
      expect(code).toBe(0);
      expect(started).toMatchObject({
        policy: "direct",
        participants: [{ role_ref: "direct", engine: "claude" }],
      });
      expect(String(started?.topic)).toContain("b\nc");
      expect(String(started?.topic)).toContain("explain this");
    });
  });

  test("production fresh ask stages a repo-relative private range instead of embedding source bytes", async () => {
    await withRepoFile("alpha\nbeta\n", async (path) => {
      let seen: Record<string, unknown> | undefined;
      const code = await quiet(() =>
        ask(
          [`${path}:1-2`, "why"],
          {},
          {
            readiness: () => [ready("claude")],
            durable: {
              ask: async (input) => {
                seen = input as unknown as Record<string, unknown>;
                return {
                  conversation_id: "conversation-1",
                  conversationId: "conversation-1",
                  status: "completed",
                  output: "",
                  events: [],
                };
              },
              message: async () => {
                throw new Error("unexpected durable message call");
              },
            },
          },
        ),
      );
      expect(code).toBe(0);
      expect(seen).toMatchObject({
        request: {
          kind: "fresh",
          question: "why",
          start_line: 1,
          end_line: 2,
          engine: "claude",
          repo_relative_path: expect.stringMatching(/snippet\.ts$/),
        },
      });
      expect(JSON.stringify(seen)).not.toContain("alpha");
      expect(JSON.stringify(seen)).not.toContain("beta");
    });
  });

  test("production resume fails closed without --conversation", async () => {
    let called = false;
    const code = await quiet(() =>
      ask(
        ["follow", "up"],
        { resume: true },
        {
          durable: {
            ask: async () => {
              called = true;
              return {
                conversation_id: "conversation-1",
                conversationId: "conversation-1",
                status: "completed",
                output: "",
                events: [],
              };
            },
            message: async () => {
              called = true;
              return {
                conversation_id: "conversation-1",
                conversationId: "conversation-1",
                status: "completed",
                output: "",
                events: [],
              };
            },
          },
        },
      ),
    );
    expect(code).not.toBe(0);
    expect(called).toBe(false);
  });

  test("production conversation ask with a target queues only the question plus private context", async () => {
    await withRepoFile("alpha\nbeta\n", async (path) => {
      let seen: Record<string, unknown> | undefined;
      const code = await quiet(() =>
        ask(
          [`${path}:1-2`, "revise", "that"],
          { conversation: "conversation-123" },
          {
            durable: {
              ask: async () => {
                throw new Error("unexpected durable ask create");
              },
              message: async (input) => {
                seen = input as unknown as Record<string, unknown>;
                return {
                  conversation_id: "conversation-124",
                  conversationId: "conversation-124",
                  child_conversation_id: "conversation-124",
                  childConversationId: "conversation-124",
                  status: "completed",
                  output: "",
                  events: [],
                };
              },
            },
          },
        ),
      );
      expect(code).toBe(0);
      expect(seen).toMatchObject({
        conversation_id: "conversation-123",
        content: "revise that",
        private_file_range: {
          start_line: 1,
          end_line: 2,
          repo_relative_path: expect.stringMatching(/snippet\.ts$/),
        },
      });
      expect(String(seen?.content)).not.toContain("In file");
      expect(JSON.stringify(seen)).not.toContain("alpha");
      expect(JSON.stringify(seen)).not.toContain("beta");
    });
  });
});
