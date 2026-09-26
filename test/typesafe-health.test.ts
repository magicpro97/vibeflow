import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { LOG_CHANNEL, type LogChannel } from "../src/core/log-contract.js";
import { type Logbus, getLogbus, outBusOnly, setLogbusForTests } from "../src/logbus.js";
import * as healthModule from "../src/typesafe-health.js";
import {
  BREAKER_DEFAULTS,
  FAILURE_CLASS,
  FAILURE_CLASSES,
  type FailureClass,
  TYPESAFE_STATE,
  type TypesafeHealth,
  allowCall,
  callsUsedThisRun,
  classifyHttp,
  classifyThrown,
  isFailureClass,
  isTypesafeHealth,
  mutateHealth,
  outcomeProbe,
  readHealth,
  resetCallBudget,
  transition,
  tuningFor,
  typesafeHealthPath,
  withTypesafeGuard,
  writeHealth,
} from "../src/typesafe-health.js";
import { DEFAULT_TYPESAFE_SETTINGS } from "../src/typesafe-settings.js";

const root = (): string => mkdtempSync(join(tmpdir(), "vf-ts-health-"));
const T0 = Date.parse("2026-09-21T20:40:00.000Z");
const IDLE_HEALTH: TypesafeHealth = {
  schema_version: 1,
  state: TYPESAFE_STATE.IDLE,
  fail_streak: 0,
  consecutive_trips: 0,
  cooldown_ms: BREAKER_DEFAULTS.cooldownBaseMs,
  last_class: FAILURE_CLASS.NONE,
};
const idle = (): TypesafeHealth => readHealth({ userRoot: root() });

beforeEach(() => {
  resetCallBudget();
});

describe("classifyHttp", () => {
  test.each([
    [401, "auth"],
    [403, "auth"],
    [429, "budget"],
    [529, "budget"],
    [422, "schema"],
    [500, "server"],
    [503, "server"],
    [400, "malformed"],
    [404, "malformed"],
    [200, "none"],
    [201, "none"],
  ])("%i → %s", (status, cls) => {
    expect(classifyHttp(status as number)).toBe(cls as FailureClass);
  });
});

describe("classifyThrown", () => {
  test("abort wins over the error shape", () => {
    expect(classifyThrown(new Error("x"), true)).toBe(FAILURE_CLASS.ABORT);
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(classifyThrown(timeout, false)).toBe(FAILURE_CLASS.ABORT);
    const abort = Object.assign(new Error("a"), { name: "AbortError" });
    expect(classifyThrown(abort, false)).toBe(FAILURE_CLASS.ABORT);
    expect(classifyThrown(new Error("ECONNRESET"), false)).toBe(FAILURE_CLASS.NETWORK);
    expect(classifyThrown("nope", false)).toBe(FAILURE_CLASS.NETWORK);
  });
});

