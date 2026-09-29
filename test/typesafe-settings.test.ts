import { describe, expect, test } from "bun:test";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
// The same cross-platform privacy question the implementation asks: mode bits on POSIX, the
// DACL on Windows. Importing it here is what makes the assertion meaningful on both platforms.
import { hasPrivateMode } from "../src/durability/posix-fs-semantics.js";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "../src/settings.js";
import type { VibeSettings } from "../src/settings.js";
import {
  DEFAULT_TYPESAFE_SETTINGS,
  HOOK_BUS_LOCK_RETRIES_MAX,
  HOOK_BUS_LOCK_RETRY_MS,
  HOOK_HEALTH_WRITE_BUDGET_MS,
  HOOK_SAFETY_MARGIN_MS,
  HOOK_SPAWN_BUDGET_MS,
  HOOK_STDIN_BUDGET_MS,
  HOOK_TIMEOUT_CAP_MS,
  TYPESAFE_CALL_SITE_NAMES,
  type TypesafeSettings,
  applyTypesafeSettings,
  coerceTypesafeSettings,
  isTypesafeConfigured,
  isTypesafeEnabled,
  mergeTypesafeSettings,
  resolveTypesafeKey,
  typesafeEnvPath,
  writeTypesafeEnv,
} from "../src/typesafe-settings.js";

const noKey = { env: {} as NodeJS.ProcessEnv, userRoot: mkdtempSync(join(tmpdir(), "vf-ts-")) };

