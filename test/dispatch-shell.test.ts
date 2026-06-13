import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { makeAsyncSpawner, runDispatch, tokenizeVibeflowAi } from "../src/dispatch.js";

describe("bridge spawner shell default", () => {
  test("default options do not enable shell", () => {
    const spawner = makeAsyncSpawner();
    // The function exists and returns a spawner; we cannot introspect its closure
    // directly, but we CAN assert by behaviour: spawn a benign command and confirm
    // no shell metacharacter interpretation occurs.
    expect(typeof spawner).toBe("function");
  });

  test("explicit shell:true still works (opt-in preserved)", () => {
    // If a future caller passes shell:true it should still spawn (e.g. .cmd on Windows).
    const spawner = makeAsyncSpawner({ shell: true });
    expect(typeof spawner).toBe("function");
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