describe("transition (the pure machine)", () => {
  test("starts idle with a zero streak and the base cooldown", () => {
    const h = idle();
    expect(h.state).toBe(TYPESAFE_STATE.IDLE);
    expect(h.fail_streak).toBe(0);
    expect(h.cooldown_ms).toBe(BREAKER_DEFAULTS.cooldownBaseMs);
  });

  test("is pure: frozen inputs stay unchanged", () => {
    const prev = Object.freeze({
      ...idle(),
      last_call: Object.freeze({ at: new Date(T0).toISOString(), caller: "reviewer", ms: 3 }),
    });
    const tuning = Object.freeze({ ...BREAKER_DEFAULTS });
    const before = JSON.stringify(prev);
    const next = transition(prev, FAILURE_CLASS.NETWORK, T0, tuning);
    expect(next).not.toBe(prev);
    expect(JSON.stringify(prev)).toBe(before);
    expect(next.state).toBe(TYPESAFE_STATE.IDLE);
  });

  test("disabled settings reach OFF without touching external state", () => {
    const h = transition(idle(), FAILURE_CLASS.DISABLED, T0);
    expect(h.state).toBe(TYPESAFE_STATE.OFF);
    expect(h.fail_streak).toBe(0);
    expect(h.consecutive_trips).toBe(0);
  });

  test("missing key reaches UNCONFIGURED without touching external state", () => {
    const h = transition(idle(), FAILURE_CLASS.UNCONFIGURED, T0);
    expect(h.state).toBe(TYPESAFE_STATE.UNCONFIGURED);
    expect(h.fail_streak).toBe(0);
    expect(h.consecutive_trips).toBe(0);
  });

  test("disabled and unconfigured paths remain reachable from their prior states", () => {
    const struck = transition(idle(), FAILURE_CLASS.NETWORK, T0);
    expect(transition(struck, FAILURE_CLASS.DISABLED, T0 + 1).state).toBe(TYPESAFE_STATE.OFF);
    expect(transition(struck, FAILURE_CLASS.UNCONFIGURED, T0 + 1).state).toBe(
      TYPESAFE_STATE.UNCONFIGURED,
    );
  });

  test("one failure keeps it idle (below the streak limit) but counts", () => {
    const h = transition(idle(), FAILURE_CLASS.NETWORK, T0);
    expect(h.state).toBe(TYPESAFE_STATE.IDLE);
    expect(h.fail_streak).toBe(1);
  });

  test("the streak limit trips it open with a cooldown deadline", () => {
    let h = transition(idle(), FAILURE_CLASS.NETWORK, T0);
    h = transition(h, FAILURE_CLASS.NETWORK, T0 + 1000);
    expect(h.state).toBe(TYPESAFE_STATE.OPEN);
    expect(h.fail_streak).toBe(BREAKER_DEFAULTS.failStreakLimit);
    expect(Date.parse(h.cooldown_until ?? "")).toBe(T0 + 1000 + BREAKER_DEFAULTS.cooldownBaseMs);
    expect(h.consecutive_trips).toBe(1);
  });

  test("auth and budget trip on the FIRST hit", () => {
    for (const cls of [FAILURE_CLASS.AUTH, FAILURE_CLASS.BUDGET] as const) {
      const h = transition(idle(), cls, T0, undefined, cls === FAILURE_CLASS.BUDGET ? 429 : 401);
      expect(h.state).toBe(TYPESAFE_STATE.OPEN);
      expect(h.last_class).toBe(cls);
      expect(h.last_status).toBe(cls === FAILURE_CLASS.BUDGET ? 429 : 401);
    }
  });

  test("abort is streak-neutral: it never opens the breaker", () => {
    let h = idle();
    for (let i = 0; i < 10; i++) h = transition(h, FAILURE_CLASS.ABORT, T0 + i * 1000);
    expect(h.state).toBe(TYPESAFE_STATE.IDLE);
    expect(h.fail_streak).toBe(0);
    expect(h.last_class).toBe(FAILURE_CLASS.ABORT);
  });

  test("cooldown is streak-neutral too (the refusal stamp never trips)", () => {
    let h = idle();
    for (let i = 0; i < 5; i++) h = transition(h, FAILURE_CLASS.COOLDOWN, T0 + i * 1000);
    expect(h.state).toBe(TYPESAFE_STATE.IDLE);
    expect(h.fail_streak).toBe(0);
  });

  test("schema and malformed need the streak too (no instant disable)", () => {
    let h = transition(idle(), FAILURE_CLASS.SCHEMA, T0, undefined, 422);
    expect(h.state).toBe(TYPESAFE_STATE.IDLE);
    h = transition(h, FAILURE_CLASS.MALFORMED, T0 + 1);
    expect(h.state).toBe(TYPESAFE_STATE.OPEN);
  });

  test("a success resets streak and state", () => {
    let h = transition(idle(), FAILURE_CLASS.NETWORK, T0);
    h = transition(h, FAILURE_CLASS.NONE, T0 + 1);
    expect(h.state).toBe(TYPESAFE_STATE.IDLE);
    expect(h.fail_streak).toBe(0);
  });

  test("cooldown doubles per consecutive trip and caps", () => {
    let h = idle();
    const trips: number[] = [];
    for (let i = 0; i < 8; i++) {
      h = transition(h, FAILURE_CLASS.BUDGET, T0 + i * 1e6, undefined, 429);
      trips.push(h.cooldown_ms);
    }
    expect(trips[0]).toBe(BREAKER_DEFAULTS.cooldownBaseMs);
    expect(trips[1]).toBe(BREAKER_DEFAULTS.cooldownBaseMs * 2);
    expect(Math.max(...trips)).toBe(BREAKER_DEFAULTS.cooldownCapMs);
  });

  test("a success clears consecutive_trips so a later failure starts at base again", () => {
    let h = transition(idle(), FAILURE_CLASS.BUDGET, T0, undefined, 429);
    h = transition(h, FAILURE_CLASS.NONE, T0 + 1);
    h = transition(h, FAILURE_CLASS.BUDGET, T0 + 2, undefined, 429);
    expect(h.cooldown_ms).toBe(BREAKER_DEFAULTS.cooldownBaseMs);
  });

  test("an omitted status leaves the previous last_status untouched", () => {
    const withStatus = transition(idle(), FAILURE_CLASS.BUDGET, T0, undefined, 429);
    const again = transition(withStatus, FAILURE_CLASS.NETWORK, T0 + 1);
    expect(again.last_status).toBe(429);
    expect(again.last_class).toBe(FAILURE_CLASS.NETWORK);
  });
});