describe("coerceTypesafeSettings", () => {
  test("absent/garbage yields undefined so the block stays out of SETTINGS.json", () => {
    expect(coerceTypesafeSettings(undefined)).toBeUndefined();
    expect(coerceTypesafeSettings("nope")).toBeUndefined();
    expect(coerceTypesafeSettings([])).toBeUndefined();
  });

  test("partial block merges over defaults and clamps the range fields", () => {
    const s = coerceTypesafeSettings({ enabled: true, runAtConfidence: -3, acceptAtConfidence: 9 });
    expect(s).toEqual({
      ...DEFAULT_TYPESAFE_SETTINGS,
      enabled: true,
      runAtConfidence: 0,
      acceptAtConfidence: 1,
    });
  });

  test("call sites coerce per key and keep defaults for unknown keys", () => {
    const s = coerceTypesafeSettings({ enabled: true, callSites: { planner: false } });
    expect(s?.callSites).toEqual({
      reviewer: true,
      risk: true,
      goalCoverage: true,
      planner: false,
    });
  });

  test("timeoutMs is clamped to the 500..10000 window", () => {
    expect(coerceTypesafeSettings({ enabled: true, timeoutMs: 1 })?.timeoutMs).toBe(500);
    expect(coerceTypesafeSettings({ enabled: true, timeoutMs: 10 ** 9 })?.timeoutMs).toBe(10_000);
  });

  test("hookTimeoutMs is clamped to the hard cap AND to the global timeout", () => {
    expect(coerceTypesafeSettings({ enabled: true, hookTimeoutMs: 1 })?.hookTimeoutMs).toBe(250);
    // The hard cap binds even when BOTH values are legal members of the 500..10000 window —
    // this is the configuration that would otherwise let the judge eat the hook spawn budget.
    const maxed = coerceTypesafeSettings({
      enabled: true,
      timeoutMs: 10_000,
      hookTimeoutMs: 10_000,
    });
    expect(maxed?.hookTimeoutMs).toBe(HOOK_TIMEOUT_CAP_MS);
    expect(maxed?.timeoutMs).toBe(10_000);
    // A session-wide timeoutMs raise must NOT unbound the tool gate.
    expect(coerceTypesafeSettings({ enabled: true, hookTimeoutMs: 60_000 })?.hookTimeoutMs).toBe(
      HOOK_TIMEOUT_CAP_MS,
    );
    // A LOWERED session budget still wins over the cap — both ceilings apply.
    const s = coerceTypesafeSettings({ enabled: true, timeoutMs: 500, hookTimeoutMs: 9000 });
    expect(s?.hookTimeoutMs).toBe(500);
    // The invariant the hook path depends on, asserted as an invariant and not a constant.
    for (const t of [500, 1000, 3000, 10_000]) {
      for (const h of [250, 1500, 9000, 10_000]) {
        const c = coerceTypesafeSettings({ enabled: true, timeoutMs: t, hookTimeoutMs: h });
        expect(c?.hookTimeoutMs).toBeLessThanOrEqual(c?.timeoutMs ?? 0);
        expect(c?.hookTimeoutMs).toBeLessThanOrEqual(HOOK_TIMEOUT_CAP_MS);
      }
    }
  });

  test("hookBusLockRetries is a settings field, not a literal: default 0, clamped to the residual budget", () => {
    // C05: the audit leg's lock-retry budget is behaviour-controlling, so it MUST be reachable
    // from settings rather than hardcoded in src/commands/hooks.ts. 0 is the fail-fast default.
    // The ceiling is the RESIDUAL spawn budget after the other four legs, NOT the repo-wide
    // logbus policy: reusing `ceil(5000/50) = 100` would let a settings file alone put the
    // five-leg sum at 17 000 ms (the audit leg is DOUBLED - see the worst-case test below), past
    // the 10 s `spawnSync` kill budget.
    expect(DEFAULT_TYPESAFE_SETTINGS.hookBusLockRetries).toBe(0);
    expect(coerceTypesafeSettings({ enabled: true })?.hookBusLockRetries).toBe(0);
    expect(
      coerceTypesafeSettings({ enabled: true, hookBusLockRetries: 3 })?.hookBusLockRetries,
    ).toBe(3);
    expect(
      coerceTypesafeSettings({ enabled: true, hookBusLockRetries: -1 })?.hookBusLockRetries,
    ).toBe(0);
    expect(
      coerceTypesafeSettings({ enabled: true, hookBusLockRetries: 5000 })?.hookBusLockRetries,
    ).toBe(HOOK_BUS_LOCK_RETRIES_MAX);
  });

  test("the enabled hook path's five legs sum strictly below the spawn budget at their MAXIMA", () => {
    // The pass rule is arithmetic, not prose. Every leg is bounded by one of these exported
    // values, and the worst case (every leg at its ceiling) MUST leave the spawn budget unspent -
    // otherwise a fail-open judge turns the host's kill into `{ decision: "block" }`.
    const worstCase =
      HOOK_STDIN_BUDGET_MS + // stdin drain (src/commands/hooks.ts:128)
      HOOK_TIMEOUT_CAP_MS + // judge HTTP incl. its one retry, one shared deadline
      0 + // breaker lock wait: `lockWaitMs: 0` on the hook path
      HOOK_HEALTH_WRITE_BUDGET_MS + // breaker health write (seam-passed reservation)
      2 * HOOK_BUS_LOCK_RETRIES_MAX * HOOK_BUS_LOCK_RETRY_MS; // audit bus lock wait (DOUBLED acquisition)
    const maxed = coerceTypesafeSettings({
      enabled: true,
      timeoutMs: 10_000,
      hookTimeoutMs: 10_000,
    });
    // `hookTimeoutMs` really does clamp to the cap, so the second term above is reachable.
    expect(maxed?.hookTimeoutMs).toBe(HOOK_TIMEOUT_CAP_MS);
    expect(worstCase + HOOK_SAFETY_MARGIN_MS).toBeLessThanOrEqual(HOOK_SPAWN_BUDGET_MS);
    expect(worstCase).toBeLessThan(HOOK_SPAWN_BUDGET_MS);
    // The residual derivation: no legal `hookBusLockRetries` can widen the sum. The divisor is
    // `2 x` because the audit leg can acquire the lock TWICE (writeLocked -> ENOENT ->
    // recoverAndRelock re-locks, src/logbus.ts:112/:119/:182); a single-acquisition `40` would
    // put the sum at 11 000 ms and this test would be the thing that catches it.
    expect(HOOK_BUS_LOCK_RETRIES_MAX).toBe(
      Math.floor(
        (HOOK_SPAWN_BUDGET_MS -
          HOOK_STDIN_BUDGET_MS -
          HOOK_TIMEOUT_CAP_MS -
          HOOK_HEALTH_WRITE_BUDGET_MS -
          HOOK_SAFETY_MARGIN_MS) /
          (2 * HOOK_BUS_LOCK_RETRY_MS),
      ),
    );
    // and the multiplicity is EXPLICIT here, so a future edit that drops the `2 *` from the sum
    // fails on arithmetic rather than passing on a smaller number.
    expect(worstCase).toBe(
      HOOK_STDIN_BUDGET_MS +
        HOOK_TIMEOUT_CAP_MS +
        0 +
        HOOK_HEALTH_WRITE_BUDGET_MS +
        2 * HOOK_BUS_LOCK_RETRIES_MAX * HOOK_BUS_LOCK_RETRY_MS,
    );
  });

  test("cooldownCapMs can never fall below cooldownBaseMs", () => {
    const s = coerceTypesafeSettings({
      enabled: true,
      cooldownBaseMs: 120_000,
      cooldownCapMs: 1000,
    });
    expect(s?.cooldownCapMs).toBe(120_000);
  });

  test("an unknown reviewerEngine policy keeps the default instead of guessing", () => {
    expect(
      coerceTypesafeSettings({ enabled: true, reviewerEngine: "random" })?.reviewerEngine,
    ).toBe("unit");
    expect(
      coerceTypesafeSettings({ enabled: true, reviewerEngine: "global" })?.reviewerEngine,
    ).toBe("global");
  });

  test("maxCalls is clamped so a 0 cannot silently disable an enabled feature", () => {
    expect(coerceTypesafeSettings({ enabled: true, maxCalls: 0 })?.maxCalls).toBe(1);
    expect(coerceTypesafeSettings({ enabled: true, maxCalls: 999 })?.maxCalls).toBe(100);
    expect(coerceTypesafeSettings({ enabled: true })?.maxCalls).toBe(
      DEFAULT_TYPESAFE_SETTINGS.maxCalls,
    );
  });

  test("failStreakLimit is clamped so a 0 can never trip on the first failure silently", () => {
    expect(coerceTypesafeSettings({ enabled: true, failStreakLimit: 0 })?.failStreakLimit).toBe(1);
    expect(coerceTypesafeSettings({ enabled: true, failStreakLimit: 99 })?.failStreakLimit).toBe(
      10,
    );
  });

  test("every call site in the frozen authority is coercible (no site silently unwritable)", () => {
    const s = coerceTypesafeSettings({
      enabled: true,
      callSites: { reviewer: false, risk: false, goalCoverage: false, planner: false },
    });
    for (const name of TYPESAFE_CALL_SITE_NAMES) {
      expect(s?.callSites[name]).toBe(false);
    }
    // An unknown site name is dropped, not added.
    const t = coerceTypesafeSettings({ enabled: true, callSites: { bogus: false } });
    expect(Object.keys(t?.callSites ?? {}).sort()).toEqual([...TYPESAFE_CALL_SITE_NAMES].sort());
  });

  test("judge grade numbers clamp into their own windows", () => {
    expect(coerceTypesafeSettings({ enabled: true, judgeScoreLevels: 0 })?.judgeScoreLevels).toBe(
      1,
    );
    expect(coerceTypesafeSettings({ enabled: true, judgeScoreLevels: 99 })?.judgeScoreLevels).toBe(
      10,
    );
    // `judgePassLevel` is bounded by the coerced level count, not by a restated constant.
    const s = coerceTypesafeSettings({ enabled: true, judgeScoreLevels: 2, judgePassLevel: 9 });
    expect(s?.judgePassLevel).toBe(2);
    expect(coerceTypesafeSettings({ enabled: true, judgePassLevel: -1 })?.judgePassLevel).toBe(0);
    expect(coerceTypesafeSettings({ enabled: true, judgeTestFloor: 5 })?.judgeTestFloor).toBe(1);
    expect(coerceTypesafeSettings({ enabled: true, judgeTestFloor: -2 })?.judgeTestFloor).toBe(0);
  });

  test("model is trimmed and a blank model keeps the default", () => {
    expect(coerceTypesafeSettings({ enabled: true, model: "  jev-1.13.0  " })?.model).toBe(
      "jev-1.13.0",
    );
    expect(coerceTypesafeSettings({ enabled: true, model: "   " })?.model).toBe(
      DEFAULT_TYPESAFE_SETTINGS.model,
    );
    expect(coerceTypesafeSettings({ enabled: true, model: 7 })?.model).toBe(
      DEFAULT_TYPESAFE_SETTINGS.model,
    );
  });

  test("retryBackoffMs and the cooldown window round to integers inside their bounds", () => {
    expect(coerceTypesafeSettings({ enabled: true, retryBackoffMs: -5 })?.retryBackoffMs).toBe(0);
    expect(coerceTypesafeSettings({ enabled: true, retryBackoffMs: 99.6 })?.retryBackoffMs).toBe(
      100,
    );
    expect(coerceTypesafeSettings({ enabled: true, retryBackoffMs: 10 ** 9 })?.retryBackoffMs).toBe(
      10_000,
    );
    expect(coerceTypesafeSettings({ enabled: true, cooldownBaseMs: 1 })?.cooldownBaseMs).toBe(1000);
    expect(coerceTypesafeSettings({ enabled: true, cooldownBaseMs: 10 ** 9 })?.cooldownBaseMs).toBe(
      3_600_000,
    );
    expect(coerceTypesafeSettings({ enabled: true, cooldownCapMs: 10 ** 9 })?.cooldownCapMs).toBe(
      24 * 3_600_000,
    );
  });

  test("a non-boolean, non-finite or non-numeric field is ignored, keeping the default", () => {
    const s = coerceTypesafeSettings({
      enabled: "yes",
      timeoutMs: Number.NaN,
      runAtConfidence: "0.5",
      acceptAtConfidence: Number.POSITIVE_INFINITY,
      retryBackoffMs: "250",
      judgeScoreLevels: Number.NaN,
      judgePassLevel: "2",
      judgeTestFloor: Number.NaN,
      reviewerEngine: 3,
      failStreakLimit: Number.NaN,
      maxCalls: "20",
      cooldownBaseMs: Number.NaN,
      cooldownCapMs: Number.NaN,
      hookTimeoutMs: Number.NaN,
      hookBusLockRetries: Number.NaN,
      callSites: { reviewer: "no", risk: 1 },
    });
    expect(s).toEqual(DEFAULT_TYPESAFE_SETTINGS);
    expect(s?.callSites).toEqual(DEFAULT_TYPESAFE_SETTINGS.callSites);
  });

  test("a garbage callSites value leaves every site at its default", () => {
    expect(coerceTypesafeSettings({ enabled: true, callSites: "risk" })?.callSites).toEqual(
      DEFAULT_TYPESAFE_SETTINGS.callSites,
    );
    expect(coerceTypesafeSettings({ enabled: true, callSites: ["risk"] })?.callSites).toEqual(
      DEFAULT_TYPESAFE_SETTINGS.callSites,
    );
  });
});

