import { describe, expect, test } from "bun:test";
import { filterChildEnv, isAllowedKey } from "../src/safety/env.js";

describe("env allowlist", () => {
  test("isAllowedKey returns true for VIBEFLOW_AI", () => {
    expect(isAllowedKey("VIBEFLOW_AI")).toBe(true);
  });

  test("isAllowedKey returns false for secrets like AWS_ACCESS_KEY_ID", () => {
    expect(isAllowedKey("AWS_ACCESS_KEY_ID")).toBe(false);
    expect(isAllowedKey("GITHUB_TOKEN")).toBe(false);
    expect(isAllowedKey("ANTHROPIC_API_KEY")).toBe(false);
  });

  test("filterChildEnv drops secret-suffix keys regardless of prefix", () => {
    const input = {
      PATH: "/usr/bin",
      AWS_ACCESS_KEY_ID: "AKIA...",
      GITHUB_TOKEN: "ghp_...",
      RANDOM_SECRET: "x",
      SECRET_API_KEY: "y",
      VIBEFLOW_AI: "echo",
    };
    const out = filterChildEnv(input);
    expect(out.PATH).toBe("/usr/bin");
    expect(out.VIBEFLOW_AI).toBe("echo");
    expect(out).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(out).not.toHaveProperty("GITHUB_TOKEN");
    expect(out).not.toHaveProperty("RANDOM_SECRET");
    expect(out).not.toHaveProperty("SECRET_API_KEY");
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
});