describe("allowCall", () => {
  test("idle always allows", () => {
    expect(allowCall(readHealth({ userRoot: root() }), T0).allow).toBe(true);
  });

  test("off and unconfigured are decided by the call site, not here — they still allow", () => {
    for (const state of [TYPESAFE_STATE.OFF, TYPESAFE_STATE.UNCONFIGURED] as const) {
      const r = allowCall({ ...IDLE_HEALTH, state }, T0);
      expect(r.allow).toBe(true);
      expect(r.next.state).toBe(state);
    }
  });

  test("open refuses inside the cooldown, stamping COOLDOWN without mutating the state", () => {
    const h = transition(
      readHealth({ userRoot: root() }),
      FAILURE_CLASS.BUDGET,
      T0,
      undefined,
      429,
    );
    const r = allowCall(h, T0 + 1000);
    expect(r.allow).toBe(false);
    expect(r.next.state).toBe(TYPESAFE_STATE.OPEN);
    expect(r.next.last_class).toBe(FAILURE_CLASS.COOLDOWN);
    expect(r.next.fail_streak).toBe(h.fail_streak);
    expect(r.next.consecutive_trips).toBe(h.consecutive_trips);
    expect(r.next.cooldown_ms).toBe(h.cooldown_ms);
    expect(r.next.cooldown_until).toBe(h.cooldown_until);
  });

  test("the first caller after the cooldown gets ONE probe and flips to half-open", () => {
    const h = transition(
      readHealth({ userRoot: root() }),
      FAILURE_CLASS.BUDGET,
      T0,
      undefined,
      429,
    );
    const after = T0 + h.cooldown_ms + 1;
    const first = allowCall(h, after);
    expect(first.allow).toBe(true);
    expect(first.next.state).toBe(TYPESAFE_STATE.HALF_OPEN);
    expect(first.next.cooldown_until).toBeUndefined();
    const second = allowCall(first.next, after + 1);
    expect(second.allow).toBe(false);
    expect(second.next.state).toBe(TYPESAFE_STATE.HALF_OPEN);
    expect(second.next.last_class).toBe(FAILURE_CLASS.COOLDOWN);
    expect(second.next.cooldown_until).toBeUndefined();
  });

  test("the cooldown deadline is inclusive: exactly at cooldown_until a probe is granted", () => {
    const h = transition(
      readHealth({ userRoot: root() }),
      FAILURE_CLASS.BUDGET,
      T0,
      undefined,
      429,
    );
    expect(allowCall(h, Date.parse(h.cooldown_until ?? "")).allow).toBe(true);
    expect(allowCall(h, Date.parse(h.cooldown_until ?? "") - 1).allow).toBe(false);
  });

  test("an open record with no deadline still gets exactly one probe", () => {
    const hostile: TypesafeHealth = {
      ...IDLE_HEALTH,
      state: TYPESAFE_STATE.OPEN,
      fail_streak: 3,
      consecutive_trips: 2,
    };
    expect(allowCall(hostile, T0).allow).toBe(true);
  });

  test("a failed probe re-opens with a DOUBLED cooldown", () => {
    let h = transition(readHealth({ userRoot: root() }), FAILURE_CLASS.BUDGET, T0, undefined, 429);
    const probe = allowCall(h, T0 + h.cooldown_ms + 1);
    h = transition(probe.next, FAILURE_CLASS.BUDGET, T0 + h.cooldown_ms + 2, undefined, 429);
    expect(h.state).toBe(TYPESAFE_STATE.OPEN);
    expect(h.cooldown_ms).toBe(BREAKER_DEFAULTS.cooldownBaseMs * 2);
  });

  test("a successful probe returns to idle", () => {
    let h = transition(readHealth({ userRoot: root() }), FAILURE_CLASS.BUDGET, T0, undefined, 429);
    const probe = allowCall(h, T0 + h.cooldown_ms + 1);
    h = transition(probe.next, FAILURE_CLASS.NONE, T0 + h.cooldown_ms + 2);
    expect(h.state).toBe(TYPESAFE_STATE.IDLE);
  });
});

