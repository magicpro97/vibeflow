import { afterAll, describe, expect, test } from "bun:test";
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
  test("claude/codex stream via stdin; copilot via arg", () => {
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
  });
  test("arg mode with no -p flag: appends at end", () => {
    expect(materializeArgs({ cmd: "x", args: ["--foo"], promptMode: "arg" }, "Q")).toEqual([
      "--foo",
      "Q",
    ]);
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
});

describe("inheritSpawn (real process, cross-platform via node)", () => {
  test("stdin mode: pipes prompt, returns exit status 0", () => {
    // `node -e ""` ignores stdin and exits 0 — proves the stdin/pipe branch runs.
    const code = inheritSpawn({ cmd: "node", args: ["-e", ""], promptMode: "stdin" }, "hello");
    expect(code).toBe(0);
  });
  test("arg mode: prompt appended to argv (no -p flag to splice after)", () => {
    // materializeArgs order-after-`-p` is proven in its own describe; here just
    // confirm arg-mode delivers the prompt as an argv token. Avoid a literal `-p`
    // in the node args — node would consume it as its OWN print flag.
    const code = inheritSpawn(
      {
        cmd: "node",
        args: ["-e", "process.exit(process.argv[1] === 'PING' ? 0 : 4)"],
        promptMode: "arg",
      },
      "PING",
    );
    expect(code).toBe(0);
  });
  test("nonzero engine exit propagates", () => {
    const code = inheritSpawn(
      { cmd: "node", args: ["-e", "process.exit(2)"], promptMode: "stdin" },
      "x",
    );
    expect(code).toBe(2);
  });
});

describe("captureSpawn (real process, cross-platform via node) — #562 Stage B", () => {
  test("stdin mode: captures stdout, code 0, onChunk fires with the text", () => {
    let chunk: string | undefined;
    const r = captureSpawn(
      { cmd: "node", args: ["-e", 'process.stdout.write("HELLO")'], promptMode: "stdin" },
      "x",
      (s) => {
        chunk = s;
      },
    );
    expect(r.code).toBe(0);
    expect(r.text).toContain("HELLO");
    expect(chunk).toBe(r.text);
  });

  test("arg mode: prompt delivered as an argv token, captured back", () => {
    // Ordering-after-`-p` is proven in the materializeArgs describe. Here confirm
    // arg-mode captures the prompt token. No literal `-p` (node would eat it).
    const r = captureSpawn(
      {
        cmd: "node",
        args: ["-e", "process.stdout.write(process.argv[1])"],
        promptMode: "arg",
      },
      "PING",
    );
    expect(r.code).toBe(0);
    expect(r.text).toBe("PING");
  });

  test("nonzero engine exit propagates in code", () => {
    const r = captureSpawn(
      { cmd: "node", args: ["-e", "process.exit(3)"], promptMode: "stdin" },
      "x",
    );
    expect(r.code).toBe(3);
  });

  test("empty stdout falls back to stderr so failures are visible", () => {
    const r = captureSpawn(
      {
        cmd: "node",
        args: ["-e", 'process.stderr.write("BOOM"); process.exit(1)'],
        promptMode: "stdin",
      },
      "x",
    );
    expect(r.code).toBe(1);
    expect(r.text).toBe("BOOM"); // stderr surfaced, not blank
  });

  // #582: env-filtering — DEFAULT_DENY scrubs secrets; ALWAYS_KEEP preserves PATH.
  const AWS_SECRET_KEY = "AWS_SECRET_ACCESS_KEY";
  const origSecret = process.env[AWS_SECRET_KEY];
  const origPath = process.env.PATH;

  test("DEFAULT_DENY scrubs secret-shaped vars from captureSpawn child env", () => {
    process.env[AWS_SECRET_KEY] = "test-secret-should-not-leak";
    try {
      const r = captureSpawn(
        {
          cmd: "node",
          args: ["-e", `process.stdout.write(process.env.${AWS_SECRET_KEY} || 'SCRUBBED')`],
          promptMode: "stdin",
        },
        "x",
      );
      expect(r.code).toBe(0);
      expect(r.text).toBe("SCRUBBED");
    } finally {
      delete process.env[AWS_SECRET_KEY];
    }
  });

  test("ALWAYS_KEEP preserves PATH in captureSpawn child env", () => {
    const save = process.env.PATH;
    // spawn via the absolute node path so a mutated PATH can't break process lookup;
    // the child prints its inherited PATH to prove ALWAYS_KEEP passed it through.
    process.env.PATH = `/test/path:${save}`;
    try {
      const r = captureSpawn(
        {
          cmd: process.execPath,
          args: [
            "-e",
            "process.stdout.write((process.env.PATH || '').includes('/test/path') ? 'HASPATH' : 'NOPATH')",
          ],
          promptMode: "stdin",
        },
        "x",
      );
      expect(r.code).toBe(0);
      expect(r.text).toBe("HASPATH");
    } finally {
      process.env.PATH = save;
    }
  });

  test("inheritSpawn returns 0 with filtered env (secret dropped, child still exits clean)", () => {
    process.env[AWS_SECRET_KEY] = "test-secret-should-not-leak-inherit";
    try {
      const code = inheritSpawn({ cmd: "node", args: ["-e", ""], promptMode: "stdin" }, "x");
      expect(code).toBe(0);
    } finally {
      delete process.env[AWS_SECRET_KEY];
    }
  });

  // Restore env after all #582 tests
  afterAll(() => {
    if (origSecret !== undefined) process.env[AWS_SECRET_KEY] = origSecret;
    else delete process.env[AWS_SECRET_KEY];
    if (origPath !== undefined) process.env.PATH = origPath;
    // biome-ignore lint/performance/noDelete: restore to truly-absent, not the string "undefined"
    else delete process.env.PATH;
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
});
