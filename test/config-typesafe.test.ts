import { describe, expect, test } from "bun:test";
import { spawnSync as cpSpawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  TYPESAFE_EGRESS_LINES,
  configTypesafe,
  promptHidden,
} from "../src/commands/config-typesafe.js";
import { readSettings } from "../src/settings.js";
import { typesafeHealthPath } from "../src/typesafe-health.js";
import { TYPESAFE_CALL_SITE_NAMES, typesafeEnvPath } from "../src/typesafe-settings.js";
import type { JudgeInject } from "../src/typesafe.js";

const repo = (): string => mkdtempSync(join(tmpdir(), "vf-ts-cli-"));
/** A per-user `.vibeflow` root, created because the health/env writers need it to exist. */
const userRoot = (): string => {
  const r = join(mkdtempSync(join(tmpdir(), "vf-ts-root-")), ".vibeflow");
  mkdirSync(r, { recursive: true, mode: 0o700 });
  // `ensurePrivateDirectory` pins the mode bits at 0700 and refuses anything else, so the
  // fixture matches the per-user root `vf init` creates.
  chmodSync(r, 0o700);
  return r;
};
const silence = () => {};
const withKey = { TYPESAFE_API_KEY: "k" } as NodeJS.ProcessEnv;

/** A collector that returns the lines it saw, so a test can assert order and content. */
const collector = () => {
  const lines: string[] = [];
  return { lines, out: (s: string) => void lines.push(String(s)) };
};

/** The record an `idle` breaker writes: the minimal total-valid `TypesafeHealth`. */
const HEALTH = {
  schema_version: 1,
  state: "idle",
  fail_streak: 0,
  consecutive_trips: 0,
  cooldown_ms: 60_000,
  last_class: "none",
} as const;

/** Persist a partial `typesafe` block the way an earlier subcommand would have. */
const enable = (base: string): void => {
  const p = join(base, ".vibeflow", "SETTINGS.json");
  mkdirSync(join(base, ".vibeflow"), { recursive: true });
  writeFileSync(p, JSON.stringify({ typesafe: { enabled: true } }, null, 2));
};

const OPEN_COOLDOWN_LINE = (root: string) =>
  `remove both: rm -f ${typesafeHealthPath(root)} ${typesafeEnvPath(root)}`;