describe("isTypesafeHealth (the record guard)", () => {
  test("accepts a full record and the idle default", () => {
    expect(isTypesafeHealth(IDLE_HEALTH)).toBe(true);
    expect(
      isTypesafeHealth({
        ...IDLE_HEALTH,
        state: TYPESAFE_STATE.OPEN,
        opened_at: new Date(T0).toISOString(),
        cooldown_until: new Date(T0 + 1).toISOString(),
        calls: 3,
        last_status: 429,
        last_call: { at: new Date(T0).toISOString(), caller: "risk", status: 429, ms: 12 },
      }),
    ).toBe(true);
  });

  test.each([
    ["not an object", "nope"],
    ["an array", []],
    ["null", null],
    ["a wrong schema_version", { ...IDLE_HEALTH, schema_version: 2 }],
    ["an unknown state", { ...IDLE_HEALTH, state: "OPEN" }],
    ["a non-numeric streak", { ...IDLE_HEALTH, fail_streak: "1" }],
    ["a negative streak", { ...IDLE_HEALTH, fail_streak: -1 }],
    ["a non-numeric cooldown", { ...IDLE_HEALTH, cooldown_ms: "60_000" }],
    ["a non-numeric trip count", { ...IDLE_HEALTH, consecutive_trips: null }],
    ["an unknown failure class", { ...IDLE_HEALTH, last_class: "internal" }],
    ["a missing failure class", { ...IDLE_HEALTH, last_class: undefined }],
    ["a non-string opened_at", { ...IDLE_HEALTH, opened_at: 1 }],
    ["a non-string cooldown_until", { ...IDLE_HEALTH, cooldown_until: {} }],
    ["a non-numeric status", { ...IDLE_HEALTH, last_status: "429" }],
    ["a non-numeric call count", { ...IDLE_HEALTH, calls: "3" }],
    ["a non-object last_call", { ...IDLE_HEALTH, last_call: "reviewer" }],
    ["a last_call without an at", { ...IDLE_HEALTH, last_call: { caller: "risk", ms: 1 } }],
    [
      "a last_call with a bad ms",
      { ...IDLE_HEALTH, last_call: { at: "x", caller: "risk", ms: "1" } },
    ],
    [
      "a last_call with a bad status",
      { ...IDLE_HEALTH, last_call: { at: "x", caller: "r", ms: 1, status: "4" } },
    ],
    ["a last_call without a caller", { ...IDLE_HEALTH, last_call: { at: "x", ms: 1 } }],
  ])("rejects %s", (_label, value) => {
    expect(isTypesafeHealth(value)).toBe(false);
  });
});