describe("resolveTypesafeKey", () => {
  test("env wins over the file", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    writeFileSync(typesafeEnvPath(root), "TYPESAFE_API_KEY=from-file\n");
    const r = resolveTypesafeKey({ env: { TYPESAFE_API_KEY: "from-env" }, userRoot: root });
    expect(r).toEqual({ key: "from-env", source: "env" });
  });

  test("falls back to ~/.vibeflow/typesafe.env, trimming comments and whitespace", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    writeFileSync(typesafeEnvPath(root), "# comment\nTYPESAFE_API_KEY=  spaced-key  \n");
    expect(resolveTypesafeKey({ env: {}, userRoot: root })).toEqual({
      key: "spaced-key",
      source: "file",
    });
  });

  test("null when neither source has a non-empty key", () => {
    expect(
      resolveTypesafeKey({ env: {}, userRoot: mkdtempSync(join(tmpdir(), "vf-ts-")) }),
    ).toBeNull();
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    writeFileSync(typesafeEnvPath(root), "OTHER=1\n");
    expect(resolveTypesafeKey({ env: {}, userRoot: root })).toBeNull();
  });

  test("a blank env value falls through to the file rather than resolving to an empty key", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    writeFileSync(typesafeEnvPath(root), "TYPESAFE_API_KEY=from-file\n");
    expect(resolveTypesafeKey({ env: { TYPESAFE_API_KEY: "   " }, userRoot: root })).toEqual({
      key: "from-file",
      source: "file",
    });
  });

  test("a file line without `=` or with an empty value never resolves a key", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    writeFileSync(typesafeEnvPath(root), "JUST_A_NAME\nTYPESAFE_API_KEY=\n");
    expect(resolveTypesafeKey({ env: {}, userRoot: root })).toBeNull();
  });

  test("an unreadable file is treated as absent, never a throw", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    expect(
      resolveTypesafeKey({
        env: {},
        userRoot: root,
        readFile: () => {
          throw new Error("EACCES");
        },
      }),
    ).toBeNull();
  });

  test("defaults to the process env and the real per-user root when nothing is injected", () => {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "from-process-env";
    try {
      expect(
        resolveTypesafeKey({ env: process.env, userRoot: mkdtempSync(join(tmpdir(), "vf-ts-")) }),
      ).toEqual({
        key: "from-process-env",
        source: "env",
      });
      // No `env` injection at all: the live process env is the source, and the path is the
      // per-user vibeflow root every other artifact uses (`VF_USER_VIBEFLOW_ROOT` when set,
      // else `~/.vibeflow`).
      expect(typesafeEnvPath()).toBe(
        typesafeEnvPath(process.env.VF_USER_VIBEFLOW_ROOT ?? join(homedir(), ".vibeflow")),
      );
    } finally {
      // Restore EXACTLY: a bare `= previous ?? ""` CREATES the variable as an empty string when it
      // was never set, which is a different process state. `""` is not `undefined`, so downstream
      // code using `env.X ?? fallback` stops falling back, and any assertion of the form
      // `not.toContain(env.X ?? "literal")` becomes vacuously true-against-everything (every string
      // contains ""). Delete the key instead of materialising it.
      // `Reflect.deleteProperty` is the lint-clean form of the same removal: assigning
      // `undefined` would stringify to "undefined" and defeat the point of the restore.
      if (previous === undefined) Reflect.deleteProperty(process.env, "TYPESAFE_API_KEY");
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });
});

