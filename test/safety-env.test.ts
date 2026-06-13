import { describe, expect, test } from "bun:test";
import { filterChildEnv, isAllowedKey } from "../src/safety/env.js";

describe("env allowlist", () => {
  test("isAllowedKey returns true for VIBEFLOW_AI", () => {
    expect(isAllowedKey("VIBEFLOW_AI")).toBe(true);
  });

  test("isAllowedKey returns false for non-engine secrets", () => {
    // Engine auth keys (ANTHROPIC_API_KEY, GITHUB_TOKEN, etc.) are explicitly
    // allowlisted because claude/codex/copilot binaries need them to auth.
    // Other secret-prefixed keys are blocked.
    expect(isAllowedKey("AWS_ACCESS_KEY_ID")).toBe(false);
    expect(isAllowedKey("AWS_SECRET_ACCESS_KEY")).toBe(false);
    expect(isAllowedKey("RANDOM_SECRET")).toBe(false);
    expect(isAllowedKey("SECRET_API_KEY")).toBe(false);
    expect(isAllowedKey("CONTEXT7_API_KEY")).toBe(false); // parent-only, never child
  });

  test("isAllowedKey returns true for engine auth keys (claude/codex/copilot need them)", () => {
    // These MUST propagate to children, or engine auth fails.
    expect(isAllowedKey("ANTHROPIC_API_KEY")).toBe(true);
    expect(isAllowedKey("OPENAI_API_KEY")).toBe(true);
    expect(isAllowedKey("GH_TOKEN")).toBe(true);
    expect(isAllowedKey("COPILOT_GITHUB_TOKEN")).toBe(true);
    expect(isAllowedKey("GEMINI_API_KEY")).toBe(true);
  });

  test("deny-first for unknown secrets: suffix pattern blocks even generic-prefix keys", () => {
    // Allowlist explicitly opts in known engine keys. Denylist catches
    // anything else with a secret suffix that isn't explicitly opted in.
    // A maintainer who accidentally adds a generic suffix to ALLOWLIST
    // would still need to add the exact key name (e.g. "AWS_FOO_TOKEN")
    // — the denylist runs against the name itself, not prefixes.
    // Verify: keys with secret suffixes that are NOT in ALLOWLIST are blocked.
    expect(isAllowedKey("AWS_FOO_TOKEN")).toBe(false); // not in ALLOWLIST
    expect(isAllowedKey("SOME_RANDOM_SECRET")).toBe(false); // not in ALLOWLIST
    expect(isAllowedKey("ANTHROPIC_FOO_TOKEN")).toBe(false); // not in ALLOWLIST
  });

  test("filterChildEnv drops secret-suffix keys regardless of prefix", () => {
    const input = {
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: "AKIA...",
      AWS_SECRET_ACCESS_KEY: "x",
      RANDOM_SECRET: "x",
      SECRET_API_KEY: "y",
      CONTEXT7_API_KEY: "ctx-key",
      VIBEFLOW_AI: "echo",
      // GITHUB_TOKEN is explicitly allowlisted (engine auth), so it propagates.
      // This test is for the denylist catching OTHER secrets, not engine auth.
    };
    const out = filterChildEnv(input);
    expect(out.PATH).toBe("/usr/bin");
    expect(out.VIBEFLOW_AI).toBe("echo");
    expect(out).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(out).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(out).not.toHaveProperty("RANDOM_SECRET");
    expect(out).not.toHaveProperty("SECRET_API_KEY");
    expect(out).not.toHaveProperty("CONTEXT7_API_KEY");
  });

  test("filterChildEnv propagates engine auth keys (claude/codex/copilot)", () => {
    const out = filterChildEnv({
      ANTHROPIC_API_KEY: "sk-ant-...",
      OPENAI_API_KEY: "sk-...",
      GH_TOKEN: "ghp_...",
      COPILOT_GITHUB_TOKEN: "ghu_...",
    });
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-...");
    expect(out.OPENAI_API_KEY).toBe("sk-...");
    expect(out.GH_TOKEN).toBe("ghp_...");
    expect(out.COPILOT_GITHUB_TOKEN).toBe("ghu_...");
  });

  test("filterChildEnv passes PATH, HOME, TMPDIR, LANG through", () => {
    const out = filterChildEnv({
      PATH: "/x",
      HOME: "/h",
      TMPDIR: "/t",
      LANG: "en",
    });
    expect(out).toEqual({ PATH: "/x", HOME: "/h", TMPDIR: "/t", LANG: "en" });
  });

  test("isAllowedKey denies unknown keys by default", () => {
    // Deny-by-default: keys not in ALLOWLIST and not matching a denylist
    // pattern are BLOCKED. This is the secure default — previous behaviour
    // of passing unknown keys through was the bug.
    expect(isAllowedKey("MY_CUSTOM_RUNTIME_VAR")).toBe(false);
    expect(isAllowedKey("SOMETHING_NOT_IN_ALLOWLIST")).toBe(false);
    expect(isAllowedKey("FOOBAR_BAZ_QUX")).toBe(false);
    expect(isAllowedKey("RANDOM_APP_CONFIG")).toBe(false);
  });

  test("filterChildEnv passes SSH_AUTH_SOCK + Windows shell resolution keys", () => {
    // SSH_AUTH_SOCK is plumbing: the path to the ssh-agent socket. The agent
    // holds the actual keys; the child can authenticate via the socket without
    // ever seeing the key material. Stripping it breaks git push / ssh auth.
    // PATHEXT / COMSPEC / SYSTEMROOT are required for Windows process spawn
    // to resolve .cmd / .bat shims and the cmd.exe interpreter.
    const out = filterChildEnv({
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
      SYSTEMROOT: "C:\\Windows",
    });
    expect(out.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(out.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
    expect(out.COMSPEC).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(out.SYSTEMROOT).toBe("C:\\Windows");
  });
});