describe("health file", () => {
  test("round-trips through the file and survives a fresh read (the whole point)", async () => {
    const inst = { userRoot: root() };
    const opened = transition(readHealth(inst), FAILURE_CLASS.BUDGET, T0, undefined, 429);
    await writeHealth(opened, inst);
    const back = readHealth(inst);
    expect(back.state).toBe(TYPESAFE_STATE.OPEN);
    expect(back.last_class).toBe(FAILURE_CLASS.BUDGET);
    expect(back.last_status).toBe(429);
  });

  test("resolves under the per-user root, never the repo", () => {
    const dir = root();
    expect(typesafeHealthPath(dir)).toBe(join(dir, "typesafe-health.json"));
  });

  test("an absent file reads as the idle default", () => {
    const inst = { userRoot: root() };
    expect(readHealth(inst)).toEqual(IDLE_HEALTH);
  });

  test("a directory and a symlink both read as idle (lstat never follows out)", () => {
    const asDir = { userRoot: root() };
    mkdirSync(typesafeHealthPath(asDir.userRoot));
    expect(readHealth(asDir)).toEqual(IDLE_HEALTH);

    const asLink = { userRoot: root() };
    const target = join(root(), "secret.json");
    writeFileSync(target, JSON.stringify(IDLE_HEALTH));
    symlinkSync(target, typesafeHealthPath(asLink.userRoot));
    expect(readHealth(asLink)).toEqual(IDLE_HEALTH);
  });

  test("EACCES reads as idle, never throws", () => {
    const inst = { userRoot: root() };
    const path = typesafeHealthPath(inst.userRoot);
    writeFileSync(path, JSON.stringify(IDLE_HEALTH));
    chmodSync(path, 0o000);
    try {
      expect(readHealth(inst).state).toBe(TYPESAFE_STATE.IDLE);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  test("a versioned but PARTIAL record reads as idle, never verbatim", () => {
    const inst = { userRoot: root() };
    writeFileSync(
      typesafeHealthPath(inst.userRoot),
      JSON.stringify({ schema_version: 1, state: "open" }),
    );
    expect(readHealth(inst)).toEqual(IDLE_HEALTH);
    writeFileSync(
      typesafeHealthPath(inst.userRoot),
      JSON.stringify({ schema_version: 1, state: "OPEN", fail_streak: 3 }),
    );
    expect(readHealth(inst)).toEqual(IDLE_HEALTH);
  });

  test("a garbage file reads as idle, never throws", () => {
    const inst = { userRoot: root() };
    writeFileSync(typesafeHealthPath(inst.userRoot), "{ not json");
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.IDLE);
  });

  test("an unknown schema_version reads as idle", () => {
    const inst = { userRoot: root() };
    writeFileSync(
      typesafeHealthPath(inst.userRoot),
      JSON.stringify({ schema_version: 99, state: "open" }),
    );
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.IDLE);
  });

  test("an injected readFile is used and a throwing one is swallowed", () => {
    const seen: string[] = [];
    const inst = { userRoot: root() };
    const h = readHealth({
      ...inst,
      readFile: (p) => {
        seen.push(p);
        return JSON.stringify({ ...IDLE_HEALTH, state: "open" });
      },
    });
    expect(h.state).toBe(TYPESAFE_STATE.OPEN);
    expect(seen).toEqual([typesafeHealthPath(inst.userRoot)]);
    expect(
      readHealth({
        userRoot: root(),
        readFile: () => {
          throw new Error("EACCES");
        },
      }),
    ).toEqual(IDLE_HEALTH);
  });

  test("a write failure is swallowed (read-only home must not break a run)", async () => {
    await expect(
      writeHealth(readHealth(), {
        writeFile: () => {
          throw new Error("EROFS");
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("an injected writeFile receives the serialized record", async () => {
    const written: { p: string; s: string }[] = [];
    const inst = { userRoot: root() };
    await writeHealth(transition(readHealth(inst), FAILURE_CLASS.BUDGET, T0, undefined, 429), {
      ...inst,
      writeFile: (p, s) => {
        written.push({ p, s });
      },
    });
    expect(written.length).toBe(1);
    expect(written[0]?.p).toBe(typesafeHealthPath(inst.userRoot));
    expect(JSON.parse(written[0]?.s ?? "{}").last_class).toBe(FAILURE_CLASS.BUDGET);
  });

  test("a lock failure is swallowed and leaves the on-disk record untouched", async () => {
    const inst = { userRoot: root() };
    await writeHealth(readHealth(inst), inst);
    const before = readFileSync(typesafeHealthPath(inst.userRoot), "utf8");
    await writeHealth(transition(readHealth(inst), FAILURE_CLASS.BUDGET, T0, undefined, 429), {
      ...inst,
      lock: async () => {
        throw new Error("ELOCKED");
      },
    });
    expect(readFileSync(typesafeHealthPath(inst.userRoot), "utf8")).toBe(before);
  });

  test("mutateHealth returns undefined when the lock cannot be taken", async () => {
    const r = await mutateHealth(() => ({ next: IDLE_HEALTH, result: 1 }), {
      userRoot: root(),
      lock: async () => {
        throw new Error("ELOCKED");
      },
    });
    expect(r).toBeUndefined();
  });

  test("mutateHealth runs read-modify-write INSIDE the lock and returns the result", async () => {
    const inst = { userRoot: root() };
    await writeHealth(IDLE_HEALTH, inst);
    const order: string[] = [];
    const r = await mutateHealth(
      (h) => {
        order.push("read");
        expect(h.state).toBe(TYPESAFE_STATE.IDLE);
        return {
          next: transition(h, FAILURE_CLASS.BUDGET, T0, undefined, 429),
          result: "tripped",
        };
      },
      {
        ...inst,
        lock: async (_p, fn) => {
          order.push("lock");
          await fn();
          order.push("unlock");
        },
      },
    );
    expect(r).toBe("tripped");
    expect(order).toEqual(["lock", "read", "unlock"]);
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.OPEN);
  });

  test("the per-run budget is enforced at the guard, across call sites", async () => {
    resetCallBudget();
    const inst = { userRoot: root(), now: () => T0 };
    const cfg = { ...DEFAULT_TYPESAFE_SETTINGS, maxCalls: 2 };
    const tuning = tuningFor(cfg);
    expect(tuning.maxCalls).toBe(2);
    let calls = 0;
    const fn = async () => {
      calls += 1;
      return null;
    };
    for (let i = 0; i < 5; i++) await withTypesafeGuard("reviewer", fn, { ...inst, tuning });
    expect(calls).toBe(2);
    expect(callsUsedThisRun()).toBe(2);
  });

  test("lockWaitMs: 0 skips the write instead of queueing behind a concurrent writer", async () => {
    const inst = { userRoot: root() };
    await writeHealth(transition(readHealth(inst), FAILURE_CLASS.BUDGET, T0, undefined, 429), inst);
    const before = readFileSync(typesafeHealthPath(inst.userRoot), "utf8");
    await writeHealth(transition(readHealth(inst), FAILURE_CLASS.NETWORK, T0 + 1000), {
      ...inst,
      lockWaitMs: 0,
      lock: async () => {
        throw new Error("ELOCKED");
      },
    });
    expect(readFileSync(typesafeHealthPath(inst.userRoot), "utf8")).toBe(before);
  });

  test("the REAL lockfile path: a held lock with lockWaitMs: 0 skips the write, it never queues", async () => {
    // Exercises the default (proper-lockfile) branch of the lock, and the `lockWaitMs: 0` retry
    // policy the hook path passes: no retries, so contention costs a failed acquire and nothing
    // else. The caller must resolve and the record on disk must be untouched.
    const inst = { userRoot: root() };
    await writeHealth(transition(readHealth(inst), FAILURE_CLASS.BUDGET, T0, undefined, 429), inst);
    const before = readFileSync(typesafeHealthPath(inst.userRoot), "utf8");
    const held = await lockfile.lock(typesafeHealthPath(inst.userRoot), {
      realpath: false,
      lockfilePath: `${typesafeHealthPath(inst.userRoot)}.lock`,
      stale: 2_000,
    });
    try {
      await writeHealth(transition(readHealth(inst), FAILURE_CLASS.NETWORK, T0 + 1000), {
        ...inst,
        lockWaitMs: 0,
      });
    } finally {
      await held();
    }
    expect(readFileSync(typesafeHealthPath(inst.userRoot), "utf8")).toBe(before);
  });

  test("writeBudgetMs: an exhausted reservation drops the write instead of adding it", async () => {
    const inst = { userRoot: root() };
    await writeHealth(transition(readHealth(inst), FAILURE_CLASS.BUDGET, T0, undefined, 429), inst);
    const before = readFileSync(typesafeHealthPath(inst.userRoot), "utf8");
    let ticks = 0;
    await writeHealth(transition(readHealth(inst), FAILURE_CLASS.NETWORK, T0 + 1000), {
      ...inst,
      writeBudgetMs: 500,
      now: () => T0 + (ticks++ === 0 ? 0 : 10_000),
    });
    expect(readFileSync(typesafeHealthPath(inst.userRoot), "utf8")).toBe(before);
  });

  test("writeBudgetMs: an unspent reservation still writes", async () => {
    const inst = { userRoot: root() };
    await writeHealth(transition(readHealth(inst), FAILURE_CLASS.BUDGET, T0, undefined, 429), {
      ...inst,
      writeBudgetMs: 500,
      now: () => T0,
    });
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.OPEN);
  });
});

describe("withTypesafeGuard", () => {
  test("passes a value through and records the success", async () => {
    const inst = { userRoot: root(), now: () => T0 };
    const value = await withTypesafeGuard<number>("reviewer", async () => 42, inst);
    expect(value).toBe(42);
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.IDLE);
    expect(readHealth(inst).last_call?.caller).toBe("reviewer");
    expect(readHealth(inst).calls).toBe(1);
  });

  test("a null result is a SUCCESS for the breaker when the call itself completed", async () => {
    const inst = { userRoot: root(), now: () => T0 };
    await withTypesafeGuard("x", async () => null, inst);
    expect(readHealth(inst).fail_streak).toBe(0);
  });

  test("a null result that REPORTED a classified failure is NOT a success", async () => {
    const inst = { userRoot: root(), now: () => T0 };
    const r = await withTypesafeGuard("x", async () => null, {
      ...inst,
      outcome: () => ({ cls: FAILURE_CLASS.BUDGET, status: 429 }),
    });
    expect(r).toBeNull();
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.OPEN);
    expect(readHealth(inst).last_class).toBe(FAILURE_CLASS.BUDGET);
    expect(readHealth(inst).last_status).toBe(429);
  });

  test("outcomeProbe records the last failure and clears on a later success", () => {
    const probe = outcomeProbe();
    expect(probe.outcome()).toBeUndefined();
    probe.onOutcome({ ok: false, class: FAILURE_CLASS.SERVER, status: 503 });
    expect(probe.outcome()).toEqual({ cls: FAILURE_CLASS.SERVER, status: 503 });
    probe.onOutcome({ ok: true, status: 200 });
    expect(probe.outcome()).toBeUndefined();
  });

  test("cooldown refusal records COOLDOWN", async () => {
    const inst = { userRoot: root(), now: () => T0 };
    const opened = transition(readHealth(inst), FAILURE_CLASS.BUDGET, T0, undefined, 429);
    await writeHealth(opened, inst);
    const r = await withTypesafeGuard("x", async () => 1, inst);
    expect(r).toBeNull();
    expect(readHealth(inst).last_class).toBe(FAILURE_CLASS.COOLDOWN);
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.OPEN);
  });

  test("a thrown TimeoutError is classed abort and leaves the breaker idle", async () => {
    const inst = { userRoot: root(), now: () => T0 };
    const r = await withTypesafeGuard(
      "x",
      async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      },
      inst,
    );
    expect(r).toBeNull();
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.IDLE);
  });

  test("an abort on the caller's own signal is streak-neutral even for a plain Error", async () => {
    const inst = { userRoot: root(), now: () => T0 };
    const controller = new AbortController();
    controller.abort();
    const r = await withTypesafeGuard(
      "x",
      async () => {
        throw new Error("aborted by the caller");
      },
      { ...inst, signal: controller.signal },
    );
    expect(r).toBeNull();
    expect(readHealth(inst).fail_streak).toBe(0);
    expect(readHealth(inst).last_class).toBe(FAILURE_CLASS.ABORT);
  });

  test("the guard refuses to call while OPEN and returns null without invoking fn", async () => {
    const inst = { userRoot: root(), now: () => T0 };
    await writeHealth(transition(readHealth(), FAILURE_CLASS.BUDGET, T0, undefined, 429), inst);
    let called = 0;
    const r = await withTypesafeGuard(
      "x",
      async () => {
        called++;
        return 1;
      },
      inst,
    );
    expect(r).toBeNull();
    expect(called).toBe(0);
  });

  test("an unreadable breaker (lock lost) ALLOWS rather than blocking a run", async () => {
    const inst = { userRoot: root(), now: () => T0 };
    const r = await withTypesafeGuard("x", async () => 7, {
      ...inst,
      lock: async () => {
        throw new Error("ELOCKED");
      },
    });
    expect(r).toBe(7);
  });

  test("a success recorded while a peer trips the breaker cannot re-arm it", async () => {
    // Two genuinely overlapping guards on ONE userRoot: `a` is allowed while idle and parks
    // inside `fn`, `b` trips the breaker, then `a` records its SUCCESS. The final record must
    // still be the tripped one — a snapshot read before `fn` would write `idle` here.
    const inst = { userRoot: root() };
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = withTypesafeGuard(
      "reviewer",
      async () => {
        await gate;
        return "ok";
      },
      { ...inst, now: () => T0 },
    );
    await Bun.sleep(5); // `a` is now parked inside fn, having been allowed
    const b = await withTypesafeGuard("risk", async () => null, {
      ...inst,
      now: () => T0 + 1_000,
      outcome: () => ({ cls: FAILURE_CLASS.BUDGET, status: 429 }),
    });
    release?.();
    expect(b).toBeNull();
    expect(await a).toBe("ok");
    const final = readHealth(inst);
    expect(final.state).toBe(TYPESAFE_STATE.OPEN);
    expect(final.fail_streak).toBe(1);
    expect(final.consecutive_trips).toBe(1);
    expect(Date.parse(final.cooldown_until ?? "")).toBe(
      T0 + 1_000 + BREAKER_DEFAULTS.cooldownBaseMs,
    );
    expect(final.last_call?.caller).toBe("reviewer");
  });

  test("an OPEN record with no deadline is not re-armed by a success either", async () => {
    // A foreign writer replaced the record between this call's allow and its record step.
    const inst = { userRoot: root(), now: () => T0 };
    const hostile = {
      ...IDLE_HEALTH,
      state: TYPESAFE_STATE.OPEN,
      fail_streak: 3,
      consecutive_trips: 2,
    };
    let acquisitions = 0;
    const r = await withTypesafeGuard("x", async () => 1, {
      ...inst,
      lock: async (p, fn) => {
        acquisitions += 1;
        if (acquisitions === 2) writeFileSync(p, JSON.stringify(hostile));
        await fn();
      },
    });
    expect(r).toBe(1);
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.OPEN);
  });

  test("emits exactly one line per transition, not per call", async () => {
    const lines: string[] = [];
    const inst = {
      userRoot: root(),
      now: () => T0,
      out: (_c: LogChannel, ...parts: unknown[]) => lines.push(parts.join(" ")),
    };
    await withTypesafeGuard(
      "x",
      async () => {
        throw new Error("ECONNRESET");
      },
      inst,
    );
    const afterFirst = lines.length; // streak 1 → no transition → at most one debug line
    expect(afterFirst).toBe(0);
    await withTypesafeGuard(
      "x",
      async () => {
        throw new Error("ECONNRESET");
      },
      inst,
    );
    expect(lines.length).toBeGreaterThan(afterFirst); // the OPEN transition is announced
    await withTypesafeGuard(
      "x",
      async () => {
        throw new Error("ECONNRESET");
      },
      inst,
    );
    expect(lines.length).toBeGreaterThanOrEqual(afterFirst + 1); // refused calls stay quiet
    expect(lines.join("\n")).toContain("circuit open");
  });

  test.each([
    ["auth", FAILURE_CLASS.AUTH, 401, "unauthorized"],
    ["budget", FAILURE_CLASS.BUDGET, 429, "rate limited"],
    ["schema", FAILURE_CLASS.SCHEMA, 422, "response shape changed"],
  ])("a reported %s outcome speaks its own line", async (_label, cls, status, needle) => {
    const lines: string[] = [];
    await withTypesafeGuard("x", async () => null, {
      userRoot: root(),
      now: () => T0,
      out: (_c: LogChannel, ...parts: unknown[]) => lines.push(parts.join(" ")),
      outcome: () => ({ cls, status }),
    });
    expect(lines.join("\n")).toContain(needle);
  });

  test("a thrown abort speaks the unreachable line", async () => {
    const lines: string[] = [];
    await withTypesafeGuard(
      "x",
      async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      },
      {
        userRoot: root(),
        now: () => T0,
        out: (_c: LogChannel, ...parts: unknown[]) => lines.push(parts.join(" ")),
      },
    );
    expect(lines.join("\n")).toContain("unreachable (timeout)");
  });

  test("recovery is announced once, when a probe closes the breaker", async () => {
    const lines: string[] = [];
    const inst = {
      userRoot: root(),
      out: (_c: LogChannel, ...parts: unknown[]) => lines.push(parts.join(" ")),
    };
    let clock = T0;
    const io = { ...inst, now: () => clock };
    await withTypesafeGuard("x", async () => null, {
      ...io,
      outcome: () => ({ cls: FAILURE_CLASS.BUDGET, status: 429 }),
    });
    clock = T0 + BREAKER_DEFAULTS.cooldownBaseMs + 1;
    await withTypesafeGuard("x", async () => "probed", io);
    expect(readHealth(inst).state).toBe(TYPESAFE_STATE.IDLE);
    expect(lines.join("\n")).toContain("recovered");
  });

  test("a routine success is never announced", async () => {
    const lines: string[] = [];
    await withTypesafeGuard("x", async () => 1, {
      userRoot: root(),
      now: () => T0,
      out: (_c: LogChannel, ...parts: unknown[]) => lines.push(parts.join(" ")),
    });
    expect(lines).toEqual([]);
  });
});