describe("writeTypesafeEnv", () => {
  test("writes one key line and the file is owner-only on BOTH platforms", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    const p = writeTypesafeEnv("secret-value", { userRoot: root });
    expect(p).toBe(typesafeEnvPath(root));
    // `userRoot` IS the per-user vibeflow root (`~/.vibeflow`), so the key lands directly
    // inside it and `dirname(path)` is the directory ensurePrivateDirectory owns.
    expect(p).toBe(join(root, "typesafe.env"));
    // Ask the same question on every platform: mode bits on POSIX, the DACL on Windows. Skipping
    // this on win32 is what let the branch below rot - it referenced a binding that does not exist
    // in this scope and no CI job ever ran it.
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      expect(hasPrivateMode(fstatSync(fd), 0o777, 0o600, p, fd)).toBe(true);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(p, "utf8")).toBe("TYPESAFE_API_KEY=secret-value\n");
    expect(resolveTypesafeKey({ env: {}, userRoot: root })?.key).toBe("secret-value");
  });

  test("a pre-existing symlink at the key path is not followed", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    const decoy = join(root, "decoy.txt");
    writeFileSync(decoy, "untouched\n");
    const path = typesafeEnvPath(root);
    symlinkSync(decoy, path);
    // O_EXCL on the staging file plus a rename over the leaf: the decoy keeps its own bytes and
    // the key lands at `path` as a regular file, never at the symlink target.
    writeTypesafeEnv("secret-value", { userRoot: root });
    expect(readFileSync(decoy, "utf8")).toBe("untouched\n");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
  });

  test("a directory that cannot be made private is a hard error", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    // Simulate a hostile ~/.vibeflow: a FILE where the directory must go. ensurePrivateDirectory
    // cannot open it as a directory, so the write must throw rather than fall back to a
    // world-readable location.
    const hostile = join(root, "vibeflow");
    writeFileSync(hostile, "not a directory");
    expect(() => writeTypesafeEnv("secret-value", { userRoot: hostile })).toThrow();
  });

  test("a leaf that cannot be replaced is a hard error and leaves no staged file behind", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    // A DIRECTORY at the key leaf: the staged file can be written but never renamed over it.
    mkdirSync(typesafeEnvPath(root));
    expect(() => writeTypesafeEnv("secret-value", { userRoot: root })).toThrow();
    const staged = readdirSync(root).filter((n) => n.endsWith(".tmp"));
    expect(staged).toEqual([]);
  });

  test("a leaf that ends up not owner-only is refused and the key is not left on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-ts-"));
    expect(() =>
      writeTypesafeEnv("secret-value", { userRoot: root, verifyPrivate: () => false }),
    ).toThrow(/not owner-only/);
    expect(existsSync(typesafeEnvPath(root))).toBe(false);
  });

  test("defaults to the per-user root when no root is injected", () => {
    // The no-injection path resolves `~/.vibeflow/typesafe.env`; assert the resolution instead
    // of writing the caller's real home.
    expect(typesafeEnvPath(undefined)).toBe(typesafeEnvPath());
  });
});