describe("vf config typesafe — status", () => {
  test("status on a fresh repo reports off + no key source", async () => {
    const { lines, out } = collector();
    const code = await configTypesafe(["status"], repo(), {}, { out, env: {} });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("off");
  });

  test("bare `vf config typesafe` is status", async () => {
    const bare = collector();
    const explicit = collector();
    const base = repo();
    expect(await configTypesafe([], base, {}, { out: bare.out, env: {} })).toBe(0);
    expect(await configTypesafe(["status"], base, {}, { out: explicit.out, env: {} })).toBe(0);
    expect(bare.lines).toEqual(explicit.lines);
  });

  test("status prints the whole contract in exact order", async () => {
    const root = userRoot();
    const base = repo();
    enable(base);
    // A health record with a call count and a key file, so every optional segment of the
    // contract is exercised for real instead of being assumed.
    writeFileSync(typesafeHealthPath(root), JSON.stringify({ ...HEALTH, calls: 3 }));
    writeFileSync(typesafeEnvPath(root), "TYPESAFE_API_KEY=sk-file\n");
    const { lines, out } = collector();
    const code = await configTypesafe(["status"], base, {}, { out, env: {}, userRoot: root });
    expect(code).toBe(0);
    expect(lines.slice(0, 12)).toEqual([
      "calls: 3/20 last run",
      "enabled: true",
      "key source: ~/.vibeflow/typesafe.env",
      "model: jev-latest",
      "thresholds: run=0.7 accept=0.85",
      "breaker state: idle",
      "breaker: failStreakLimit=2 cooldownBaseMs=60000 cooldownCapMs=900000 hookTimeoutMs=1500",
      "call sites: reviewer=on risk=on goalCoverage=on planner=on",
      "last call: never",
      `health file: ${typesafeHealthPath(root)} (${statSync(typesafeHealthPath(root)).mtime.toISOString()})`,
      `key file: ${typesafeEnvPath(root)} (present 0600)`,
      OPEN_COOLDOWN_LINE(root),
    ]);
    expect(lines.slice(12)).toEqual([...TYPESAFE_EGRESS_LINES]);
  });

  test("status names all four payloads, the endpoint, and the per-site shutoff", async () => {
    const { lines, out } = collector();
    expect(await configTypesafe(["status"], repo(), {}, { out, env: {} })).toBe(0);
    const printed = lines.join("\n");
    for (const snippet of [
      "https://api.typesafe.ai/v1/systemone",
      "the unified diff of your changes + the goal text",
      "the raw shell command, including any secret typed inline in it",
      "the work-unit name and its full spec text",
      "verbatim: not redacted, not truncated",
      "vf config typesafe call-site <name> off",
    ]) {
      expect(printed).toContain(snippet);
    }
    for (const line of TYPESAFE_EGRESS_LINES) expect(printed).toContain(line);
  });

  test("an absent health and key file degrade to `absent`, never to a throw", async () => {
    const root = userRoot();
    const { lines, out } = collector();
    expect(await configTypesafe(["status"], repo(), {}, { out, env: {}, userRoot: root })).toBe(0);
    expect(lines[8]).toBe("last call: never");
    expect(lines[9]).toBe(`health file: ${typesafeHealthPath(root)} (absent)`);
    expect(lines[10]).toBe(`key file: ${typesafeEnvPath(root)} (absent)`);
  });

  test("a malformed health file degrades only `last call`", async () => {
    const root = userRoot();
    writeFileSync(typesafeHealthPath(root), "{ not json");
    const { lines, out } = collector();
    expect(await configTypesafe(["status"], repo(), {}, { out, env: {}, userRoot: root })).toBe(0);
    expect(lines[8]).toBe("last call: never");
    expect(lines[9]).toContain(typesafeHealthPath(root));
    expect(lines[9]).not.toContain("absent");
    expect(lines.slice(12)).toEqual([...TYPESAFE_EGRESS_LINES]);
  });

  test("last call prints a status-less record as status=none", async () => {
    const root = userRoot();
    const at = new Date().toISOString();
    writeFileSync(
      typesafeHealthPath(root),
      JSON.stringify({ ...HEALTH, last_call: { at, caller: "risk", ms: 12 } }),
    );
    const { lines, out } = collector();
    expect(await configTypesafe(["status"], repo(), {}, { out, env: {}, userRoot: root })).toBe(0);
    expect(lines[8]).toBe(`last call: ${at} caller=risk status=none ms=12`);
  });

  test("an enabled install with no key reads `unconfigured`; an env key resolves the key", async () => {
    const base = repo();
    enable(base);
    const noKey = collector();
    expect(await configTypesafe(["status"], base, {}, { out: noKey.out, env: {} })).toBe(0);
    expect(noKey.lines[2]).toBe("key source: none");
    expect(noKey.lines[5]).toBe("breaker state: unconfigured");
    const resolved = collector();
    expect(
      await configTypesafe(
        ["status"],
        base,
        {},
        {
          out: resolved.out,
          env: withKey,
          userRoot: userRoot(),
        },
      ),
    ).toBe(0);
    expect(resolved.lines[2]).toBe("key source: env TYPESAFE_API_KEY");
    expect(resolved.lines[5]).toBe("breaker state: idle");
  });

  test("an open breaker reports the state and the remaining cooldown", async () => {
    const root = userRoot();
    const now = 1_800_000_000_000;
    writeFileSync(
      typesafeHealthPath(root),
      JSON.stringify({
        ...HEALTH,
        state: "open",
        fail_streak: 2,
        consecutive_trips: 1,
        cooldown_ms: 120_000,
        cooldown_until: new Date(now + 95_000).toISOString(),
        last_class: "budget",
        last_status: 429,
      }),
    );
    const base = repo();
    enable(base);
    const { lines, out } = collector();
    expect(
      await configTypesafe(
        ["status"],
        base,
        {},
        { out, env: withKey, userRoot: root, now: () => now },
      ),
    ).toBe(0);
    expect(lines[5]).toBe("breaker state: open (resumes in 01:35)");
  });

  test("an elapsed cooldown clamps the countdown at zero", async () => {
    const root = userRoot();
    const now = 1_800_000_000_000;
    writeFileSync(
      typesafeHealthPath(root),
      JSON.stringify({
        ...HEALTH,
        state: "open",
        fail_streak: 2,
        consecutive_trips: 1,
        cooldown_until: new Date(now - 5_000).toISOString(),
      }),
    );
    const base = repo();
    enable(base);
    const { lines, out } = collector();
    expect(
      await configTypesafe(
        ["status"],
        base,
        {},
        { out, env: withKey, userRoot: root, now: () => now },
      ),
    ).toBe(0);
    expect(lines[5]).toBe("breaker state: open (resumes in 00:00)");
  });

  test("a half-open breaker reports the state and no countdown", async () => {
    const root = userRoot();
    writeFileSync(
      typesafeHealthPath(root),
      JSON.stringify({ ...HEALTH, state: "half-open", fail_streak: 2, consecutive_trips: 1 }),
    );
    const base = repo();
    enable(base);
    const { lines, out } = collector();
    expect(await configTypesafe(["status"], base, {}, { out, env: withKey, userRoot: root })).toBe(
      0,
    );
    expect(lines[5]).toBe("breaker state: half-open");
  });
});