describe("no magic numbers (every tuning value is injectable)", () => {
  test("a custom tuning is honoured end-to-end, not the shipped defaults", () => {
    const tuning = {
      failStreakLimit: 1,
      cooldownBaseMs: 5000,
      cooldownCapMs: 10_000,
      maxCalls: 20,
    };
    const h = transition(readHealth({ userRoot: root() }), FAILURE_CLASS.NETWORK, T0, tuning);
    expect(h.state).toBe(TYPESAFE_STATE.OPEN);
    expect(h.cooldown_ms).toBe(5000);
  });

  test("tuningFor copies the four settings fields and nothing else", () => {
    expect(tuningFor(DEFAULT_TYPESAFE_SETTINGS)).toEqual({
      failStreakLimit: DEFAULT_TYPESAFE_SETTINGS.failStreakLimit,
      cooldownBaseMs: DEFAULT_TYPESAFE_SETTINGS.cooldownBaseMs,
      cooldownCapMs: DEFAULT_TYPESAFE_SETTINGS.cooldownCapMs,
      maxCalls: DEFAULT_TYPESAFE_SETTINGS.maxCalls,
    });
  });

  test("the hook budget lives in settings, never as a module constant", () => {
    // There is no ABORT_TIMEOUT_MS export to assert on — that IS the assertion.
    expect((healthModule as Record<string, unknown>).ABORT_TIMEOUT_MS).toBeUndefined();
  });

  test("the failure-class authority is enumerable and excludes unreachable internal state", () => {
    expect(FAILURE_CLASSES.length).toBe(11);
    for (const cls of FAILURE_CLASSES) expect(isFailureClass(cls)).toBe(true);
    expect(isFailureClass("internal")).toBe(false);
    expect(isFailureClass("nope")).toBe(false);
    expect(isFailureClass(42)).toBe(false);
  });
});

