import { describe, expect, test } from "bun:test";
import {
  ALWAYS_KEEP,
  DEFAULT_DENY,
  type EnvPolicy,
  filterEnv,
  matchesGlob,
} from "../../src/dispatch/env-filter.js";

describe("filterEnv — default policy (deny-known-secrets, pass the rest)", () => {
  test("drops well-known secret-shaped vars", () => {
    const { env, dropped } = filterEnv({
      AWS_SECRET_ACCESS_KEY: "sekret",
      STRIPE_SECRET_KEY: "sk_live_x",
      DATABASE_URL: "postgres://u:p@h/db",
      PATH: "/usr/bin",
    });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(dropped).toContain("AWS_SECRET_ACCESS_KEY");
    expect(dropped).toContain("STRIPE_SECRET_KEY");
    expect(dropped).toContain("DATABASE_URL");
  });

  test("keeps essentials + engine auth vars", () => {
    const { env, dropped } = filterEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-ant",
      GH_TOKEN: "ghp_x",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.GH_TOKEN).toBe("ghp_x");
    expect(dropped).toEqual([]);
  });

  test("ALWAYS_KEEP beats deny — GH_TOKEN matches *_TOKEN but is kept", () => {
    // GH_TOKEN matches the DEFAULT_DENY `*_TOKEN` glob yet must ride through.
    expect(DEFAULT_DENY).toContain("*_TOKEN");
    expect(matchesGlob("GH_TOKEN", "*_TOKEN")).toBe(true);
    const { env, dropped } = filterEnv({ GH_TOKEN: "ghp_x", RANDOM_TOKEN: "leak" });
    expect(env.GH_TOKEN).toBe("ghp_x");
    expect(env.RANDOM_TOKEN).toBeUndefined();
    expect(dropped).toEqual(["RANDOM_TOKEN"]);
  });

  test("keeps unrelated non-secret vars (pass the rest)", () => {
    const { env, dropped } = filterEnv({ MY_APP_MODE: "prod", COLUMNS: "80" });
    expect(env.MY_APP_MODE).toBe("prod");
    expect(env.COLUMNS).toBe("80");
    expect(dropped).toEqual([]);
  });

  test("LC_* prefix kept; empty policy = default", () => {
    const { env } = filterEnv({ LC_ALL: "en_US.UTF-8", LC_CTYPE: "UTF-8" }, {});
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBe("UTF-8");
  });

  test("VF_*/VIBEFLOW_* signalling vars ride through", () => {
    const { env } = filterEnv({ VF_DENY_TOOLS: "Write,Edit", VIBEFLOW_AI: "x" });
    expect(env.VF_DENY_TOOLS).toBe("Write,Edit");
    expect(env.VIBEFLOW_AI).toBe("x");
  });

  test("undefined-valued keys are never materialized", () => {
    const src: NodeJS.ProcessEnv = { PATH: "/bin", GHOST: undefined };
    const { env, dropped } = filterEnv(src);
    expect("GHOST" in env).toBe(false);
    expect(dropped).not.toContain("GHOST");
  });
});

describe("filterEnv — allowlist strict mode", () => {
  test("allow:[glob] keeps only matches + essentials, drops the rest", () => {
    const policy: EnvPolicy = { allow: ["MY_*"] };
    const { env, dropped } = filterEnv({ MY_VAR: "ok", FOO: "nope", PATH: "/bin" }, policy);
    expect(env.MY_VAR).toBe("ok");
    expect(env.PATH).toBe("/bin"); // essential survives strict mode
    expect(env.FOO).toBeUndefined();
    expect(dropped).toEqual(["FOO"]);
  });
});

describe("filterEnv — custom deny", () => {
  test("deny:[glob] drops the match, keeps siblings", () => {
    const { env, dropped } = filterEnv({ FOO_BAR: "x", BAR: "y" }, { deny: ["FOO_*"] });
    expect(env.FOO_BAR).toBeUndefined();
    expect(env.BAR).toBe("y");
    expect(dropped).toEqual(["FOO_BAR"]);
  });
});

describe("filterEnv — Windows case-insensitive", () => {
  test('platform:"win32" matches names case-insensitively', () => {
    const { env, dropped } = filterEnv(
      { Path: "C:\\bin", aws_secret_key: "leak", SystemRoot: "C:\\Windows" },
      {},
      "win32",
    );
    expect(env.Path).toBe("C:\\bin"); // PATH essential, any case
    expect(env.SystemRoot).toBe("C:\\Windows"); // Windows essential
    expect(env.aws_secret_key).toBeUndefined(); // AWS_* / *_SECRET_KEY, any case
    expect(dropped).toEqual(["aws_secret_key"]);
  });
});

describe("filterEnv — dropped list shape", () => {
  test("dropped = sorted var NAMES only, never values", () => {
    const { dropped } = filterEnv({
      STRIPE_SECRET_KEY: "sk_live_zzz",
      AWS_ACCESS_KEY_ID: "AKIA",
      DATABASE_URL: "postgres://secret",
    });
    expect(dropped).toEqual([...dropped].sort()); // sorted
    expect(dropped).toEqual(["AWS_ACCESS_KEY_ID", "DATABASE_URL", "STRIPE_SECRET_KEY"]);
    // no secret VALUE ever appears in the audit list
    expect(dropped.join(" ")).not.toContain("sk_live_zzz");
    expect(dropped.join(" ")).not.toContain("postgres://secret");
  });
});

describe("matchesGlob — prefix/suffix/exact ceiling", () => {
  test("prefix, suffix, exact", () => {
    expect(matchesGlob("AWS_REGION", "AWS_*")).toBe(true);
    expect(matchesGlob("FOO_TOKEN", "*_TOKEN")).toBe(true);
    expect(matchesGlob("DATABASE_URL", "DATABASE_URL")).toBe(true);
    expect(matchesGlob("PATH", "AWS_*")).toBe(false);
    expect(matchesGlob("TOKEN_X", "*_TOKEN")).toBe(false);
  });
});

describe("ALWAYS_KEEP / DEFAULT_DENY exported sets", () => {
  test("expose the constants for CLI/UI summaries", () => {
    expect(ALWAYS_KEEP).toContain("PATH");
    expect(ALWAYS_KEEP).toContain("GH_TOKEN");
    expect(DEFAULT_DENY).toContain("AWS_*");
    expect(DEFAULT_DENY).toContain("*_API_KEY");
  });

  // cross-review #575 P2: common DB/connection-string/bare-secret shapes must drop by default.
  test("default policy drops common DB/connection-string + bare secret vars", () => {
    const env = {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "keep",
      GH_TOKEN: "keep",
      PGPASSWORD: "x",
      DATABASE_URI: "x",
      REDIS_URL: "x",
      MONGODB_URI: "x",
      MYSQL_PWD: "x",
      KUBECONFIG: "x",
      SECRET_KEY: "x",
      API_KEY: "x",
      ACCESS_TOKEN: "x",
    };
    const { env: filtered, dropped } = filterEnv(env);
    for (const secret of [
      "PGPASSWORD",
      "DATABASE_URI",
      "REDIS_URL",
      "MONGODB_URI",
      "MYSQL_PWD",
      "KUBECONFIG",
      "SECRET_KEY",
      "API_KEY",
      "ACCESS_TOKEN",
    ]) {
      expect(dropped).toContain(secret);
      expect(filtered[secret]).toBeUndefined();
    }
    // Auth + essentials still ride through.
    expect(filtered.ANTHROPIC_API_KEY).toBe("keep");
    expect(filtered.GH_TOKEN).toBe("keep");
    expect(filtered.PATH).toBe("/bin");
  });
});