describe("isTypesafeEnabled / isTypesafeConfigured", () => {
  test("enabled needs the block; configured also needs a key", () => {
    expect(isTypesafeEnabled(DEFAULT_SETTINGS)).toBe(false);
    const on = { ...DEFAULT_SETTINGS, typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: true } };
    expect(isTypesafeEnabled(on)).toBe(true);
    expect(
      isTypesafeConfigured({ ...on, typesafe: { ...on.typesafe, enabled: false } }, noKey),
    ).toBe(false);
    expect(isTypesafeConfigured(on, { ...noKey, env: { TYPESAFE_API_KEY: "k" } })).toBe(true);
  });

  test("a non-boolean enabled value is never treated as on", () => {
    const hacked = {
      ...DEFAULT_SETTINGS,
      typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: "true" as unknown as boolean },
    };
    expect(isTypesafeEnabled(hacked)).toBe(false);
  });

  test("isTypesafeConfigured with no injection resolves against the live env and root", () => {
    const on = { ...DEFAULT_SETTINGS, typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: true } };
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "live";
    try {
      expect(isTypesafeConfigured(on)).toBe(true);
    } finally {
      // Restore EXACTLY: a bare `= previous ?? ""` CREATES the variable as an empty string when it
      // was never set, which is a different process state. `""` is not `undefined`, so downstream
      // code using `env.X ?? fallback` stops falling back, and any assertion of the form
      // `not.toContain(env.X ?? "literal")` becomes vacuously true-against-everything (every string
      // contains ""). Delete the key instead of materialising it.
      // `Reflect.deleteProperty` is the lint-clean form of the same removal: assigning
      // `undefined` would stringify to "undefined" and defeat the point of the restore.
      if (previous === undefined) Reflect.deleteProperty(process.env, "TYPESAFE_API_KEY");
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });
});

