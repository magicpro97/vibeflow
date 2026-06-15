import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { makeAsyncSpawner, runDispatch, tokenizeVibeflowAi } from "../src/dispatch.js";

describe("bridge spawner shell default", () => {
  test("default options do NOT enable shell (argv form, metachar literal)", async () => {
    // The async spawner's default is shell:false. We can prove this by
    // spawning a command whose behaviour differs between shell:true and
    // shell:false for a payload containing a metacharacter. `echo` is
    // the simplest: shell:false echoes args literally (including `;`),
    // shell:true would split the `;` and the second arg never runs.
    const spawner = makeAsyncSpawner();
    // Use `printf` with a single explicit format arg and let the `;`
    // come through as a separate arg. argv form: printf sees [echo, ";", "x"],
    // prints ";x". shell form would attempt to run `; x` as a 2nd command.
    const r = await spawner("printf", ["%s%s", ";", "x"], "");
    // argv form: printf formats as one %s per arg → ";x". (If you passed
    // just 1 %s, it would repeat for each arg, hence two %s here so each
    // arg produces one char.)
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(";x");
  });

  test("explicit shell:true still works (opt-in preserved)", async () => {
    // If a future caller passes shell:true, the spawner should still
    // work. With shell:true on POSIX it uses `/bin/sh -c`, so the args
    // get joined and the `;` becomes a command separator — exit 127
    // because `a` is not a command, but the call still returned.
    const spawner = makeAsyncSpawner({ shell: true });
    const r = await spawner("/bin/sh", ["-c", "exit 0"], "");
    expect(r.status).toBe(0);
  });
});

describe("sync runDispatch bridge spawner (B3 + stealth B4 fix)", () => {
  // The sync path used to spawn `/bin/sh -c <VIBEFLOW_AI>`, which let a
  // malicious VIBEFLOW_AI like "x; rm -rf $HOME" break out and run arbitrary
  // shell. After the fix, VIBEFLOW_AI is tokenized argv-form: no shell, so
  // metacharacters are literal data and the OS will simply fail to exec the
  // resulting argv[0].

  test("VIBEFLOW_AI with shell metacharacters does not invoke a shell", () => {
    // A command that, if passed to /bin/sh -c, would create a marker file as
    // a side effect. After the fix the whole string is tokenized as argv,
    // so `touch` receives the literal argument `/tmp/pwn-marker;` (which is
    // a non-existent file name with a `;` in it) and the spawn fails without
    // ever executing the `; echo safe` second command.
    const marker = `/tmp/pwn-marker-${process.pid}-${Date.now()}`;
    const prev = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = `touch ${marker}; echo safe`;
    try {
      const r = runDispatch({
        engine: "claude",
        mode: "bridge",
        prompt: "hello",
        has: () => false,
      });
      // The marker must NOT have been created — the only way it could be is
      // if a shell parsed the `;` and ran `touch <marker>` as its own command.
      expect(existsSync(marker)).toBe(false);
      // And the response must not contain the `echo safe` output (no second
      // command ran).
      expect(r.raw).not.toContain("safe");
    } finally {
      if (prev === undefined) process.env.VIBEFLOW_AI = undefined;
      else process.env.VIBEFLOW_AI = prev;
    }
  });

  test("sync bridge spawner passes through filtered env (no raw process.env leak)", () => {
    // We can't directly read the child's env from a sync spawn without
    // instrumenting, so use a real command that echoes a sensitive variable.
    // If filterChildEnv is wired, the variable will be missing from the child.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevBridge = process.env.VIBEFLOW_AI;
    process.env.ANTHROPIC_API_KEY = "should-still-pass-allowlisted-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "should-be-blocked-secret";
    process.env.VIBEFLOW_AI = "env";
    try {
      const r = runDispatch({
        engine: "claude",
        mode: "bridge",
        prompt: "hello",
        has: () => false,
      });
      // ANTHROPIC_API_KEY is in ALLOWLIST so it should propagate.
      expect(r.raw).toContain("should-still-pass-allowlisted-secret");
      // AWS_SECRET_ACCESS_KEY matches /^AWS_/ denylist and is NOT in ALLOWLIST
      // so it must be filtered out of the child env.
      expect(r.raw).not.toContain("should-be-blocked-secret");
    } finally {
      if (prevKey === undefined) process.env.ANTHROPIC_API_KEY = undefined;
      else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevBridge === undefined) process.env.VIBEFLOW_AI = undefined;
      else process.env.VIBEFLOW_AI = prevBridge;
    }
  });
});

describe("tokenizeVibeflowAi (VIBEFLOW_AI multi-token support)", () => {
  // BREAKING: VIBEFLOW_AI used to be a shell string passed to `sh -c`.
  // Now it's tokenized argv. Users with "my-llm --model x" need to keep
  // the multi-token form working — split-on-whitespace, not literal-name.
  test("splits simple command + args", () => {
    expect(tokenizeVibeflowAi("my-llm --model gpt-x")).toEqual(["my-llm", "--model", "gpt-x"]);
  });

  test("collapses multiple whitespace", () => {
    expect(tokenizeVibeflowAi("my-llm    --model    x")).toEqual(["my-llm", "--model", "x"]);
  });

  test("trims leading/trailing whitespace", () => {
    expect(tokenizeVibeflowAi("   my-llm --model x   ")).toEqual(["my-llm", "--model", "x"]);
  });

  test("empty string returns []", () => {
    expect(tokenizeVibeflowAi("")).toEqual([]);
    expect(tokenizeVibeflowAi("   ")).toEqual([]);
  });

  test("single token stays as [token]", () => {
    expect(tokenizeVibeflowAi("my-llm")).toEqual(["my-llm"]);
  });
});