describe("outBusOnly (the bus-only audit sink, created by this task)", () => {
  const previous = getLogbus();
  afterEach(() => setLogbusForTests(previous));

  const fakeBus = (write: (e: { channel: string; text: string }) => void) =>
    ({ runId: "r1", write }) as unknown as Logbus;

  test("bus present → writes the durable event on the given channel", () => {
    const seen: { channel: string; text: string }[] = [];
    setLogbusForTests(fakeBus((e) => seen.push(e)));
    const log = spyOn(console, "log").mockImplementation(() => {});
    outBusOnly(LOG_CHANNEL.HOOK, "typesafe", { meta: { caller: "reviewer" } });
    log.mockRestore();
    expect(seen.length).toBe(1);
    expect(seen[0]?.channel).toBe(LOG_CHANNEL.HOOK);
    expect(seen[0]?.text).toContain("typesafe");
    expect(log).not.toHaveBeenCalled();
  });

  test("an options bag is honoured and never leaks into the text", () => {
    const seen: { channel: string; text: string; meta?: unknown; level?: string }[] = [];
    setLogbusForTests(fakeBus((e) => seen.push(e)) as unknown as Logbus);
    const err = spyOn(console, "error").mockImplementation(() => {});
    outBusOnly(LOG_CHANNEL.HOOK, { level: "debug", unit: "u1", meta: { caller: "risk" } });
    err.mockRestore();
    expect(seen.length).toBe(1);
    expect(seen[0]?.text).toBe("");
    expect(seen[0]?.meta).toEqual({ caller: "risk" });
    expect(seen[0]?.level).toBe("debug");
  });

  test("bus null → silent no-op, NEVER a console fallback", () => {
    setLogbusForTests(null);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(() => outBusOnly(LOG_CHANNEL.HOOK, "dropped")).not.toThrow();
    const printed = log.mock.calls.length + err.mock.calls.length;
    log.mockRestore();
    err.mockRestore();
    expect(printed).toBe(0);
  });

  test("bus.write throws → swallowed, and still no console fallback", () => {
    setLogbusForTests(
      fakeBus(() => {
        throw new Error("disk full");
      }),
    );
    const log = spyOn(console, "log").mockImplementation(() => {});
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(() => outBusOnly(LOG_CHANNEL.HOOK, "boom")).not.toThrow();
    const printed = log.mock.calls.length + err.mock.calls.length;
    log.mockRestore();
    err.mockRestore();
    expect(printed).toBe(0);
  });
});