describe("applyTypesafeSettings / mergeTypesafeSettings", () => {
  test("apply materializes a good block and leaves the field absent for garbage", () => {
    const out: VibeSettings = { ...DEFAULT_SETTINGS };
    applyTypesafeSettings(out, { enabled: true, model: "jev-1.13.0" });
    expect(out.typesafe?.enabled).toBe(true);
    expect(out.typesafe?.model).toBe("jev-1.13.0");

    const bad: VibeSettings = { ...DEFAULT_SETTINGS };
    applyTypesafeSettings(bad, "garbage");
    expect(bad.typesafe).toBeUndefined();
  });

  test("merge is replace-on-write and keeps the prior block when `next` omits it", () => {
    const current: VibeSettings = {
      ...DEFAULT_SETTINGS,
      typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: true, model: "jev-1.13.0" },
    };
    // A present block still replaces the block object, but a payload that names only SOME fields
    // keeps the stored values of the rest. It used to start from the shipped defaults, so naming
    // `enabled` alone silently reset the model, the thresholds and the call-site toggles - the
    // same class of silent loss, from the other direction.
    const replaced: VibeSettings = { ...DEFAULT_SETTINGS };
    mergeTypesafeSettings(replaced, { typesafe: { enabled: false } as never }, current);
    expect(replaced.typesafe?.enabled).toBe(false);
    expect(replaced.typesafe?.model).toBe("jev-1.13.0");

    const kept: VibeSettings = { ...DEFAULT_SETTINGS };
    mergeTypesafeSettings(kept, { memory: false } as never, current);
    expect(kept.typesafe?.enabled).toBe(true);
    expect(kept.typesafe?.model).toBe("jev-1.13.0");

    // A garbage handed block never materializes the field, mirroring the curator precedent.
    const dropped: VibeSettings = { ...DEFAULT_SETTINGS };
    mergeTypesafeSettings(dropped, { typesafe: "garbage" as never }, current);
    expect(dropped.typesafe).toBeUndefined();
  });
});