describe("vf config typesafe — toggles", () => {
  test("on enables the block, off disables it, status reflects both", async () => {
    const base = repo();
    expect(await configTypesafe(["on"], base, {}, { out: silence })).toBe(0);
    expect(readSettings(base).typesafe?.enabled).toBe(true);
    expect(await configTypesafe(["off"], base, {}, { out: silence })).toBe(0);
    expect(readSettings(base).typesafe?.enabled).toBe(false);
  });

  test("on keeps the rest of the block and prints the effective thresholds", async () => {
    const base = repo();
    expect(await configTypesafe(["threshold", "run", "0.4"], base, {}, { out: silence })).toBe(0);
    const { lines, out } = collector();
    expect(await configTypesafe(["on"], base, {}, { out })).toBe(0);
    expect(lines[lines.length - 2]).toBe("enabled: true");
    expect(lines[lines.length - 1]).toBe("thresholds: run=0.4 accept=0.85");
    expect(readSettings(base).typesafe?.runAtConfidence).toBe(0.4);
    expect(readSettings(base).typesafe?.acceptAtConfidence).toBe(0.85);
  });

  test("on discloses the egress BEFORE it writes the setting", async () => {
    const base = repo();
    const lines: string[] = [];
    let settingAtFirstNotice: boolean | undefined;
    const code = await configTypesafe(
      ["on"],
      base,
      {},
      {
        out: (s: string) => {
          lines.push(String(s));
          // Snapshot the persisted state the first time the notice appears: it must not be
          // written yet, or the user is being told after the fact.
          if (settingAtFirstNotice === undefined && String(s).includes("api.typesafe.ai")) {
            settingAtFirstNotice = readSettings(base).typesafe?.enabled ?? false;
          }
        },
      },
    );
    expect(code).toBe(0);
    expect(settingAtFirstNotice).toBe(false);
    expect(readSettings(base).typesafe?.enabled).toBe(true);
    const noticeAt = lines.findIndex((l) => l.includes("api.typesafe.ai"));
    const enabledAt = lines.findIndex((l) => l.includes("enabled: true"));
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(noticeAt).toBeLessThan(enabledAt);
  });

  test("off states that nothing is sent", async () => {
    const base = repo();
    const { lines, out } = collector();
    expect(await configTypesafe(["off"], base, {}, { out })).toBe(0);
    expect(lines).toEqual([
      "enabled: false",
      "thresholds: run=0.7 accept=0.85",
      "sends: nothing — all four call sites disabled",
    ]);
  });
});

describe("vf config typesafe — model / threshold / call-site", () => {
  test("model / thresholds / call-site flags round-trip", async () => {
    const base = repo();
    expect(await configTypesafe(["model", "jev-1.13.0"], base, {}, { out: silence })).toBe(0);
    expect(await configTypesafe(["threshold", "run", "0.6"], base, {}, { out: silence })).toBe(0);
    expect(await configTypesafe(["threshold", "accept", "0.9"], base, {}, { out: silence })).toBe(
      0,
    );
    expect(await configTypesafe(["call-site", "planner", "off"], base, {}, { out: silence })).toBe(
      0,
    );
    const s = readSettings(base).typesafe;
    expect(s?.model).toBe("jev-1.13.0");
    expect(s?.runAtConfidence).toBe(0.6);
    expect(s?.acceptAtConfidence).toBe(0.9);
    expect(s?.callSites.planner).toBe(false);
  });

  test("model echoes the id it stored", async () => {
    const { lines, out } = collector();
    expect(await configTypesafe(["model", "jev-1.13.0"], repo(), {}, { out })).toBe(0);
    expect(lines).toEqual(["model: jev-1.13.0"]);
  });

  test("either threshold prints both", async () => {
    const { lines, out } = collector();
    expect(await configTypesafe(["threshold", "accept", "0.5"], repo(), {}, { out })).toBe(0);
    expect(lines).toEqual(["thresholds: run=0.7 accept=0.5"]);
  });

  test("every call-site name round-trips through the frozen authority", async () => {
    for (const name of TYPESAFE_CALL_SITE_NAMES) {
      const base = repo();
      const { lines, out } = collector();
      expect(await configTypesafe(["call-site", name, "off"], base, {}, { out })).toBe(0);
      expect(lines).toEqual([`call site: ${name}=off`]);
      expect(readSettings(base).typesafe?.callSites[name]).toBe(false);
    }
    expect(TYPESAFE_CALL_SITE_NAMES).toEqual(["reviewer", "risk", "goalCoverage", "planner"]);
  });

  test("a call site can be turned back on", async () => {
    const base = repo();
    const { lines, out } = collector();
    expect(await configTypesafe(["call-site", "risk", "off"], base, {}, { out: silence })).toBe(0);
    expect(await configTypesafe(["call-site", "risk", "on"], base, {}, { out })).toBe(0);
    expect(lines).toEqual(["call site: risk=on"]);
    expect(readSettings(base).typesafe?.callSites.risk).toBe(true);
  });

  test("rejects an unknown subcommand and a bad threshold with exit 2", async () => {
    expect(await configTypesafe(["nope"], repo(), {}, { out: silence })).toBe(2);
    expect(await configTypesafe(["threshold", "run", "abc"], repo(), {}, { out: silence })).toBe(2);
    expect(await configTypesafe(["threshold", "nope", "0.5"], repo(), {}, { out: silence })).toBe(
      2,
    );
  });

  test("every rejection prints its usage line and persists nothing", async () => {
    const siteUsage =
      "Usage: vf config typesafe call-site <reviewer|risk|goalCoverage|planner> <on|off>";
    const cases: { args: string[]; usage: string }[] = [
      { args: ["nope"], usage: "Usage: vf config typesafe ..." },
      { args: ["model"], usage: "Usage: vf config typesafe model <id>" },
      { args: ["model", "  "], usage: "Usage: vf config typesafe model <id>" },
      {
        args: ["threshold", "run"],
        usage: "Usage: vf config typesafe threshold <run|accept> <0..1>",
      },
      {
        args: ["threshold", "run", "1.5"],
        usage: "Usage: vf config typesafe threshold <run|accept> <0..1>",
      },
      {
        args: ["threshold", "accept", "Infinity"],
        usage: "Usage: vf config typesafe threshold <run|accept> <0..1>",
      },
      { args: ["call-site", "nope", "on"], usage: siteUsage },
      { args: ["call-site", "risk", "maybe"], usage: siteUsage },
      { args: ["call-site"], usage: siteUsage },
    ];
    for (const { args, usage } of cases) {
      const base = repo();
      const { lines, out } = collector();
      expect(await configTypesafe(args, base, {}, { out })).toBe(2);
      expect(lines).toEqual([usage]);
      expect(readSettings(base).typesafe).toBeUndefined();
    }
  });
});