describe("settings round-trip", () => {
  test("writeSettings persists the typesafe block and readSettings returns it", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ts-repo-"));
    writeSettings(dir, {
      expectRepo: dir,
      typesafe: { ...DEFAULT_TYPESAFE_SETTINGS, enabled: true, model: "jev-1.13.0" },
    });
    const back = readSettings(dir);
    expect(back.typesafe?.enabled).toBe(true);
    expect(back.typesafe?.model).toBe("jev-1.13.0");
  });

  test("omitting the block leaves it absent (no key materialized)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ts-repo-"));
    writeSettings(dir, { memory: false });
    expect(readSettings(dir).typesafe).toBeUndefined();
  });
});

describe("a partial System One write updates only what it names", () => {
  test("unsent fields survive instead of reverting to the shipped defaults", () => {
    // Starting the coercion from the defaults made a partial write a silent reset: naming only
    // `model` turned the judge back OFF and relaxed every tightened threshold and call-site toggle,
    // and the response said the save succeeded.
    const stored = {
      ...DEFAULT_TYPESAFE_SETTINGS,
      enabled: true,
      runAtConfidence: 0.95,
      maxCalls: 7,
      callSites: { ...DEFAULT_TYPESAFE_SETTINGS.callSites, risk: true },
    };
    const merged: { typesafe?: TypesafeSettings } = {};
    mergeTypesafeSettings(merged, { typesafe: { model: "jev-1.13.0" } } as never, {
      typesafe: stored,
    });
    expect(merged.typesafe?.model).toBe("jev-1.13.0");
    expect(merged.typesafe?.enabled).toBe(true);
    expect(merged.typesafe?.runAtConfidence).toBe(0.95);
    expect(merged.typesafe?.maxCalls).toBe(7);
    expect(merged.typesafe?.callSites.risk).toBe(true);
  });

  test("a first write still starts from the shipped defaults", () => {
    const merged: { typesafe?: TypesafeSettings } = {};
    mergeTypesafeSettings(merged, { typesafe: { enabled: true } } as never, {});
    expect(merged.typesafe?.enabled).toBe(true);
    expect(merged.typesafe?.acceptAtConfidence).toBe(DEFAULT_TYPESAFE_SETTINGS.acceptAtConfidence);
  });
});

describe("the key file boundary", () => {
  test("a symlinked typesafe.env is refused, not read as the bearer key", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-typesafe-symlink-"));
    try {
      // `userRoot` IS the per-user directory (see `userVibeflowDir`), so the key path is
      // `<root>/typesafe.env` - not `<root>/.vibeflow/...`.
      const dir = root;
      const elsewhere = join(root, "elsewhere.env");
      writeFileSync(elsewhere, "TYPESAFE_API_KEY=content-of-another-file\n", { mode: 0o600 });
      try {
        symlinkSync(elsewhere, join(dir, "typesafe.env"));
      } catch {
        return; // a platform without symlink permission cannot express the attack
      }
      // `existsSync` follows the link, so the file exists and is readable - which is exactly why the
      // resolver has to refuse a leaf that is not a regular file. Any file's content would otherwise
      // become the bearer key sent to the endpoint.
      expect(existsSync(join(dir, "typesafe.env"))).toBe(true);
      expect(resolveTypesafeKey({ userRoot: root, env: {} })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failure after the key is staged does not leave it on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-typesafe-stage-"));
    try {
      expect(() =>
        writeTypesafeEnv("sk-live-value", {
          userRoot: root,
          fsync: () => {
            throw new Error("fsync failed");
          },
        }),
      ).toThrow("fsync failed");
      // The staged file holds the literal key and no reader ever looks at that name.
      const leftovers = readdirSync(root).filter((f) => f.includes("typesafe.env"));
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