describe("vf config typesafe — key", () => {
  test("key prompts, writes the env file outside the repo, and never echoes it", async () => {
    const base = repo();
    const root = userRoot();
    const { lines, out } = collector();
    const code = await configTypesafe(
      ["key"],
      base,
      {},
      {
        out,
        userRoot: root,
        ask: async () => "sk-test-123",
      },
    );
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("sk-test-123");
    expect(readSettings(base).typesafe).toBeUndefined();
    expect(readFileSync(typesafeEnvPath(root), "utf8")).toBe("TYPESAFE_API_KEY=sk-test-123\n");
    expect(lines[0]).toBe(`key stored: ${typesafeEnvPath(root)} (0600)`);
    expect(lines[1]).toBe("breaker: idle");
  });

  test("key resets the breaker so a rotated key recovers immediately", async () => {
    const root = userRoot();
    const now = 1_800_000_000_000;
    writeFileSync(
      typesafeHealthPath(root),
      JSON.stringify({
        ...HEALTH,
        state: "open",
        fail_streak: 2,
        consecutive_trips: 3,
        cooldown_ms: 120_000,
        cooldown_until: new Date(now + 60_000).toISOString(),
        last_class: "auth",
      }),
    );
    const { out } = collector();
    expect(
      await configTypesafe(
        ["key"],
        repo(),
        {},
        {
          out,
          userRoot: root,
          now: () => now,
          ask: async () => "sk-rotated",
        },
      ),
    ).toBe(0);
    const written = JSON.parse(readFileSync(typesafeHealthPath(root), "utf8"));
    expect(written.state).toBe("idle");
    expect(written.fail_streak).toBe(0);
    expect(written.consecutive_trips).toBe(0);
  });

  test("an empty key is refused and no file is created", async () => {
    const root = userRoot();
    const { lines, out } = collector();
    const code = await configTypesafe(
      ["key"],
      repo(),
      {},
      {
        out,
        userRoot: root,
        ask: async () => "  ",
      },
    );
    expect(code).toBe(2);
    expect(lines).toEqual(["TypeSafe API key must be provided via hidden stdin"]);
    expect(existsSync(typesafeEnvPath(root))).toBe(false);
  });

  test("a visible --key flag is refused", async () => {
    const root = userRoot();
    const { lines, out } = collector();
    const code = await configTypesafe(["key", "--sk-abc"], repo(), {}, { out, userRoot: root });
    expect(code).toBe(2);
    expect(lines).toEqual([
      "refusing --key (visible in shell history and ps) — pipe the key on stdin instead",
    ]);
    expect(existsSync(typesafeEnvPath(root))).toBe(false);
  });
});

describe("vf config typesafe — reset", () => {
  test("reset clears the breaker and says it is not an uninstall", async () => {
    const root = userRoot();
    const health = typesafeHealthPath(root);
    writeFileSync(
      health,
      JSON.stringify({
        ...HEALTH,
        state: "open",
        fail_streak: 2,
        consecutive_trips: 4,
        cooldown_ms: 300_000,
        last_class: "auth",
      }),
    );
    const { lines, out } = collector();
    expect(await configTypesafe(["reset"], repo(), {}, { out, userRoot: root })).toBe(0);
    expect(lines[0]).toBe("breaker: idle");
    expect(lines[1]).toBe(`health file: ${health} (${statSync(health).mtime.toISOString()})`);
    expect(lines[2]).toBe(
      `note: reset clears the breaker, it does not delete the file — rm -f ${health} ${typesafeEnvPath(root)}`,
    );
    const written = JSON.parse(readFileSync(health, "utf8"));
    expect(written.state).toBe("idle");
    expect(written.cooldown_ms).toBe(60_000);
    expect(existsSync(typesafeEnvPath(root))).toBe(false);
  });
});

describe("vf config typesafe — test", () => {
  test("test subcommand reports 200 + model + latency", async () => {
    const seen: { state?: string; goal?: string; timeoutMs?: number } = {};
    let ticks = 0;
    const lines: string[] = [];
    // The double ASSERTS its arguments through `seen`. An argument-less
    // `async () => ({...})` answers a call the real judge would refuse, which is how the
    // missing `inject.goal` survived: the probe always returned null while the test stayed green.
    const code = await configTypesafe(
      ["test"],
      repo(),
      {},
      {
        out: (s: string) => void lines.push(String(s)),
        env: withKey,
        userRoot: userRoot(),
        now: () => {
          ticks += 42;
          return 1_800_000_000_000 + ticks;
        },
        judge: async (state: string, inject?: JudgeInject) => {
          seen.state = state;
          // The probe MUST pass both: a bare state string always yields null in production.
          expect(inject?.goal).toBe("the change adds a compute-confidence function");
          expect(Number.isFinite(inject?.timeoutMs)).toBe(true);
          seen.goal = inject?.goal;
          seen.timeoutMs = inject?.timeoutMs;
          return { covers: { score: 0.9, confidence: 0.8 }, tests: { noul: 0.9 } };
        },
      },
    );
    expect(code).toBe(0);
    expect(seen.goal).toBe("the change adds a compute-confidence function");
    expect(seen.state).toContain("computeConfidence");
    expect(seen.timeoutMs).toBe(3000);
    expect(lines).toEqual([
      "HTTP 200 · model jev-latest · 42ms",
      "covers_goal = 0.9 (confidence 0.8)",
      "breaker: idle",
    ]);
  });

  test("a score with no confidence prints it as unknown", async () => {
    const { lines, out } = collector();
    expect(
      await configTypesafe(
        ["test"],
        repo(),
        {},
        {
          out,
          env: withKey,
          userRoot: userRoot(),
          judge: async () => ({ covers: { score: 2 } }),
        },
      ),
    ).toBe(0);
    expect(lines[1]).toBe("covers_goal = 2 (confidence unknown)");
  });

  test("a null judge fails open with the key/quota diagnosis", async () => {
    const { lines, out } = collector();
    expect(
      await configTypesafe(
        ["test"],
        repo(),
        {},
        {
          out,
          env: withKey,
          userRoot: userRoot(),
          judge: async () => null,
        },
      ),
    ).toBe(1);
    expect(lines).toEqual(["TypeSafe: request failed — check key/quota"]);
  });

  test("an unconfigured outcome is diagnosed as a missing key, exit 2", async () => {
    const { lines, out } = collector();
    expect(
      await configTypesafe(
        ["test"],
        repo(),
        {},
        {
          out,
          env: {},
          userRoot: userRoot(),
          judge: async (_state: string, inject?: JudgeInject) => {
            inject?.onOutcome?.({ ok: false, class: "unconfigured" }, 1);
            return null;
          },
        },
      ),
    ).toBe(2);
    expect(lines).toEqual(["TypeSafe: no key configured"]);
  });

  test("with no injected judge the REAL client loads lazily and no key means no HTTP", async () => {
    const base = repo();
    enable(base);
    const original = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      throw new Error("the probe must not reach the wire without a key");
    }) as unknown as typeof fetch;
    const { lines, out } = collector();
    try {
      // No `judge` double: this exercises the dynamic import of the one socket-owning
      // module, and the client's own `unconfigured` refusal short-circuits before fetch.
      const code = await configTypesafe(
        ["test"],
        base,
        {},
        {
          out,
          env: {},
          userRoot: userRoot(),
        },
      );
      expect(code).toBe(2);
      expect(lines).toEqual(["TypeSafe: no key configured"]);
      expect(fetched).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("vf config typesafe — hidden prompt", () => {
  test("reads one line from a non-TTY stream", async () => {
    const input = new PassThrough();
    input.end("sk-from-pipe\n");
    expect(await promptHidden("key: ", { input: input as never })).toBe("sk-from-pipe");
  });

  test("mutes the echo on a TTY stream", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    const written: string[] = [];
    const output = new PassThrough();
    output.on("data", (c: Buffer) => written.push(c.toString()));
    const asked = promptHidden("key: ", { input: input as never, output: output as never });
    input.write("sk-tty\n");
    expect(await asked).toBe("sk-tty");
    expect(written.join("")).not.toContain("sk-tty");
    expect(written.join("")).toContain("key: ");
  });
});

describe("vf config typesafe — real dispatcher", () => {
  const runCli = (args: string[], cwdDir: string, userRootDir: string) => {
    const r = cpSpawnSync("bun", ["run", join(import.meta.dir, "../src/cli.ts"), ...args], {
      cwd: cwdDir,
      env: {
        ...process.env,
        NO_COLOR: "1",
        VF_USER_VIBEFLOW_ROOT: userRootDir,
        TYPESAFE_API_KEY: "",
      },
    });
    const text = (b: string | Uint8Array) =>
      typeof b === "string" ? b : new TextDecoder().decode(b);
    return { code: r.status, stdout: text(r.stdout), stderr: text(r.stderr) };
  };

  test("`vf config typesafe status` reaches the module through cli.ts", () => {
    const root = userRoot();
    const r = runCli(["config", "typesafe", "status"], repo(), root);
    expect(r.code).toBe(0);
    const printed = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(printed.slice(0, 12)).toEqual([
      "calls: 0/20 last run",
      "enabled: false",
      "key source: none",
      "model: jev-latest",
      "thresholds: run=0.7 accept=0.85",
      "breaker state: off",
      "breaker: failStreakLimit=2 cooldownBaseMs=60000 cooldownCapMs=900000 hookTimeoutMs=1500",
      "call sites: reviewer=on risk=on goalCoverage=on planner=on",
      "last call: never",
      `health file: ${typesafeHealthPath(root)} (absent)`,
      `key file: ${typesafeEnvPath(root)} (absent)`,
      `remove both: rm -f ${typesafeHealthPath(root)} ${typesafeEnvPath(root)}`,
    ]);
    expect(printed.slice(12)).toEqual([...TYPESAFE_EGRESS_LINES]);
  });

  test("an unknown subcommand exits 2 through the dispatcher", () => {
    const r = runCli(["config", "typesafe", "nope"], repo(), userRoot());
    expect(r.code).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain("Usage: vf config typesafe ...");
  });
});

describe("the CLI's own writes satisfy the repo-identity rule", () => {
  test("`on` goes through the REAL writeSettings, not an injected one", async () => {
    // Every other test in this file injects `writeSettings`. `writeSettings` refuses a System One
    // write that does not name its target repo, so a missing `expectRepo` in config-typesafe.ts
    // would not show up in any of them - it would surface as a thrown `vf config typesafe on`
    // for a real user. This test takes the real path, so it fails if that name is dropped.
    const base = repo();
    const lines: string[] = [];
    const code = await configTypesafe(
      ["on"],
      base,
      {},
      {
        out: (m: string) => lines.push(m),
        env: { TYPESAFE_API_KEY: "not-a-real-key" },
      },
    );
    expect(code).toBe(0);
    expect(readSettings(base).typesafe?.enabled).toBe(true);
  });
});
